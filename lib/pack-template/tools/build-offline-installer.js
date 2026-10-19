#!/usr/bin/env node
/**
 * build-offline-installer.js — 调 Inno Setup 把 payload 编译成**单文件安装 exe**
 * ------------------------------------------------------------------
 * 前置：`node tools/build-offline-payload.js`（产出 `dist-offline/whale-reader/`）
 * 产物：`dist-offline/鲸师离线阅读器-<版本>.exe`
 *
 * 为什么找 ISCC 要费点劲：Inno Setup **允许装到任意目录**，
 * 所以这里按"环境变量 → 常见位置 → 注册表卸载项里的 InstallLocation"顺序找，
 * 找不到就**如实报**并给出装法（不静默跳过 —— 本仓纪律）。
 * ⚠️ 别在这里写死某台机器的安装路径（2026-09-27 删掉过一条）：随包文件里带盘符路径会被
 *    `test/alien-env.mjs` 的静态守卫判红，而且换台机器必然落空。自定义位置走 `$env:INNO_ISCC`。
 *
 * 用法：node tools/build-offline-installer.js [--ver=1.0.0]
 *       node tools/build-offline-installer.js [--ver=1.0.0] [--manifest=<path>] [--node=<path>]
 *
 * **编译前硬闸（T28 / 报告 G03）**：读 `dist-offline/whale-reader/distribution-receipt.json`——
 * 缺失 / 解析失败 / `mode !== 'public'` / `verified !== true` 一律 `✗ payload 不是核验过的正式产物` + exit 1，
 * **不会去调 ISCC**。给了 `--manifest`/`--node` 时再跑一遍 `distribution-license.cjs` 的校验器。
 * 理由：`--no-node` 那种开发产物、或"材料没核就打包"的 payload，一旦被编译成安装 exe，
 * 看上去和正式包**一模一样**——那正是"警告后继续产出"最贵的一种形态。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const DIST = require('./distribution-license.cjs');

const ROOT = path.resolve(__dirname, '..');
const ISS = path.join(__dirname, 'offline-installer.iss');
const PAYLOAD = path.join(ROOT, 'dist-offline', 'whale-reader');
const OUT_DIR = path.join(ROOT, 'dist-offline');
const RECEIPT_NAME = 'distribution-receipt.json';

/**
 * payload 是不是**核验过的正式产物**。
 * @returns {{ok:boolean, mode:string, reason:string|null, receipt:object|null}}
 */
function payloadReceipt() {
  const p = path.join(PAYLOAD, RECEIPT_NAME);
  if (!fs.existsSync(p)) return { ok: false, mode: '缺失', reason: `缺 ${RECEIPT_NAME}`, receipt: null };
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, mode: 'unreadable', reason: `解析失败：${e && e.message ? e.message : String(e)}`, receipt: null };
  }
  const mode = String((receipt && receipt.mode) || '（未写）');
  if (mode !== 'public') return { ok: false, mode, reason: `mode=${mode} 不是正式产物`, receipt };
  if (receipt.verified !== true) return { ok: false, mode, reason: `mode=${mode} 但 verified=${JSON.stringify(receipt.verified)}`, receipt };
  if (receipt.schema !== DIST.RECEIPT_SCHEMA) return { ok: false, mode, reason: `schema=${JSON.stringify(receipt.schema)} 不是 ${DIST.RECEIPT_SCHEMA}`, receipt };
  return { ok: true, mode, reason: null, receipt };
}

