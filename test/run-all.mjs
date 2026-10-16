/**
 * run-all.mjs —— 一条命令跑完全部判据（T01：加机器结果与严格对账）
 *
 * 每套测试自成进程（互不污染），失败即非零退出。
 * 用途：改完插件先跑这个，再谈重启宿主。
 *
 * T01 补的三件事（报告 F01 的假绿入口）：
 *   ① **退出码参与判定**：套件打印了全绿摘要但进程非零退出（先打绿再崩）= 红
 *   ② **摘要必须唯一且与正文逐项对得上**：重复摘要、红行 +「全部通过」、0 条断言 = 红
 *   ③ **落一条机器结果**（`{passed, failed, skipped, reason, packRoot, base, cases}`）：
 *      每条用例都带自己的子进程退出码，总入口读它，不再只信人写的那一行摘要。
 *   skip 单列：跳过的套件记 `skip`，**绝不计进 passed**。
 *
 * 机器结果落盘路径：环境变量 `DSH_WHALE_RESULT`（总入口会显式给）；
 * 没给就落在本目录的 `.tmp-run-all-result.json`（已在 .gitignore 里）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  resolveTestContext, contextArgs, contextEnv, formatTestContext, parseTestContextLine,
} from './_pack.mjs'
import { adaptLegacyText, validateRunResult, makeRunResult } from './_result.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * T02（F02）：**顶层解析一次，显式传给每一个子进程**。
 * 以前这里 spawn 子套件时 argv 里什么都不带，只靠继承来的 `DSH_WHALE_PACK` ——
 * 于是 `all <B>` 的 gate 用 B、插件子套件却可能用 env 里的 A（F02 原文）。
 * 现在每个子进程都拿到 `--pack=<绝对路径> --mode=<fixture|real>`（参数优先于 env）。
 */
