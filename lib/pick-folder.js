/**
 * pick-folder.js — 调用**操作系统原生的文件夹选择框**，拿回一个绝对路径
 * ------------------------------------------------------------------
 * 为什么必须走宿主侧：浏览器的 `window.showDirectoryPicker()` 只给一个**句柄**，
 * 出于隐私它**拿不到绝对路径**（这是规范刻意设计的）。而插件要的是能写进配置、
 * 能被 Node 读的**路径**。宿主与浏览器同机（127.0.0.1），所以由宿主起一个原生对话框。
 *
 * 实现要点（都是踩过的坑，别改）：
 *   · **结果走临时文件，不走管道**：受限沙箱下捕获子进程输出会 EPERM（本仓已实测），
 *     而且中文路径经管道回传容易被代码页弄成乱码 —— 写 UTF-8 文件两头都干净。
 *   · `stdio: 'ignore'`：对话框是 GUI 窗口，不需要控制台。
 *   · `-STA`：WinForms 对话框要求单线程单元；Windows PowerShell 5.1 默认就是 STA，显式写一遍防环境差异。
 *   · 脚本本体**只许 ASCII**（BOM-less .ps1 会被 PS 5.1 当 ANSI 读，非 ASCII 会乱码甚至炸解析）。
 *   · 给对话框挂一个最小化的 TopMost 宿主窗体：否则它可能弹在主窗口**背后**，
 *     用户以为"点了没反应"。
 *
 * 测试钩子：`opts.fake` 或环境变量 `WHALE_PICK_FOLDER_FAKE`（给路径即跳过弹窗）。
 *
 * 契约：pickFolder(opts) -> { ok, path?, canceled?, dialog?, error? }
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** 只在 Windows 上有原生实现（跨平台方案见文件尾注释） */
export function pickerSupported(platform = process.platform) {
  return platform === 'win32'
}

const PS_SCRIPT = `param([string] $Out, [string] $Title)
$ErrorActionPreference = 'Stop'
$result = @{ ok = $false; canceled = $true; dialog = 'FolderBrowserDialog'; path = '' }
try {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = $Title
    $dlg.ShowNewFolderButton = $true
    $dlg.RootFolder = [System.Environment+SpecialFolder]::MyComputer
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.WindowState = 'Minimized'
    $r = $dlg.ShowDialog($owner)
    if ($r -eq [System.Windows.Forms.DialogResult]::OK) {
        $result.ok = $true
        $result.canceled = $false
        $result.path = $dlg.SelectedPath
    }
} catch {
    $result.ok = $false
    $result.error = "$($_.Exception.Message)"
}
$json = $result | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
`

/**
 * 弹出原生文件夹选择框。
 * @param {{fake?: string, title?: string, timeoutMs?: number, platform?: string, psExe?: string}} [opts]
 */
export function pickFolder(opts = {}) {
  const fake = opts.fake ?? process.env.WHALE_PICK_FOLDER_FAKE
  if (fake) {
    return { ok: true, path: path.resolve(String(fake).trim()), canceled: false, dialog: 'fake' }
  }

  if (!pickerSupported(opts.platform)) {
    return {
      ok: false,
      error: `当前平台（${opts.platform ?? process.platform}）还没有原生目录选择器：请手工把 packRoot 写进配置或环境变量`,
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pick-'))
  const scriptPath = path.join(dir, 'pick.ps1')
  const outPath = path.join(dir, 'out.json')
  fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8')

  const exe = opts.psExe || 'powershell.exe'
  const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Out', outPath, '-Title', String(opts.title || '选择课程包目录（必须是空文件夹，或已经是课程包）')]

  let r
  try {
    r = spawnSync(exe, args, { stdio: 'ignore', timeout: opts.timeoutMs ?? 300000 })
  } catch (e) {
    cleanup(dir)
    return { ok: false, error: `起不了系统对话框：${e?.message ?? e}` }
  }
  if (r.error) {
    cleanup(dir)
    const timedOut = r.error.code === 'ETIMEDOUT'
    return { ok: false, canceled: timedOut, error: timedOut ? '选择超时（5 分钟内没有选）—— 再点一次即可' : `起不了系统对话框：${r.error.message}` }
  }

  let raw = ''
  try {
    raw = fs.readFileSync(outPath, 'utf8')
  } catch {
    cleanup(dir)
    return { ok: false, error: `对话框没有回结果（退出码 ${r.status}）—— 换个终端/会话再试` }
  }
  cleanup(dir)

  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `对话框结果不是合法 JSON：${e?.message ?? e}` }
  }
  if (!data.ok) {
    if (data.error) return { ok: false, error: `系统对话框报错：${data.error}` }
    return { ok: false, canceled: true, error: '已取消选择' }
  }
  return { ok: true, path: path.resolve(String(data.path)), canceled: false, dialog: data.dialog || 'FolderBrowserDialog' }
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不致命 */ }
}

/*
 * 跨平台备注（本轮不做，先记着）：
 *   · macOS：`osascript -e 'POSIX path of (choose folder with prompt "…")'`（结果经临时文件回传）
 *   · Linux ：`zenity --file-selection --directory` 或 `kdialog --getexistingdirectory`
 *   两者都能沿用「临时文件回传 + stdio:ignore」这条已验证的路子。
 */
