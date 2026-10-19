#!/usr/bin/env node
/**
 * build-offline-payload.js — 把「鲸师离线阅读器」打成**可分发的 payload**
 * ------------------------------------------------------------------
 * 产物（默认 `dist-offline/whale-reader/`）：
 *
 *     whale-reader/
 *       node.exe            ← 自带运行时（收件人机器上没有 Node）
 *       LICENSE-node.txt    ← Node 的 MIT 许可（可再分发要求）
 *       start.cmd           ← 双击：起管理台 + 开浏览器
 *       install.cmd         ← 双击：选目录 → 复制过去 → 建桌面/开始菜单快捷方式
 *       uninstall.cmd       ← 删快捷方式（安装目录与课程库都不动）
 *       app/                ← **就是骨架本身**（offline-bootstrap 的白名单）
 *         tools/offline-server.js  ← 管理台服务（`__dirname/..` = app/）
 *         assets/ starmap/ index.html … ← 看课要的东西（主题/字体/three/星图）
 *
 * ⚠️ **目录名与脚本名一律 ASCII**：实测（Node v25 · Windows）`fs.rmSync(recursive)`
 *    在**含中文的路径**上不可靠 —— ASCII 路径删得掉，中文路径删不掉、甚至原生崩溃
 *    （`0xC0000409`，`try/catch` 抓不到）。中文只留在**用户可见的快捷方式名**上
 *    （`鲸师课件.lnk`，是单个文件、不是递归删的对象）。
 *
 * 为什么 `app/` 就是骨架：离线端起服务用的是 `app/tools/offline-server.js`，
 * 它的静态根与骨架源都按 `__dirname/..` 算 —— 于是"打包"这件事**不需要第二份清单**，
 * 直接复用 `offline-bootstrap.js` 的 `planSkeleton()`（同一份白名单，不会漂）。
 *
 * 课程库落在 `%LOCALAPPDATA%\鲸师课件\packs`（与安装位置无关 ⇒ 换安装目录不丢课件）。
 *
 * 用法：node tools/build-offline-payload.js [--out=<目录>] --node=<node 可执行文件> --manifest=<manifest.json>
 *       node tools/build-offline-payload.js [--out=<目录>] --no-node            # **开发产物**，不得发布
 *       node tools/build-offline-payload.js --plan                 # 只打印发布计划（一行 JSON），不写盘
 *       node tools/build-offline-payload.js --confirm --plan-digest=<digest>   # 核同一份计划后写
 *   `--no-node` 只打"引擎 + 骨架"（≈8 MB，用于快速对拍）——它产出的是 **DEV 开发产物**：
 *   receipt 记 `mode=dev / verified=false`，stdout 明确写「不得发布」（T28 / 报告 G03）。
 *   **正式构建（默认带 node）必须给 `--node` 与 `--manifest`**：先跑
 *   `distribution-license.cjs#verifyDistributionMaterials` 核「版本 + sha256 + 许可件」，
 *   有一条对不上就 exit 1、**一个字节都不写**（不再"警告后继续产出"）+ 把许可正文聚合进
 *   payload 根的**固定名** `LICENSES.txt`（T28-A2：不许拷动态 basename，否则产物集合与
 *   `plan.files` 必然两张皮）。
 *   `--include-progress` **必须显式**：默认把进度中性化（learned/pendingQ/flag → 空，
 *   practice achieved/needsReview → 0、每题 todo）。不给就是"净化的"那份。
 *
 * T20 / 报告 D05：`app/` 的清单与"该排谁"由 `tools/publish-policy.cjs` 说了算
 * （原先直接复用 `planSkeleton()`，而它把 questions/notes/learning-records 的**内容**
 * 也收进清单 ⇒ payload 带着作者的全本私人台账）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');   // 管理页来源回执的 SHA-256（T07）
const DIST = require('./distribution-license.cjs');   // 分发材料硬校验（T28）

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const outArg = argv.find((a) => a.startsWith('--out='));
const nodeArg = argv.find((a) => a.startsWith('--node='));
const manifestArg = argv.find((a) => a.startsWith('--manifest='));
const OUT_ROOT = outArg ? path.resolve(outArg.slice(6)) : path.join(ROOT, 'dist-offline');
const PKG_NAME = 'whale-reader';                 // ⚠️ ASCII（见文件头）
const PKG = path.join(OUT_ROOT, PKG_NAME);
const noNode = argv.includes('--no-node');
const NODE_PATH = nodeArg ? path.resolve(nodeArg.slice('--node='.length)) : null;
const MANIFEST_PATH = manifestArg ? path.resolve(manifestArg.slice('--manifest='.length)) : null;

/** 正式构建时由 `verifyDistributionMaterials` 核过的材料（dev 构建时是 null） */
let MATERIALS = null;
/** payload 根回执的文件名（`publish-policy.cjs#READER_GENERATED` 逐字登记了这个名字） */
const RECEIPT_NAME = 'distribution-receipt.json';
/** 许可**聚合件**的固定名（T28-A2：唯一固定名，才可能预先登记；不拷动态 basename） */
const LICENSES_NAME = 'LICENSES.txt';

