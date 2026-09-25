/**
 * build-preset.mjs —— 从**已验证可用的那份预设**合成「鲸师模式」的 agent.cordis.yml
 * ------------------------------------------------------------------
 * 跑：node preset/whale-mode/build-preset.mjs [模板路径]
 *
 * 为什么要有这一步（照 `_qq-setup/build-persona.mjs` 的先例）：
 *   · 人设是**会被反复改**的长文本 —— 写在 `persona.md` 里改，别在 400 行 YAML 里翻；
 *   · 组合（工具行 / isolate 分组 / skill 挂载）是**一次成型**的，改它的风险远大于改人设。
 *   两者分开，人设随便改，组合不动。
 *
 * 模板默认取本机那份**跑通过的**预设（QQ 那套）—— 同一个 DSH 版本、同一个平台，
 * 是「这个组合真的能挂起来」的现成证据。合成时只动两处：
 *   ① `persona.prefix` ← `persona.md`
 *   ② `skill-filesystem.customSkillDirs` ← 占位符 `__WHALE_SKILLS__`（安装器替换成
 *      `<packRoot>/skills`；**不写死本机路径**，换台机器才不会断）
 *
 * ⚠️ 不写 `includeDefaultRoots: false`：那是"技能列表里只剩这 5 个"的代价——
 *    会把该 profile 里其他技能**全部藏掉**。主人 2026-09-25 定：**不藏，并存**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_TEMPLATE = 'E:\\App\\dsh\\.agent-presets\\whalegirl-qq\\agent.cordis.yml'
const SKILLS_PLACEHOLDER = '__WHALE_SKILLS__'

const template = process.argv[2] || DEFAULT_TEMPLATE
const personaPath = path.join(HERE, 'persona.md')
const outPath = path.join(HERE, 'agent.cordis.yml')

if (!fs.existsSync(template)) {
  console.error(`模板预设不在：${template}\n  用法：node preset/whale-mode/build-preset.mjs <一份能用的 agent.cordis.yml>`)
  process.exit(1)
}
const src = fs.readFileSync(template, 'utf8')
const persona = fs.readFileSync(personaPath, 'utf8').replace(/\r\n/g, '\n').trimEnd()

/** 缩进成 YAML 字面块（`prefix: |` 下的每一行至少 6 空格；空行留空） */
const indent = (text) => text.split('\n').map((l) => (l.trim() ? '      ' + l : '')).join('\n')

// ① persona.prefix ← persona.md（块从 `prefix: |` 起到下一个顶层 `- id:` 之前）
const lines = src.split('\n')
const start = lines.findIndex((l) => /^(\s*)prefix:\s*\|\s*$/.test(l))
if (start < 0) { console.error('模板里找不到 `prefix: |` —— 换一份模板'); process.exit(1) }
let end = start + 1
while (end < lines.length && !/^- /.test(lines[end])) end++
const out = [
  ...lines.slice(0, start),
  '    prefix: |',
  indent(persona),
  ...lines.slice(end),
]

// ② customSkillDirs ← 占位符（安装器替换；不写死本机路径）
let hit = 0
const out2 = out.map((l) => {
  const m = /^(\s*-\s*)'.*'\s*$/.exec(l)
  if (m && l.includes('.agent-presets') && l.includes('skills')) { hit++; return `${m[1]}'${SKILLS_PLACEHOLDER}'` }
  return l
})
if (!hit) { console.error('模板里找不到 customSkillDirs 的那一行 —— 换一份模板'); process.exit(1) }

const text = out2.join('\n')
if (!text.includes(SKILLS_PLACEHOLDER)) { console.error('占位符没写进去'); process.exit(1) }
fs.writeFileSync(outPath, text, 'utf8')
console.log(`已合成 ${path.relative(process.cwd(), outPath)}`)
console.log(`  persona  ${persona.split('\n').length} 行 ← ${path.relative(process.cwd(), personaPath)}`)
console.log(`  模板     ${template}`)
console.log(`  skill 挂载 ${SKILLS_PLACEHOLDER}（安装器替换成 <packRoot>/skills；**不藏其他技能**）`)