let CTX
try {
  CTX = resolveTestContext({ argv: process.argv.slice(2), env: process.env })
} catch (e) {
  console.log('❌ 测试输入无效：' + String(e.message || e).split('\n')[0])
  process.exit(1)
}
if (!CTX.packRoot) {
  console.log('❌ 没有课程包根：给 --pack=<绝对路径>，或 DSH_WHALE_PACK=<绝对路径>')
  process.exit(2)
}
const CHILD_ARGS = contextArgs(CTX)
const CHILD_ENV = contextEnv(CTX)
const CTX_LINE = formatTestContext(CTX)
const SUITES = [
  ['pack-parity', '课程包读取：同输入 → 同输出'],
  ['build-verify', '产物校验：坏样会被抓出'],
  ['probe-audit', '路径判定 + 五条审计'],
  ['style-mode-author', '主题 / 状态机 / 骨架'],
  ['render-parity', 'M2 对拍：插件渲染 == CLI 渲染（逐字节）'],
  ['build-write', '落盘分支：抓得到漂移、修得对、真包不动'],
  ['state-probe', '学生状态探针：与人工记录一致、坏样本报得出缺什么'],
  ['lightup', '点亮换钉子：判据快照先判后写 / 失败关闭五分支 / 判据拒绝与不可达分离 / 真包不动'],
  ['challenge-gate', '开新课门禁：上一课挑战逐条判 / 无判据放行有告警 / author 拦住且 force 留痕'],
  ['judge-parity', '判词表对拍：插件 judgeSnapshot ↔ 包侧 judgeLightup 同输入同判词（code/hint/gaps）+ 放行三元组 + 豁免表反核账'],
  ['deadlink-parity', '死链/缺产物互补对拍：活源扫链（带行号）↔ 构建产物 href 存在性 —— 两个最小复现钉成已知差异（豁免表 + 双方实况 + 真包不动）'],
  ['exec-hint', 'shell-out 的 EPERM 人话：EPERM/EACCES/超时/找不到 各说各的 + 正常退出不叫狼来了 + runAsync 不再把 error 变成未捕获异常'],
  ['wording', '话术 golden：开课协议三段齐全（真调 buildStarter）+ 回执收在「下一步」+ 删字即红（不是裸快照）'],
  ['lesson-blocks-parity', 'lesson-blocks.css 两个生成器对拍（#10 缺口②）：真跑课程包 --extract，产物与插件 mergeBlocks 逐字节相同 + 去重语义一致 + 真包不动'],
  ['mode-parity', '主题状态机对拍（#10 缺口④）：真跑包侧 assets/theme.js（vm + 最小 DOM 桩）与 resolveMode 逐格比 20 格 + 存储键/写路径 + 两处源文本变异必须变红'],
  ['plan-gate', '知识点地图：判据矩阵 / 写口拒坏图 / 大纲闸（禁 force 绕） / 真包不动'],
  ['ask-route', '课程疑问：提交 / 拉取 / 坏样本一动不动'],
  ['ask-answer', '解答写回：台账外科手术式追加 + 真跑重建'],
  ['rebuild-job', '异步重建器：起完就返回 / 顺序有意义 / 失败不中断 / 与同步版告警逐字相同'],
  ['rebuild-wiring', '三入口接重建：建圈五条 / 建点建课两条 / 入口不等脚本 / 缺件如实报 / 全缺不起作业'],
  ['bom-tolerance', 'BOM 容忍：带 BOM 与不带 BOM 结果完全一致'],
  ['glossary-verify', '名词台账：合成 == CLI，漂移/缺失报得出'],
  ['glossary-edit', '术语增改：切片插入/拒绝覆盖/替换；code 含花括号也不崩，写出的源码能 require 回来'],
  ['pack-model', '数据层唯一入口：课次映射表、data-term 扫描器与 check-terms 逐页对拍、三类 box 不变量'],
  ['ask-watch-job', '原生监听：owner/高水位/复用/撤销'],
  ['intake', '学情摸底：问题生成/落盘回读/author 闸门/decideNext/buildBrief 集成'],
  ['brief', '上下文包：六段对拍一致，建议随数据变'],
  ['goals', '终点契约：schema 校验 / 键序钉死 / 无时间戳 / append-only 留痕 / 失败回滚 / 空态回落'],
  ['goal-tool', 'whale_goal：必填严拒 / 原文逐字 / 裸名补圆圈 / append-only / from 接摸底 / 真包不动'],
  ['teaching-io', '教学参数：可枚举 + 档位默认 / 可调集拦得住 / 教学纪律锁死 / 上限拒写提示合并 / propose 不写盘 · write 要点头'],
  ['teaching-apply', '教学参数落地：一处注入（只在那段）+ 每个参数一条生效判据（判不了的如实 null）+ 反空转'],
  ['teaching-view', '设置页「教学方式」：列出全部圆圈（含孤儿）· from 不串台 · 注入原文与老师收到的逐字节同源 · 正文带齐节奏与锁死集 · 只读'],
  ['settings-teaching', '设置页「教学方式」路由：只挂两条 · 只读不写盘 · 拒得清楚 · 路径覆盖 · 渲染级（mini-React 真渲一遍）· 给 agent 的话术面学科中立'],
  ['evidence', '证据档位（P0-4 戊1b）：档位强→弱 · 台账 append-only · 取最高档 · **只贴口头确认不算过** · 台账不在时回退且说出来 · 路由/工具/页面三处都通'],
  ['preset', '鲸师模式预设：名字/组合三行/老师人设含纪律与教学方式与 5 技能/双权威没被抄/技能目录是占位符/不藏其他技能 + **随包发（files）+ 插件自己装得出（幂等·不盖手写·缺模板报错）**'],
  ['visual', '视觉检查：PNG/DOM 断言（有服务就真跑浏览器）'],
  ['practice', '实践区：数据与探针一致、可判漂移、真浏览器里显示'],
  ['mirror-parity', '镜像对拍：文本助手一致 + 两个写入口产出同形记录（共用一本台账）'],
  ['panel', '设置节：只读状态路由（没配也回 200 并指路）+ 客户端半边格式与官方缝对齐'],
  ['tool-smoke', '工具面：装得上、五字段齐全、只读调用不碰盘'],
  ['alien-env', '别人机器：只配课程包目录就能用（本机路径静态守卫 + 装得上 + 降级不糊屏 + 没配就报错）'],
  ['catalog', '数据面：圆圈/知识点/课程的规范 id（唯一、可解析）+ 下一课号 + 圆圈建议'],
  ['new-course-wizard', '新课程向导：三屏顺序 / 字段逐字未变 / 归属行按需出现 / 建点后地图指令 mapPrompt（话术·回执·客户端）'],
  ['circle-create', '写入口：新建圆圈/知识点（原子、拒覆盖、坏 id 拒绝、绝不碰真包）'],
  ['circle-delete', '圆圈删除：dryRun 只报清单 / 必须 confirm / 目录+源+进度一并删 / 学生代码只报不删 / 歧义拒绝'],
  ['settings-catalog', '设置页：三级目录 / 圆圈改名（只改 name、其余逐字节保留）/ 模块表可查 / 展开不串台 / 删除弹窗'],
  ['parity-registry', '同源实现对拍：每对的两个实现都在、落点存在且**真的在跑**（§5）'],
  ['pack-scaffold', '选课程包：原生选择框 / 只往空目录建 / 引擎模板中性化对拍 / profile 层就地改一行 / 拒绝面'],
  ['pack-open', '课程中心：先探活再起（复用不重复 listen）/ 起完真的答 / 缺件与端口被占一律如实报'],
  ['export-pack', '导出这一节课（离线课件包）：真导出恰好 5 个文件 / 不带 src·assets·starmap / 文件名用课程名且同名加课号 / 路径穿越与缺源一律拒 / 导出是纯读'],
]

