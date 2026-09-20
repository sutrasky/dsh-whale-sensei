/**
 * pack-model.mjs —— 把 lib/pack-model.js 的原子断言**接进统一那本测试账**
 *
 * 为什么要有这一层：`pack-model.js --selftest` 里的断言如果只活在模块里，
 * `node test/run-all.mjs` / `node test/all.mjs` 就**看不到它** ✗ ——
 * 新加的检查等于没进账（A3 存在的意义就是消灭这种"两套口径"）。
 *
 * 但**不许**在这里重写一遍断言 ✗ —— 那又会变成两套口径（本项目正在消灭的东西）。
 * 所以这里只做三件事：跑它、把它的 ok/FAIL 行原样数出来、按本账的摘要契约汇报。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const PACK = path.resolve(process.argv[2] || path.join(PLUGIN, '..', 'study'))

// 一次跑多个模块的 --selftest（断言仍**只有一份**，都在各模块自己文件里；
// 这里只是把它们接进同一本账 —— 不许在这层重写断言，否则又成两套口径 ✗）
//
// `lib/cdp.js` 是 2026-09-24 补进来的：A1b 把它写好、自带 --selftest（还真起浏览器
// 验"整页高 > 视口高""局部尺寸恰好等于 clip"），但**没有任何账引用过它** ——
// 写了检查却没进账，正是 A3 存在的意义所针对的那种"两套口径"。
const TARGETS = ['lib/pack-model.js', 'lib/notes-io.js', 'lib/mods/note.js', 'lib/cdp.js']
let out = ''
let childCode = 0
for (const t of TARGETS) {
  out += '### ' + t + '\n'
  try {
    out += execFileSync(process.execPath, [path.join(PLUGIN, t), '--selftest', PACK],
      { cwd: PLUGIN, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    childCode = e.status ?? 1
    out += (e.stdout || '') + (e.stderr || '')
  }
  out += '\n'
}

const lines = out.split('\n')
const pass = lines.filter((l) => l.startsWith('ok   ')).length
const fails = lines.filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5).trim())

// 把模块自己的汇报也带过来（含容器里的数字），但断言**不重写**
for (const l of lines) {
  if (/^(ok|FAIL) /.test(l) || /^(包路径|映射表|扫描器|check-terms|box 装载|笔记 box|非课程页)/.test(l)) {
    console.log(l.replace(/^FAIL /, 'FAIL '))
  }
}
if (!pass && !fails.length) {
  // 一条断言都没解析到 = 硬失败（不许静默记成 0/0 通过）—— 同 all.mjs 的规矩
  console.log('FAIL 没解析到任何断言行（子进程 exit=' + childCode + '）：原始输出尾部')
  console.log(lines.slice(-6).map((l) => '    ' + l).join('\n'))
  fails.push('未解析到断言')
}

if (fails.length) console.log('失败项：' + fails.join('；'))

// ⚠️ 这是 run-all.mjs 的解析契约（正则 `=== (\d+) 通过 / (\d+) 失败 ===`）
console.log('\n=== ' + pass + ' 通过 / ' + fails.length + ' 失败 ===')
process.exit(fails.length || childCode ? 1 : 0)
