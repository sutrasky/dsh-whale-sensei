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
 * 用法：node tools/build-offline-payload.js [--out=<目录>] [--no-node]
 *   `--no-node` 只打"引擎 + 骨架"（≈8 MB，用于快速对拍；真分发要带 node）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');   // 管理页来源回执的 SHA-256（T07）
const { planSkeleton } = require('./offline-bootstrap.js');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const outArg = argv.find((a) => a.startsWith('--out='));
const OUT_ROOT = outArg ? path.resolve(outArg.slice(6)) : path.join(ROOT, 'dist-offline');
const PKG_NAME = 'whale-reader';                 // ⚠️ ASCII（见文件头）
const PKG = path.join(OUT_ROOT, PKG_NAME);
const noNode = argv.includes('--no-node');

/** node.exe 与它的许可：从**正在跑这个脚本**的那个 Node 取（保证版本与课程包脚本兼容） */
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

/* ── 打包 ────────────────────────────────────────────────────────────────── */

function main() {
  const { files } = planSkeleton(ROOT);
  if (!files.length) {
    console.error('骨架清单是空的 —— 这个目录还是课程包吗？');
    process.exit(1);
  }
  // ⚠️ 先 existsSync 再 rmSync：本机实测「对不存在的路径 rmSync」会原生崩溃
  if (fs.existsSync(PKG)) fs.rmSync(PKG, { recursive: true, force: true });
  fs.mkdirSync(path.join(PKG, 'app'), { recursive: true });

  // ① app/ = 骨架
  let appBytes = 0;
  let copied = 0;
  for (const rel of files) {
    const from = path.join(ROOT, rel);
    const to = path.join(PKG, 'app', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    appBytes += fs.statSync(to).size;
    copied++;
  }
  for (const d of ['questions', 'notes', 'learning-records', 'glossary']) {
    fs.mkdirSync(path.join(PKG, 'app', d), { recursive: true });
  }

  // ② node.exe + 许可
  let nodeBytes = 0;
  if (!noNode) {
    fs.copyFileSync(nodeExePath(), path.join(PKG, 'node.exe'));
    nodeBytes = fs.statSync(path.join(PKG, 'node.exe')).size;
    const lic = nodeLicensePath();
    if (lic) fs.copyFileSync(lic, path.join(PKG, 'LICENSE-node.txt'));
    else console.warn('⚠ 没找到 Node 的 LICENSE —— 分发前请手工补一份（MIT 要求随附）');
  }

  // ③ 脚本
  fs.writeFileSync(path.join(PKG, 'start.cmd'), START_CMD);
  fs.writeFileSync(path.join(PKG, 'install.cmd'), INSTALL_CMD);
  fs.writeFileSync(path.join(PKG, 'uninstall.cmd'), UNINSTALL_CMD);
  fs.writeFileSync(path.join(PKG, 'install.ps1'), INSTALL_PS1);
  fs.writeFileSync(path.join(PKG, 'uninstall.ps1'), UNINSTALL_PS1);

  /* ④ 管理页的**来源回执**（T07 / 报告 D02）
     —— 管理台页面必须由**受信安装资源**提供，绝不读课程库自带的管理 HTML。
     骨架白名单（`offline-bootstrap.js` 的 `TOOLS_KEEP`）把 `offline-admin.html` 与
     `http-security.cjs` 一起铺进 `app/tools/`：离线端跑起来时，`tools/offline-server.js`
     的 `sendAdmin()` 读的就是**它自己目录**里那一份（= 安装目录里的受信件），
     而不是 `%LOCALAPPDATA%\鲸师课件\packs\library\tools\offline-admin.html`（库里可写的那份）。
     这份回执把"哪个来源"钉在产物里，评审看得见；判据 `T07-ADMIN-html-from-trusted-install-resource`。 */
  const adminRel = 'tools/offline-admin.html';
  const secRel = 'tools/http-security.cjs';
  const shaOf = (rel) => {
    const abs = path.join(PKG, 'app', rel);
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
  fs.writeFileSync(path.join(PKG, 'admin-source.json'), `${JSON.stringify(adminReceipt, null, 2)}\n`, 'utf8');

  let total = 0;
  for (const rel of fs.readdirSync(PKG, { recursive: true })) {
    const p = path.join(PKG, String(rel));
    try { if (fs.statSync(p).isFile()) total += fs.statSync(p).size; } catch { /* 半路没了就算了 */ }
  }

  console.log(`✓ payload 就绪：${PKG}`);
  console.log(`  app/（引擎 ＋ 骨架）：${copied} 个文件 / ${bytes(appBytes)}`);
  console.log(`  node.exe：${noNode ? '（--no-node，未带）' : bytes(nodeBytes)}`);
  console.log(`  合计：${bytes(total)}`);
  console.log(`  启动：双击 ${path.join(PKG, 'start.cmd')}`);
  console.log(`  安装：双击 ${path.join(PKG, 'install.cmd')}（选目录 ＋ 建快捷方式）`);
  return { pkg: PKG, appBytes, nodeBytes, total, files: copied };
}

module.exports = { main, PKG_NAME, nodeExePath, nodeLicensePath, START_CMD, INSTALL_PS1, UNINSTALL_PS1 };

if (require.main === module) main();
