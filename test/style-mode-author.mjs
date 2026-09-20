#!/usr/bin/env node
/**
 * test/style-mode-author.mjs — T5-b 判据
 * ------------------------------------------------------------------
 * 跑：node test/style-mode-author.mjs [课程包根]
 * 判五条 + 三条证伪：
 *   ① style：合成结果与 assets/theme.css **逐字节相同**（这是最硬的一条）
 *   ② mode：状态机四个用例（偏好优先 / 跟随系统 / 垃圾值）
 *   ③ mode：令牌成对检查在**闸门全绿的** theme.css 上**不报 error**（叫狼来了就是坏判据）
 *   ④ author：合规输入 → 骨架自查通过，且 readPack 能认得它
 *   ⑤ 证伪：坏 slug / 缺 source / 少一个槽位 —— 三个都必须被挡下
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { readPack } from '../lib/pack.js'
import { composeTheme, themeDrift } from '../lib/style.js'
import { resolveMode, checkThemeBlocks } from '../lib/mode.js'
import { authorLesson, validateSkeleton } from '../lib/author.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] || path.resolve(HERE, '..', '..', 'study')

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`) } else { fails.push(m); console.log(` FAIL ${m}`) } }
const throws = (fn) => { try { fn(); return false } catch { return true } }

console.log(`\n[t5b] 课程包：${ROOT}`)

// ① style 逐字节
{
  const r = composeTheme(ROOT)
  const actual = fs.readFileSync(path.join(ROOT, 'assets', 'theme.css'), 'utf8')
  ok(r.css === actual, `合成 theme.css 与现有产物**逐字节相同**（${r.css.length} 字符 · 预设 ${r.used}${r.fallback ? '·退路' : ''}）`)
  ok(themeDrift(ROOT).same === true, 'themeDrift 判"无漂移"')
}

// ② mode 状态机
{
  const cases = [
    [{ stored: 'dark', systemDark: false }, 'dark'],
    [{ stored: 'light', systemDark: true }, 'light'],
    [{ systemDark: true }, 'dark'],
    [{ systemDark: false }, 'light'],
    [{ stored: '垃圾值', systemDark: true }, 'dark'],
  ]
  let good = 0
  for (const [input, want] of cases) {
    const r = resolveMode(input)
    const fine = r.effective === want && r.storageKey === 'lesson-theme-preference'
      && r.colorScheme === want && r.darkThemeAttr === (want === 'dark')
    if (!fine) console.log(`       ${JSON.stringify(input)} -> ${JSON.stringify(r)}（期望 ${want}）`)
    if (fine) good++
  }
  ok(good === cases.length, `状态机 ${good}/${cases.length} 个用例正确（偏好优先 · 没有偏好跟系统 · 垃圾值当没偏好）`)
}

// ③ 令牌成对检查：不许在绿灯产物上叫狼来了
{
  const r = checkThemeBlocks(ROOT)
  const errors = r.findings.filter((f) => f.severity === 'error')
  ok(errors.length === 0, `theme.css 上没有 error 级令牌问题${errors.length ? '：' + errors.map((f) => f.message).join('；') : ''}`)
  const warns = r.findings.filter((f) => f.severity === 'warn')
  if (warns.length) console.log(`  （${warns.length} 条 warn：${warns.slice(0, 3).map((f) => f.message.slice(0, 40)).join(' / ')}）`)
  ok(warns.length === 0, `颜色类令牌深浅成对，没有 warn 噪声（字体/形状这类不该要求成对）`)
}

// ④ author：合规输入 + readPack 认得它
const INPUT = {
  halo: 'programming', point: 'spring-boot', number: 9,
  title: '测试骨架（T5-b）', slug: 'whale-t5b-fixture',
  hintTerm: 'http', source: { label: '测试桩', url: 'https://example.com/' },
  terms: {},
}
{
  const a = authorLesson(INPUT)
  ok(a.file === 'lessons/src/0009-whale-t5b-fixture.html', `建议路径正确（${a.file}）`)
  const v = validateSkeleton(a.text)
  ok(v.ok, `骨架自查通过${v.ok ? '' : '：' + v.problems.join('；')}`)

  // readPack 认不认得它（放进影子课程包）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-author-'))
  try {
    fs.cpSync(path.join(ROOT, 'lessons'), path.join(tmp, 'lessons'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'progress.json'), path.join(tmp, 'progress.json'))
    fs.writeFileSync(path.join(tmp, a.file), a.text, 'utf8')
    const pack = readPack(tmp)
    const found = pack.lessons.find((l) => l.id === 'spring-boot/0009')
    ok(!!found, `readPack 认得新骨架（${found ? found.label + ' · ' + found.href : '没找到'}）`)
    ok(found?.termCount === 0, '骨架的 termCount = 0（terms 为空）')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

// ⑤ 证伪三条
{
  ok(throws(() => authorLesson({ ...INPUT, slug: '' })), '缺 slug → 抛错（中文标题派生不出文件名）')
  ok(throws(() => authorLesson({ ...INPUT, slug: '中文-slug' })), '非 ASCII slug → 抛错')
  ok(throws(() => authorLesson({ ...INPUT, source: { label: '', url: '' } })), '缺 source → 抛错（课程包不许没出处的课）')
  const bad = authorLesson(INPUT).text.replace('<!--@challenges-->', '')
  const v = validateSkeleton(bad)
  ok(!v.ok, `少一个槽位 → 自查不通过（${v.problems.slice(0, 2).join('；')}）`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 主题逐字节一致 · 状态机正确 · 令牌不误报 · 骨架可用且坏输入被挡下')