const outPath = process.env.DSH_WHALE_RESULT || path.join(HERE, '.tmp-run-all-result.json')
const base = `node test/run-all.mjs ${CHILD_ARGS.join(' ')}`.trim()
/**
 * 可选：`DSH_WHALE_SUITES=a,b` 只跑点名的那几套。
 * 用途只有一个 —— **审计夹具**要造「某套假绿」的最小复现；默认（不设）恒等于全跑。
 */
const only = (process.env.DSH_WHALE_SUITES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const PLAN = only.length ? SUITES.filter(([n]) => only.includes(n)) : SUITES

let failed = 0
let total = 0
const cases = []
let crashed = 0
/** T02（F02）：子进程自报的测试上下文与顶层解析结果对不上的套件（**必须逐条报出来**） */
const ctxDrift = []

for (const [name, what] of PLAN) {
  const t0 = Date.now()
  // **必须同时收 stdout 与 stderr**：套件摘要走 stdout，而 `[test-context]`（T02 的判据）
  // 走 stderr —— 只收 stdout 就会把"参数传没传到"这件事整个丢掉。
  const r = spawnSync(process.execPath, [path.join(HERE, name + '.mjs'), ...CHILD_ARGS], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...CHILD_ENV },
  })
  const code = typeof r.status === 'number' ? r.status : null
  let spawnError = null
  if (code === null) { crashed++; spawnError = String(r.error?.message ?? r.signal ?? '没有退出码') }
  // stdout 在前、stderr 在后：摘要契约（`=== N 通过 / M 失败 ===`）只活在 stdout 里，
  // `[test-context]` 在 stderr 里 —— 拼起来给 adapter 与逐进程对账各取所需。
  const out = String(r.stdout ?? '') + String(r.stderr ?? '')
  // **T02（F02）逐进程对账**：子套件自己报的 `[test-context]` 必须与顶层解析结果一致。
  // 这就是「env=A、参数=B 时所有子进程只报 B」这条判据的落点：
  // 子进程**没报**（没 import _pack.mjs 的套件）记 `ctx:null` 并单列，**不当成通过**。
  const childCtx = parseTestContextLine(out)
  if (!childCtx) {
    ctxDrift.push({ id: name, why: '子进程没有报 [test-context]（这一套不经过 _pack.mjs 定源）' })
  } else if (childCtx.packRoot !== CTX.packRoot || childCtx.mode !== CTX.mode) {
    ctxDrift.push({
      id: name,
      why: `子进程自报 ${childCtx.mode}/${childCtx.packRoot}，顶层是 ${CTX.mode}/${CTX.packRoot}`,
    })
  }
  // **严格 adapter**：单套摘要唯一 / 条数与正文红行逐项对账 / 执行量非零 / 退出码为 0
  const a = adaptLegacyText({ kind: 'one-suite', out, code, label: name })
  const p = a.ok ? (a.passed ?? 0) : (a.parsed ? (a.passed ?? 0) : 0)
  const f = a.ok ? 0 : (a.parsed ? Math.max(1, a.failed ?? 0) : 1)
  total += p
  if (!a.ok) failed++
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const mark = a.ok ? '✓' : '✗'
  console.log(`${mark} ${name.padEnd(18)} ${String(p).padStart(3)} 通过${f ? ` / ${f} 失败` : ''}  (${secs}s)  ${what}`)
  if (!a.parsed) console.log(String(out).split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'))
  // 有摘要但失败了 → 把该套件自己的 FAIL/✗ 行打出来。
  // 为什么必须有这一条：2026-09-22 实测过"账报了红，但不告诉你红在哪" ——
  // 结果在整轮/单独跑之间来回猜了三轮（alien-env 整轮红、单跑绿）。摘要只给条数，定位得看原文。
  if (!a.ok) {
    const detail = String(out).split('\n').filter((l) => /FAIL|✗/.test(l)).slice(0, 8)
    if (detail.length) console.log(detail.map((l) => '    ' + l.trim()).join('\n'))
    if (a.reason) console.log('    ↳ 判红依据：' + a.reason)
  }
  // 机器结果：每条用例带自己的子进程退出码（记录说全绿、退出码非零 = 红）
  const ctxNote = childCtx ? `ctx=${childCtx.mode}/${childCtx.packRoot}` : 'ctx=(未报)'
  cases.push({ id: name, status: a.ok ? 'pass' : 'fail', exitCode: code, note: a.reason ?? (a.ok ? undefined : '未通过'), ctx: ctxNote })
  if (code !== 0) cases.push({ id: `exit:${name}`, status: 'fail', exitCode: code, note: code === null ? `子进程没有退出码（崩溃/超时）：${spawnError ?? ''}`.trim() : `子进程退出码 ${code}${a.ok ? '（摘要却全绿：先打绿再崩）' : ''}` })
}

