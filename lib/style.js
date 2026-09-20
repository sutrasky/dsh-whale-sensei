/**
 * style.js — 主题合成（只读 + 可对比）
 * ------------------------------------------------------------------
 * 起草：mimo（读现有 tools/*.js 的判法）；收口：主线程（接口 / 判据 / 对拍）。
 * 契约：`composeTheme(root, opts) -> { slug, used, fallback, css, warnings, docChanged, docHashNow }`
 *   · 退路链照 style-adapter：索引读不到 / slug 不在索引 / 预设缺失 → 退回内置基础；连内置都没有 → **抛错**（拒绝静默降级）
 *   · 判据：输入没变时 `css` 与 `assets/theme.css` **逐字节相同**
 */
/**
 * draft/style.js — 风格合成与漂移检测（**只读、只判定，不写盘**）
 * ------------------------------------------------------------------
 * 移植自 tools/style-adapter.js 的 load() 逻辑。
 * 判法来源：
 *   · 退路链：config 缺/索引读不动/slug 不在索引 → 退回 DEFAULT_SLUG（style-adapter L76-96）
 *   · 索引不存在时跳过 slug 校验并警告（style-adapter L82）
 *   · slug 不在索引时警告但不拦截（style-adapter L83）
 *   · 预设文件不存在 → 退 DEFAULT_SLUG + 警告（style-adapter L88-94）
 *   · 连 DEFAULT_SLUG 都没有 → 抛错，拒绝静默降级（style-adapter L95）
 *   · docHash 比对：文档变了给提示但不上闸（style-adapter L98-108）
 *   · compose 用函数替换避免 $ 被当替换模式（style-adapter L53-56）
 *
 * 与原版差异：ESM、不写盘、不依赖 lesson.config.json 路径常量，
 *             由调用方传入 root 和 opts（opts 覆盖 config.style）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { stripBom } from './text.js'

const MARK = '/* @preset-values */'
const DEFAULT_SLUG = 'whale-sensei'
const INDEX = '_INDEX.md'

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

/** 读文件，不存在返回 null */
function readIf(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return null }
}

/** 预设文件路径 */
function presetPath(root, slug) {
  return path.join(root, 'presets', `${slug}.css`)
}

/** 读预设值（去掉尾随空白，保证合成可逐字节复现）；不存在返回 null */
function readValues(root, slug) {
  const p = presetPath(root, slug)
  const raw = readIf(p)
  return raw != null ? raw.replace(/\s+$/, '') : null
}

/** 索引里的 slug 集合（条目格式：`- <slug> — 名称 · 适用…`）；索引不存在返回 null */
function slugsFromIndex(dir) {
  const p = path.join(dir, INDEX)
  const content = readIf(p)
  if (content == null) return null
  const set = new Set()
  for (const line of content.split('\n')) {
    const m = line.match(/^-\s+([a-z0-9][a-z0-9-]*)\s+—/)
    if (m) set.add(m[1])
  }
  return set
}

/** 注入位替换（用函数形式，避免值里的 $ 被当成替换模式） */
function compose(contract, values) {
  if (!contract.includes(MARK)) throw new Error(`契约里找不到注入位 ${MARK}`)
  return contract.replace(MARK, () => values)
}

/**
 * 合成主题 CSS。
 *
 * @param {string} root 课程包根目录
 * @param {object} [opts] 覆盖 config.style 的字段（slug / docHash / stylesDir）
 * @returns {{ slug: string, used: string, fallback: boolean, css: string,
 *             warnings: string[], docChanged: boolean, docHashNow: string|null }}
 */
export function composeTheme(root, opts = {}) {
  const warnings = []

  // 读 lesson.config.json（可能不存在）
  const confRaw = readIf(path.join(root, 'lesson.config.json'))
  let conf = null
  // ⚠️ 剥 BOM：不剥的话 JSON.parse 抛 → 被下面 catch 吞掉 → **静默退回内置基础**（很坏 ✗）
  try { conf = confRaw ? JSON.parse(stripBom(confRaw)) : null } catch { /* 不是合法 JSON */ }
  const style = { ...(conf?.style || {}), ...opts }

  if (!conf || !conf.style) {
    warnings.push(`⚠️ 风格适配器：lesson.config.json 缺失或没有 style 段 → 退回内置基础「${DEFAULT_SLUG}」`)
  }

  const slug = style.slug || DEFAULT_SLUG
  const dir = style.stylesDir || path.join(root, '..', 'dsh-raw-html-v2-master', 'styles')

  // slug 校验：索引存在才查
  const slugs = slugsFromIndex(dir)
  if (!slugs) {
    warnings.push(`⚠️ 风格适配器：读不到风格索引 ${path.join(dir, INDEX)} → 跳过 slug 校验，按内置基础渲染`)
  } else if (!slugs.has(slug)) {
    warnings.push(`⚠️ 风格适配器：slug「${slug}」不在 _INDEX.md 里 → 仍按内置基础渲染，请检查拼写`)
  }

  // 退路链：预设不存在 → 退 DEFAULT_SLUG → 连 DEFAULT_SLUG 都没有 → 抛错
  let used = slug
  let fallback = false
  let values = readValues(root, used)
  if (values == null) {
    if (used !== DEFAULT_SLUG) {
      warnings.push(`⚠️ 风格适配器：预设 presets/${used}.css 不存在 → 退回内置基础「${DEFAULT_SLUG}」`)
      used = DEFAULT_SLUG
      fallback = true
      values = readValues(root, used)
    }
    if (values == null) {
      throw new Error(`风格适配器：连内置基础 presets/${DEFAULT_SLUG}.css 都在不 —— 拒绝静默降级`)
    }
  }

  // docHash 比对（变更提示，不上闸）
  let docChanged = false
  let docHashNow = null
  if (style.docHash) {
    const mdPath = path.join(dir, `${slug}.md`)
    const mdContent = readIf(mdPath)
    if (mdContent != null) {
      docHashNow = sha256(mdContent)
      if (docHashNow !== style.docHash) {
        docChanged = true
        warnings.push(
          `ℹ️ 风格文档已变更：「${slug}.md」指纹 ${style.docHash.slice(0, 12)}… → ${docHashNow.slice(0, 12)}…` +
          `（§7 变更提示，不上闸；确认无碍后把 lesson.config.json 的 docHash 更新为 ${docHashNow}）`
        )
      }
    }
  }

  // 合成
  const contract = readIf(path.join(root, 'templates', 'contract.css'))
  if (contract == null) throw new Error(`风格适配器：找不到 templates/contract.css —— 拒绝静默降级`)

  const css = compose(contract, values)

  return { slug, used, fallback, css, warnings, docChanged, docHashNow }
}

/**
 * 漂移检测：比对已有产物与当前合成结果（**只比对，不写盘**）。
 *
 * @param {string} root 课程包根目录
 * @param {object} [opts] 同 composeTheme
 * @returns {{ same: boolean, expected: string, actual: string|null }}
 */
export function themeDrift(root, opts = {}) {
  const { css } = composeTheme(root, opts)
  const actualPath = path.join(root, 'assets', 'theme.css')
  const actual = readIf(actualPath)
  return { same: actual === css, expected: css, actual }
}
