/**
 * mode.js — 主题状态机（纯函数）+ 令牌成对检查
 * ------------------------------------------------------------------
 * 起草：mimo（读现有 tools/*.js 的判法）；收口：主线程（接口 / 判据 / 对拍）。
 * 契约：`resolveMode({stored,systemDark}) -> {effective,colorScheme,darkThemeAttr,storageKey}` / `checkThemeBlocks(root) -> {findings}`
 *   · 规则照 assets/theme.test.js：**偏好优先，没有偏好才跟随系统**；垃圾值按"没偏好"处理
 *   · ⚠️ 成对检查只针对**颜色类**令牌 —— 字体/形状/几何与主题无关，不该要求深浅成对
 */
/**
 * draft/mode.js — 主题状态机 + 令牌完备性检查（**只读、只判定**）
 * ------------------------------------------------------------------
 * 判法来源：
 *   · 三态偏好：light / dark / system，默认 system（theme-boot.js L24-26）
 *   · 偏好优先，没有偏好才跟随系统（theme-boot.js L34-36）
 *   · 有效值集 ['light','dark','system']，垃圾值退回 system（theme.test.js L206-210）
 *   · storageKey = 'lesson-theme-preference'（theme-boot.js L23）
 *   · DOM 字段：documentElement.style.colorScheme + body[data-ds-dark-theme]
 *     （theme-boot.js L38-39, theme.js L62-63）
 *   · system 由 matchMedia('(prefers-color-scheme: dark)').matches 决定
 *     （theme-boot.js L34-36）
 *
 * checkThemeBlocks 判法：
 *   · theme.css 里浅色块（:root { ... }）和深色块（body[data-ds-dark-theme] { ... }）
 *     必须成对出现
 *   · 每条 --dsw-* / --lesson-* 令牌在两个块里都应有定义
 */

import fs from 'node:fs'
import path from 'node:path'

const VALID_PREFERENCES = ['light', 'dark', 'system']
const STORAGE_KEY = 'lesson-theme-preference'

/**
 * 主题解析（**纯函数**：不读 env / 时钟 / 随机数 / DOM / localStorage）。
 *
 * @param {{ stored: string|null, systemDark: boolean }} params
 *   - stored: localStorage 里保存的偏好值（null = 未存过）
 *   - systemDark: matchMedia('(prefers-color-scheme: dark)').matches
 * @returns {{ effective: 'dark'|'light', colorScheme: string, darkThemeAttr: boolean, storageKey: string }}
 */
export function resolveMode({ stored, systemDark }) {
  // 偏好优先；垃圾值按 system 处理
  let preference = 'system'
  if (stored != null && VALID_PREFERENCES.includes(stored)) {
    preference = stored
  }

  // 解析明暗
  let dark
  if (preference === 'dark') dark = true
  else if (preference === 'light') dark = false
  else dark = !!systemDark   // system: 跟随系统

  return {
    effective: dark ? 'dark' : 'light',
    colorScheme: dark ? 'dark' : 'light',
    darkThemeAttr: dark,
    storageKey: STORAGE_KEY,
  }
}

/**
 * 从 CSS 文本里提取一个 selector 块里的所有 CSS 自定义属性名。
 * 返回 Set<string>。
 */
function extractVars(css, selectorPattern) {
  const vars = new Set()
  // 找 selectorPattern 开头的块，直到匹配的 }
  const re = new RegExp(
    selectorPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\}',
    'g'
  )
  let m
  while ((m = re.exec(css)) !== null) {
    const block = m[1]
    const varRe = /(--[a-zA-Z][a-zA-Z0-9-]*)\s*:/g
    let vm
    while ((vm = varRe.exec(block)) !== null) {
      vars.add(vm[1])
    }
  }
  return vars
}

/**
 * 检查 theme.css 里浅/深两块令牌是否成对。
 *
 * @param {string} root 课程包根目录
 * @returns {{ findings: Array<{ id: string, severity: 'error'|'warn', message: string, hint: string }> }}
 */
export function checkThemeBlocks(root) {
  const findings = []
  const file = path.join(root, 'assets', 'theme.css')
  let css
  try {
    css = fs.readFileSync(file, 'utf8')
  } catch {
    findings.push({
      id: 'theme-missing',
      severity: 'error',
      message: '找不到 assets/theme.css',
      hint: '运行风格适配器合成 theme.css',
    })
    return { findings }
  }

  // 浅色块用 :root，深色块用 body[data-ds-dark-theme]
  const lightVars = extractVars(css, ':root')
  const darkVars = extractVars(css, 'body[data-ds-dark-theme]')

  // 只检查 --dsw-* 和 --lesson-* 前缀的令牌（跳过 --tilt-* 等常量）
  // ⚠️ **只有颜色类令牌才要求深浅成对** —— 字体 / 形状 / 几何 / 时长 / 字重与主题无关，
  //    要求它们成对就是"在绿灯的东西上叫狼来了"（本仓库实测：theme.css 闸门全绿时这里会报 4 条 ✗）。
  const THEME_AGNOSTIC = /(-font(-|$)|-shape$|-radius|-duration|-easing|-weight$|-size$|-tracking|-leading|-family)/
  const isToken = (name) => (name.startsWith('--dsw-') || name.startsWith('--lesson-')) && !THEME_AGNOSTIC.test(name)
  const lightTokens = new Set([...lightVars].filter(isToken))
  const darkTokens = new Set([...darkVars].filter(isToken))

  // 浅色有、深色没有
  for (const name of lightTokens) {
    if (!darkTokens.has(name)) {
      findings.push({
        id: 'token-missing-dark',
        severity: 'warn',
        message: `令牌 ${name} 只在浅色块 :root 中定义，深色块 body[data-ds-dark-theme] 缺失`,
        hint: `在深色块中为 ${name} 添加对应的深色值`,
      })
    }
  }

  // 深色有、浅色没有
  for (const name of darkTokens) {
    if (!lightTokens.has(name)) {
      findings.push({
        id: 'token-missing-light',
        severity: 'warn',
        message: `令牌 ${name} 只在深色块 body[data-ds-dark-theme] 中定义，浅色块 :root 缺失`,
        hint: `在浅色块中为 ${name} 添加对应的浅色值`,
      })
    }
  }

  // 块本身是否存在
  if (lightTokens.size === 0) {
    findings.push({
      id: 'no-light-block',
      severity: 'error',
      message: 'theme.css 中找不到 :root 浅色令牌块',
      hint: '确保 theme.css 包含 :root { ... } 且里面定义了 --dsw-* / --lesson-* 令牌',
    })
  }
  if (darkTokens.size === 0) {
    findings.push({
      id: 'no-dark-block',
      severity: 'error',
      message: 'theme.css 中找不到 body[data-ds-dark-theme] 深色令牌块',
      hint: '确保 theme.css 包含 body[data-ds-dark-theme] { ... } 且里面定义了 --dsw-* / --lesson-* 令牌',
    })
  }

  return { findings }
}