/** ⚠️ 以下两件是**历史接口**（保留导出：老调用方与既有对拍还在 import 它们）。
 *  **正式构建路径一律不走它们**（T28 / 报告 G03）：运行时与许可只认 `--node` 与 `--manifest`
 *  核过的那一份 —— 拿 `process.execPath` 打包 = "自己证明自己"，材料缺口会被这层兜底吃掉。 */
function nodeExePath() {
  return process.execPath;
}
function nodeLicensePath() {
  // ① 课程包自带的那份（**随包携带** —— 本机实测：Node 官方安装器不在安装目录里放 LICENSE 文件）
  const bundled = path.join(ROOT, 'tools', 'node-license.txt');
  if (fs.existsSync(bundled)) return bundled;
  // ② 退而求其次：Node 安装目录里的（某些发行版会放）
  const dir = path.dirname(process.execPath);
  for (const n of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 正式构建前的硬闸（T28 / 报告 G03）：**材料对不上就不写任何产物**。
 *
 * 原先这里是"找不着许可就 `console.warn`，然后照样把 node.exe 打进 payload"，
 * 于是产物上根本看不出"少了许可"。现在：
 *   ① `verifyDistributionMaterials` 核 manifest / 许可件 sha256 / node 二进制的 sha256 与版本；
 *   ② 许可正文最后**聚合进固定名** `LICENSES.txt`（T28-A2），不再拷动态 basename ——
 *      动态名字不可能预先登记，必然撞 `applyPublication` 的「产物全集 == plan.files」机械判据；
 *   ③ 若发布策略还登记着 `LICENSE-node.txt`（包根 `tools/` 下有那个名字时才登记），
 *      就与聚合件**重复**了 ⇒ 直接失败，让人把登记位清掉（A2：二者不重复）。
 * @returns {{ok:boolean, problems:string[]}}
 */
function checkMaterials(plan) {
  const problems = [];
  const r = DIST.verifyDistributionMaterials({ manifestPath: MANIFEST_PATH, nodePath: NODE_PATH, payloadDir: null });
  problems.push(...r.problems);
  if (!r.ok) return { ok: false, problems };

  if (plan.files.includes('LICENSE-node.txt')) {
    problems.push('发布策略登记了 LICENSE-node.txt（包根 tools/ 下有这个名字），而正式构建只写聚合件 LICENSES.txt —— '
      + '二者不重复（T28-A2）：删掉包根那一份，或改发布策略的登记口径');
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  MATERIALS = {
    manifestPath: MANIFEST_PATH,
    manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(MANIFEST_PATH)).digest('hex'),
    nodePath: NODE_PATH,
    items: items.map((it) => ({
      name: it.name,
      version: it.version,
      sha256: it.sha256,
      licenseFiles: Array.isArray(it.licenseFiles) ? it.licenseFiles.slice() : [],
    })),
  };
  return { ok: problems.length === 0, problems };
}

/**
 * 许可聚合件的正文（T28-A2 §判据）：每个 item 一节，节头逐字
 * `=== <name> <version> sha256:<sha256> ===`，其后是该 item `licenseFiles` 的原文（UTF-8），
 * 节间空行分隔。**不做任何改写**：许可正文照抄，节头只是"这是谁、哪个版本、哪个 hash"。
 */
function aggregateLicenses(materials) {
  const manifestDir = path.dirname(materials.manifestPath);
  const sections = [];
  for (const item of materials.items) {
    const bodies = [];
    for (const name of item.licenseFiles) {
      const abs = path.join(manifestDir, name);
      if (!fs.existsSync(abs)) throw new Error(`聚合许可时找不到 ${name}（校验器为什么没拦住？）`);
      bodies.push(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, ''));
    }
    sections.push(`=== ${item.name} ${item.version} sha256:${item.sha256} ===\n${bodies.join('\n\n')}`);
  }
  return `${sections.join('\n\n')}\n`;
}

const bytes = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/* ── 脚本（payload 专用，不进 app/）────────────────────────────────────── */

const START_CMD = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动鲸师离线阅读器…
start "" "%~dp0node.exe" "%~dp0app\\tools\\offline-server.js" 3091
timeout /t 2 >nul
start "" "http://127.0.0.1:3091/"
echo 浏览器已经打开；这个窗口可以关掉（服务在后台跑）。
echo 以后想再打开，双击快捷方式「鲸师课件」，或这个 start.cmd。
timeout /t 5 >nul
`;

const INSTALL_CMD = `@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Payload "%~dp0"
`;

const UNINSTALL_CMD = `@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" -Here "%~dp0"
`;

const INSTALL_PS1 = `<#
  install.ps1 — 把「鲸师离线阅读器」装到用户选的目录，并建桌面/开始菜单快捷方式。
  · 由 install.cmd 调用（-Payload 指向 payload 根）
  · 快捷方式指向安装目录里的 start.cmd，图标取 app\\assets\\starmap.ico
  · **课程库不在安装目录里**（在 %LOCALAPPDATA%\\鲸师课件\\packs）⇒ 换目录不丢课件
  · ⚠️ 目标目录名用中文（用户可见）—— 所以**卸载脚本只删快捷方式、不递归删目录**
    （Node/PowerShell 在中文路径上的递归删除在本机实测不可靠，见 build-offline-payload.js 头注）
#>
param([Parameter(Mandatory=$true)][string]$Payload)

$ErrorActionPreference = 'Stop'
$Payload = (Resolve-Path $Payload).Path

Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '把「鲸师离线阅读器」装到哪个文件夹？'
$dlg.ShowNewFolderButton = $true
if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
  Write-Host '已取消安装。'; exit 1
}
$dest = Join-Path $dlg.SelectedPath '鲸师离线阅读器'
Write-Host "安装到：$dest"