/** ISCC 在哪：环境变量 → 常见位置 → 注册表里的 InstallLocation */
function findIscc() {
  const cands = [
    process.env.INNO_ISCC,
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Inno Setup 7', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Inno Setup 7', 'ISCC.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 7', 'ISCC.exe'),
  ].filter(Boolean);
  for (const p of cands) if (fs.existsSync(p)) return p;

  // 注册表兜底（Inno 允许自定义安装位置）
  const ps = [
    "-NoProfile", "-Command",
    "$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');",
    "$h=Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Inno Setup*' } | Select-Object -First 1;",
    "if($h){ Join-Path $h.InstallLocation 'ISCC.exe' }",
  ].join(' ');
  const r = spawnSync('powershell', ps, { encoding: 'utf8' });
  const guess = (r.stdout || '').trim();
  if (guess && fs.existsSync(guess)) return guess;
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const verArg = args.find((a) => a.startsWith('--ver='));
  const manifestArg = args.find((a) => a.startsWith('--manifest='));
  const nodeArg = args.find((a) => a.startsWith('--node='));
  const ver = verArg ? verArg.slice(6) : null;

  if (!fs.existsSync(PAYLOAD)) {
    console.error(`✗ 还没有 payload：${PAYLOAD}`);
    console.error('  先跑：node tools/build-offline-payload.js --node=<…> --manifest=<…>');
    process.exit(1);
  }

  // ── T28 硬闸：payload 不是核验过的正式产物就**不编译**（ISCC 一次都不调）──
  const gate = payloadReceipt();
  if (!gate.ok) {
    console.error(`✗ payload 不是核验过的正式产物（mode=${gate.mode}）—— 拒绝编译安装包`);
    console.error(`  原因：${gate.reason}`);
    console.error('  正式包只能用 `node tools/build-offline-payload.js --node=<…> --manifest=<…>` 产出（receipt 记 mode=public / verified=true）。');
    console.error('  `--no-node` 的 DEV 开发产物不得发布。一个字节都没编译。');
    process.exit(1);
  }

  // 给了材料就再核一遍（防止"receipt 是旧的、材料已经变了"）
  if (manifestArg || nodeArg) {
    if (!manifestArg || !nodeArg) {
      console.error('✗ 复核材料必须同时给 --manifest=<path> 与 --node=<path>');
      process.exit(1);
    }
    const r = DIST.verifyDistributionMaterials({
      manifestPath: path.resolve(manifestArg.slice('--manifest='.length)),
      nodePath: path.resolve(nodeArg.slice('--node='.length)),
      payloadDir: PAYLOAD,
    });
    if (!r.ok) {
      console.error(`✗ payload 不是核验过的正式产物（mode=${gate.mode}）—— 拒绝编译安装包`);
      for (const p of r.problems) console.error(`  · ${p}`);
      process.exit(1);
    }
  }

  const iscc = findIscc();
  if (!iscc) {
    console.error('✗ 找不到 Inno Setup 的编译器 ISCC.exe');
    console.error('  装法：winget install JRSoftware.InnoSetup（本机 winget 坏了就官网下载安装包）');
    console.error('  或者告诉我它在哪：$env:INNO_ISCC = "<路径>\\ISCC.exe"');
    process.exit(1);
  }

  const isccArgs = [ISS];
  if (ver) isccArgs.push(`/DAppVer=${ver}`);
  console.log(`用 ${iscc} 编译…`);
  const r = spawnSync(iscc, isccArgs, { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) {
    console.error('✗ 编译失败：');
    console.error(out.trim().split('\n').slice(-25).join('\n'));
    process.exit(r.status ?? 1);
  }

  // Inno 的产物名由 .iss 的 OutputBaseFilename 决定；这里按名字找出来（别猜版本号）
  const exes = fs.readdirSync(OUT_DIR).filter((f) => /^鲸师离线阅读器-.*\.exe$/.test(f));
  if (!exes.length) {
    console.error('✗ 编译说成功了，但 dist-offline 里没找到安装 exe —— 去看 ISCC 的输出');
    console.error(out.trim().split('\n').slice(-15).join('\n'));
    process.exit(1);
  }
  const exe = path.join(OUT_DIR, exes.sort().pop());
  const mb = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
  console.log(`✓ 安装包：${exe}（${mb} MB）`);
  console.log('  双击它 → 选目录 → 装完桌面/开始菜单出现「鲸师课件」；卸载器随装自带。');
  return { exe, bytes: fs.statSync(exe).size };
}

module.exports = { main, findIscc, payloadReceipt, ISS, PAYLOAD, RECEIPT_NAME };

if (require.main === module) main();
