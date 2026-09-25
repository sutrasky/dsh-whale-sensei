#!/usr/bin/env node
/**
 * test/wording.mjs —— 话术 golden：三类结构性短语必须有，且断言真的咬得住（P0-5 / 戊2）
 * ------------------------------------------------------------------
 * 跑：node test/wording.mjs
 *
 * 为什么要它：42 套测试里**没有一条**钉住开课协议与回执的话术 —— 话术改坏了没人红，
 * 全靠人眼（`13507af` 修"入口 404 话术"就是这么修的）。参照 StudyMate 的做法：
 * 用**文本断言**把提示词钉住（它拿 417 条断言钉 SKILL.md），提示词改坏就红。
 *
 * 钉什么（**关键词为主、结构性快照为辅**）：
 *   ① 开课协议：**真调 `buildStarter()`**（不是正则扫源文件）—— 三段标题 + 每段的结构性关键词；
 *   ② 三类结构性短语：回执里「下一步 / 缺什么 / 去哪看」各有出处，不是散文；
 *   ③ 结构性快照：只钉**标题行与字段名**，不钉整段散文 —— 散文快照是负债，改一个字就红。
 *
 * 反空转（防"文件在就算过"的裸快照）：把源文本**在内存里变异**（删掉关键句）后，
 * 同一套检查**必须报红** —— 证明断言咬的是内容，不是"文件存在"。
 *
 * 2026-09-24 F1b 已把开课协议从**四步改成三段**（`lib/starter.js:48-65`）—— 判据跟着盘上走。
 */

import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN, packRoot } from './_pack.mjs'
import { buildStarter, STARTER_HINT } from '../lib/starter.js'

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`) } else { fails.push(m); console.log(` FAIL ${m}`) } }

const read = (rel) => fs.readFileSync(path.join(PLUGIN, rel), 'utf8')
const missing = (text, marks) => marks.filter((m) => !text.includes(m))

/** 反空转：把某个标记从文本里删掉后，检查函数**必须**报出它 */
function bites(text, marks, label) {
  const before = missing(text, marks)
  if (before.length) return `源文件里本来就缺：${before.join(' / ')}`
  const mutated = missing(text.replace(marks[0], ''), marks)
  if (!mutated.length) return `删掉「${marks[0]}」后仍然全绿 ⇒ 断言是空的（裸快照）`
  return null
}

console.log('\n[话术] 开课协议与回执的三类结构性短语')

// ① 开课协议：真调 buildStarter（盘上就是三段）
let protocolPrompt = ''
let SEGMENTS = []
{
  const starter = buildStarter(packRoot())
  const prompt = String(starter?.prompt || '')
  protocolPrompt = prompt

  SEGMENTS = [
    ['① 查资料', ['RESOURCES.md', '禁止凭记忆']],
    ['② 看挑战', ['whale_intake', 'whale_goal', '学完要能做出什么', '能改能讲']],
    ['③ 生成课程', ['别按文件名序', 'whale_build', 'gate.mjs']],
  ]
  for (const [title, marks] of SEGMENTS) {
    ok(prompt.includes(title), `协议里有这一段：${title}`)
    const miss = missing(prompt, marks)
    ok(miss.length === 0, `${title} 段的结构性关键词齐全（${marks.join(' / ')}）${miss.length ? ' — 缺：' + miss.join('、') : ''}`)
  }
  ok(prompt.includes('顺序就是依赖'), '协议明说「顺序就是依赖」—— 三段不是并列菜单，是依赖链')
  ok(prompt.includes('whale_author 会被闸门拦下'), '② 段末尾写明闸门后果（漏落盘会被 whale_author 拦下，别用 force 绕）')

  // ③ 教学方式的三步话术（丁3）：**翻译 → 预览 → 点头**，且必须落在 ② 段内（写课前的输入）
  {
    const i2 = prompt.indexOf('② 看挑战'), i3 = prompt.indexOf('③ 生成课程')
    const seg2 = i2 >= 0 && i3 > i2 ? prompt.slice(i2, i3) : ''
    const marks = ['翻译成参数取值', '预览', '他点头', 'whale_teaching', '不在可调集里']
    const miss = missing(seg2, marks)
    ok(miss.length === 0, `② 段里有「翻译 → 预览 → 点头」三步话术 + 指向 whale_teaching + 锁死集提醒${miss.length ? ' — 缺：' + miss.join('、') : ''}`)
    ok(!prompt.includes('教学方式') || seg2.includes('教学方式'), '教学方式这段话术只出现在 ② 段（不散在协议别处）')
  }

  // 回执（HINT）与协议同源：三段箭头结构必须一致
  ok(/①.*→.*②.*→.*③/.test(STARTER_HINT), `STARTER_HINT 与协议同源（三段箭头结构）：${STARTER_HINT.slice(0, 40)}…`)
}

// ② 三类结构性短语：回执必须收在「下一步：」上（不是散文结尾）
{
  const RECEIPTS = [
    ['lib/mods/pack.js', ['下一步：']],
    ['lib/mods/glossary.js', ['下一步：']],
    ['lib/mods/brief.js', ['下一步：']],
    ['lib/pack-scaffold.js', ['## 还缺什么', '## 下一步']],
    ['lib/brief.js', ['## 建议的下一步']],
  ]
  for (const [rel, marks] of RECEIPTS) {
    const src = read(rel)
    const bad = bites(src, marks, rel)
    ok(!bad, `${rel} 含 ${marks.join(' / ')}，且删掉后会红${bad ? ' — ' + bad : ''}`)
  }

  // 「缺什么」这一类：门禁回执必须逐条给缺项文本，而不是一句"没过"
  const gate = read('lib/gate.js')
  ok(gate.includes("'（缺：'") || gate.includes('（缺：'), 'gate.js 的挑战回执逐条给「（缺：…）」，不是一句"没过"')
  ok(gate.includes('whale_state write:true'), 'gate.js 每条 hint 都给**动作**（去哪看 / 怎么修），不是只报状态')
}

// ③ 结构性快照：只钉标题行与字段名（散文不进快照）
{
  const starterSrc = read('lib/starter.js')
  ok(starterSrc.includes('① 查资料：') && starterSrc.includes('② 看挑战') && starterSrc.includes('③ 生成课程：'),
    '三段标题在源里逐字可搜（结构性快照；散文不钉）')

  const i1 = protocolPrompt.indexOf('① 查资料'), i2 = protocolPrompt.indexOf('② 看挑战'), i3 = protocolPrompt.indexOf('③ 生成课程')
  ok(i1 >= 0 && i1 < i2 && i2 < i3, '三段的**出现顺序**就是依赖顺序（① < ② < ③）—— 不是并列菜单')

  // 本套件钉的全是短标记：任何一条超过 40 字就说明有人把散文塞进了快照
  const allMarks = SEGMENTS.flatMap(([, m]) => m).concat(['下一步：', '## 还缺什么', '## 下一步', '## 建议的下一步'])
  const longOnes = allMarks.filter((m) => m.length > 40)
  ok(longOnes.length === 0, `快照标记全是短结构（最长 ${Math.max(...allMarks.map((m) => m.length))} 字），没有整段散文${longOnes.length ? ' — 超长：' + longOnes.join('、') : ''}`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 开课协议三段齐全 · 回执收在「下一步」 · 断言删字即红（不是裸快照）')