# 复制 payload（安装脚本自己不用复制过去）
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Get-ChildItem -LiteralPath $Payload -Force |
  Where-Object { $_.Name -notin @('install.ps1', 'uninstall.ps1', 'install.cmd', 'uninstall.cmd') } |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force }

# 快捷方式：桌面 ＋ 开始菜单
$shell = New-Object -ComObject WScript.Shell
$icon = Join-Path $dest 'app\\assets\\starmap.ico'
$target = Join-Path $dest 'start.cmd'
$links = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) '鲸师课件.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) '鲸师课件.lnk')
)
foreach ($lnk in $links) {
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = $target
  $sc.WorkingDirectory = $dest
  if (Test-Path $icon) { $sc.IconLocation = $icon }
  $sc.Description = '打开鲸师课件（离线阅读器）'
  $sc.Save()
  if (-not (Test-Path $lnk)) { throw "快捷方式没建出来：$lnk" }   # 生成后读回核对
  Write-Host "  快捷方式：$lnk"
}

Write-Host ''
Write-Host '装好了。桌面（和开始菜单）上的「鲸师课件」双击即可。'
Write-Host "想卸载：双击 $dest\\uninstall.cmd"
`;

const UNINSTALL_PS1 = `<#
  uninstall.ps1 — 删快捷方式。**安装目录与课程库都不动**（都不许递归删：中文路径上不可靠）。
