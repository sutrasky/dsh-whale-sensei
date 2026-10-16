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
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ISS = path.join(__dirname, 'offline-installer.iss');
const PAYLOAD = path.join(ROOT, 'dist-offline', 'whale-reader');
const OUT_DIR = path.join(ROOT, 'dist-offline');

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
  const verArg = process.argv.slice(2).find((a) => a.startsWith('--ver='));
  const ver = verArg ? verArg.slice(6) : null;

  if (!fs.existsSync(PAYLOAD)) {
    console.error(`✗ 还没有 payload：${PAYLOAD}`);
    console.error('  先跑：node tools/build-offline-payload.js');
    process.exit(1);
  }
  const iscc = findIscc();
  if (!iscc) {
    console.error('✗ 找不到 Inno Setup 的编译器 ISCC.exe');
    console.error('  装法：winget install JRSoftware.InnoSetup（本机 winget 坏了就官网下载安装包）');
    console.error('  或者告诉我它在哪：$env:INNO_ISCC = "<路径>\\ISCC.exe"');
    process.exit(1);
  }

  const args = [ISS];
  if (ver) args.push(`/DAppVer=${ver}`);
  console.log(`用 ${iscc} 编译…`);
  const r = spawnSync(iscc, args, { cwd: ROOT, encoding: 'utf8' });
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

module.exports = { main, findIscc, ISS, PAYLOAD };

if (require.main === module) main();