console.log(`\n=== ${PLAN.length} 套 · 共 ${total} 条断言 · ${failed ? failed + ' 套失败 ✗' : '全部通过 ✓'} ===`)
console.log(`[test-context] mode=${CTX.mode} pack=${CTX.packRoot}`)
if (ctxDrift.length) {
  console.log(`⚠️ ${ctxDrift.length} 套的测试上下文与顶层对不上（T02/F02：参数必须传到每个子进程）——`)
  for (const d of ctxDrift.slice(0, 12)) console.log(`    ${d.id}：${d.why}`)
  if (ctxDrift.length > 12) console.log(`    …另有 ${ctxDrift.length - 12} 套`)
}
if (crashed) console.log(`⚠️ ${crashed} 套子进程没有正常退出（无退出码）—— 已按红记账`)

const result = makeRunResult({
  packRoot: CTX.packRoot,
  base,
  cases,
  reason: failed ? `${failed} 套失败：${cases.filter((c) => c.status === 'fail' && !String(c.id).startsWith('exit:')).map((c) => c.id).join('、')}` : null,
})
const v = validateRunResult(result)
if (!v.ok) {
  console.log('❌ run-all 自己的机器结果不合协议：' + v.errors.join('；'))
}
try {
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8')
} catch (e) {
  console.log(`❌ 机器结果落盘失败（${outPath}）：${e && e.message ? e.message : String(e)}`)
  process.exit(1)
}
if (failed || crashed || ctxDrift.length || !v.ok) process.exit(1)