#>
param([Parameter(Mandatory=$true)][string]$Here)
$ErrorActionPreference = 'Stop'
$Here = (Resolve-Path $Here).Path

foreach ($lnk in @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) '鲸师课件.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) '鲸师课件.lnk')
)) {
  if (Test-Path $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Host "已删快捷方式：$lnk" }
}
Write-Host "安装目录：$Here"
Write-Host '（这个脚本不删自己所在的那个目录 —— 请手工删掉它。）'
Write-Host '你的课件在 %LOCALAPPDATA%\\鲸师课件 里，不受影响。'
`;

/* ── 打包 ──────────────────────────────────────────────────────────────────
   T20 / 报告 D05：`app/` 不再是"把骨架清单照抄一遍"，而是**发布策略**说了算 ——
   私人台账（questions / notes / learning-records / code）、进度载体（progress.json /
   starmap/content.js / assets/practice-data.js）与私人派生页（reference/NOTES.html）由
   `tools/publish-policy.cjs` 在**临时副本**里清空 / 中性化 / 重建之后才拷进来。
   清单与"该排谁"都只有那一份（本文件不再自带任何私人面判断）。 */

const PUBLISH = require('./publish-policy.cjs');

/** 包装件的**名字**由策略登记（`plan.files` 才能字面等于产物文件全集）；
 *  内容仍住在这里 —— 策略不碰安装脚本。 */
function decorate(outDir) {
  let nodeBytes = 0;
  // ① node 运行时（T28：不再从 process.execPath 猜）＋ 许可**聚合件**
  if (!noNode) {
    fs.copyFileSync(MATERIALS.nodePath, path.join(outDir, 'node.exe'));
    nodeBytes = fs.statSync(path.join(outDir, 'node.exe')).size;
    fs.writeFileSync(path.join(outDir, LICENSES_NAME), aggregateLicenses(MATERIALS), 'utf8');
  } else {
    // 开发产物也要把这个**已登记的**固定名写出来（否则产物集合与 plan.files 两张皮）；
    // 内容如实自陈"没有接入材料"，不冒充任何许可正文。
    fs.writeFileSync(path.join(outDir, LICENSES_NAME), [
      '# DEV — 开发产物（未做再分发合规核验），不得发布。',
      '# 本 payload 由 --no-node 构建，没有接入任何运行期许可材料。',
      '# 正式构建会把 manifest 里每一项的许可正文按固定节头聚合到本文件。',
      '',
    ].join('\n'), 'utf8');
  }
  // ② 脚本
  fs.writeFileSync(path.join(outDir, 'start.cmd'), START_CMD);
  fs.writeFileSync(path.join(outDir, 'install.cmd'), INSTALL_CMD);
  fs.writeFileSync(path.join(outDir, 'uninstall.cmd'), UNINSTALL_CMD);
  // ⚠️ T28 / GBK 缺陷：`.ps1` 由 Windows PowerShell 5.1 按 ANSI/GBK 解码读取 ——
  //    UTF-8 **无 BOM** 时中文注释会把脚本切成语法错误（取证：audit-evidence/T05/out-of-scope-install-ps1-gbk.txt：
  //    install 4 错 / uninstall 1 错）。判据：首三字节必须是 EF BB BF（要么带 BOM、要么全 ASCII）。
  //    `.cmd` 不动（它由 cmd.exe 按 chcp 65001 处理，本来就是 ASCII）。
  fs.writeFileSync(path.join(outDir, 'install.ps1'), `\uFEFF${INSTALL_PS1}`, 'utf8');
  fs.writeFileSync(path.join(outDir, 'uninstall.ps1'), `\uFEFF${UNINSTALL_PS1}`, 'utf8');

  /* ③ 管理页的**来源回执**（T07 / 报告 D02）
     —— 管理台页面必须由**受信安装资源**提供，绝不读课程库自带的管理 HTML。
     骨架白名单（`offline-bootstrap.js` 的 `TOOLS_KEEP`）把 `offline-admin.html` 与
     `http-security.cjs` 一起铺进 `app/tools/`：离线端跑起来时，`tools/offline-server.js`
     的 `sendAdmin()` 读的就是**它自己目录**里那一份（= 安装目录里的受信件），
     而不是 `%LOCALAPPDATA%\鲸师课件\packs\library\tools\offline-admin.html`（库里可写的那份）。
     这份回执把"哪个来源"钉在产物里，评审看得见；判据 `T07-ADMIN-html-from-trusted-install-resource`。 */
  const adminRel = 'tools/offline-admin.html';
  const secRel = 'tools/http-security.cjs';
  const shaOf = (rel) => {
    const abs = path.join(outDir, 'app', rel);
    if (!fs.existsSync(abs)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  };
  const adminReceipt = {
    v: 1,
    _: '管理页来源回执（T07）：管理台页面由**受信安装资源**提供，不读课程库自带的管理 HTML',
    adminHtml: { rel: `app/${adminRel}`, source: '受信安装资源（本 payload 的 app/ 骨架）', sha256: shaOf(adminRel) },
    httpSecurity: { rel: `app/${secRel}`, sha256: shaOf(secRel) },
    libraryCopyIsNotUsed: 'packs/library/tools/offline-admin.html（库里可写的那一份）不参与管理页渲染',
  };
  fs.writeFileSync(path.join(outDir, 'admin-source.json'), `${JSON.stringify(adminReceipt, null, 2)}\n`, 'utf8');

  /* ④ 分发材料回执（T28 / 报告 G03）—— 安装器**只认**这一份。
     正式构建：`mode=public / verified=true` + manifest 字节的 sha256 + 每项 name/version/sha256；
     开发产物：`mode=dev / verified=false / items=[]`（如实自陈"没核验过"，别让下游误以为能发）。 */
  const distReceipt = noNode
    ? { schema: DIST.RECEIPT_SCHEMA, mode: 'dev', verified: false, items: [] }
    : {
      schema: DIST.RECEIPT_SCHEMA,
      mode: 'public',
      verified: true,
      manifestSha256: MATERIALS.manifestSha256,
      items: MATERIALS.items.map((it) => ({ name: it.name, version: it.version, sha256: it.sha256 })),
    };
  fs.writeFileSync(path.join(outDir, RECEIPT_NAME), `${JSON.stringify(distReceipt, null, 2)}\n`, 'utf8');
  return { nodeBytes };
}

function summarize(outDir, copied) {
  let total = 0;
  for (const rel of fs.readdirSync(outDir, { recursive: true })) {
    const p = path.join(outDir, String(rel));
    try { if (fs.statSync(p).isFile()) total += fs.statSync(p).size; } catch { /* 半路没了就算了 */ }
  }
  let appBytes = 0;
  for (const rel of fs.readdirSync(path.join(outDir, 'app'), { recursive: true })) {
    const p = path.join(outDir, 'app', String(rel));
    try { if (fs.statSync(p).isFile()) appBytes += fs.statSync(p).size; } catch { /* 同上 */ }
  }
  const nodeBytes = fs.existsSync(path.join(outDir, 'node.exe')) ? fs.statSync(path.join(outDir, 'node.exe')).size : 0;
  console.log(`✓ payload 就绪：${outDir}`);
  console.log(`  app/（引擎 ＋ 骨架，已净化）：${copied} 个文件 / ${bytes(appBytes)}`);
  console.log(`  node.exe：${noNode ? '（--no-node，未带）' : bytes(nodeBytes)}`);
  console.log(`  合计：${bytes(total)}`);
  console.log(`  启动：双击 ${path.join(outDir, 'start.cmd')}`);
  console.log(`  安装：双击 ${path.join(outDir, 'install.cmd')}（选目录 ＋ 建快捷方式）`);
  return { pkg: outDir, appBytes, nodeBytes, total, files: copied };
}

function usageError(msg) {
  console.error(`✗ ${msg}`);
  console.error('  用法：node tools/build-offline-payload.js [--out=<目录>] --node=<node 可执行文件> --manifest=<manifest.json>');
  console.error('        node tools/build-offline-payload.js [--out=<目录>] --no-node        # 开发产物，不得发布');
  console.error('        node tools/build-offline-payload.js --plan [--no-node]              # 只打印计划，不写盘');
  process.exit(1);
}

function main() {
  const includeProgress = argv.includes('--include-progress');
  const planOnly = argv.includes('--plan');
  const confirm = argv.includes('--confirm');
  const digestArg = argv.find((a) => a.startsWith('--plan-digest='));
  const withNode = !noNode;

  // ── ① 参数闸（T28）：正式构建必须带齐材料；`--no-node` 是开发产物，两者不许混 ──
  if (noNode && (nodeArg || manifestArg)) {
    usageError('--no-node（开发产物，未做再分发合规核验）不能与 --node / --manifest 同时给');
  }
  if (!planOnly && withNode && (!NODE_PATH || !MANIFEST_PATH)) {
    usageError('正式构建（默认带 node）必须给 --node=<node 可执行文件> 与 --manifest=<manifest.json>——不再从 process.execPath 猜');
  }

  const plan = PUBLISH.planPublication(ROOT, { kind: 'reader', includeProgress, withNode });

  // `--plan` 只算不写，**不要求材料**（T20 依赖这份计划能单独跑）
  if (planOnly) {
    process.stdout.write(JSON.stringify(plan) + '\n');
    return { plan, wrote: false };
  }

  // ── ② 材料硬闸：**写任何产物之前**先核；有一条不对就 exit 1，且一个字节都不落 ──
  if (withNode) {
    const m = checkMaterials(plan);
    if (!m.ok) {
      console.error(`✗ 分发材料不齐 —— 拒绝打包（${m.problems.length} 条问题，一个字节都没写）`);
      for (const p of m.problems) console.error(`  · ${p}`);
      process.exit(1);
    }
  }

  if (confirm && digestArg && digestArg.slice('--plan-digest='.length) !== plan.planDigest) {
    console.error(`✗ --plan-digest 与当下这份计划不符：给的是 ${digestArg.slice('--plan-digest='.length)}，现在是 ${plan.planDigest}`);
    console.error('  先跑 node tools/build-offline-payload.js --plan 拿当下那一个。一个字节都没写。');
    process.exit(2);
  }
  const r = PUBLISH.applyPublication(ROOT, plan, {
    confirm: true, outDir: PKG, decorate, withNode,
    verify: (dir) => { if (!fs.existsSync(path.join(dir, 'app', 'tools', 'offline-server.js'))) throw new Error('产物里缺 app/tools/offline-server.js —— 这个离线端起不来'); },
  });
  if (!r.ok) {
    console.error(`✗ 发布失败（${r.code}）：${r.error}`);
    process.exit(1);
  }
  console.log(`  净化：排掉 ${r.excluded.length} 项私人面 · 重建 ${r.derived.length} 件派生物（planDigest ${r.planDigest.slice(0, 12)}…）`);
  if (noNode) {
    console.log('DEV — 开发产物（未做再分发合规核验），不得发布');
    console.log(`  receipt：${RECEIPT_NAME} 记 mode=dev / verified=false；installer 会据此**拒绝**编译安装包`);
  } else {
    console.log(`  分发材料：已核验 ${MATERIALS.items.length} 项（manifest sha256 ${MATERIALS.manifestSha256.slice(0, 12)}…）· 许可件按 basename 落 payload 根`);
  }
  return { ...summarize(r.outDir, r.files.filter((f) => f.startsWith('app/')).length), planDigest: r.planDigest };
}

module.exports = { main, PKG_NAME, RECEIPT_NAME, nodeExePath, nodeLicensePath, START_CMD, INSTALL_PS1, UNINSTALL_PS1 };

if (require.main === module) main();

