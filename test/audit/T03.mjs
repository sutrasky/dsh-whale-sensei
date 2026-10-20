#!/usr/bin/env node
/**
 * T03.mjs —— 写课在提交前完成全部硬校验（报告 B01 / P1）
 * ==================================================================
 * 验收判据（**原文**，见 cards/T03.md）：
 *   「遍历路径、绝对路径、未知点、坏配置、0/小数/负课次均拒绝，整个目录树内容和
 *     存在性完全不变；有效新课正常提交，已存在拒覆盖。」
 *
 * 怎么做才算「不是嘴上说」：
 *   - 每条判据都**真起子进程**驱动真实的 `whale_author` 工具（`lib/mods/author.js`），
 *     看它真的写了什么、真的没写什么 —— 不在本地重算一遍。
 *   - 每个用例的**完整 stdout/stderr/退出码/回执**都落到 `audit-evidence/T03/cases/`。
 *   - 拒写类断言一律**前后快照**：课程包整棵树（内容 + 存在性 + 目录）+ 兄弟目录
 *     sentinel 逐字节比对；只看返回值不算。
 *   - **负向控制**：先在自建临时副本上跑**基线实现**（`ba22c94` 的
 *     `lib/author.js` + `lib/mods/author.js`，其余 lib/ 不变），留下它真的逃逸 /
 *     真的写盘的原始输出；再证明新实现拒绝同一批输入。只改临时副本，只读快照永不碰。
 *   - 固定用例 ID 集合写在下面 `EXPECTED_IDS` 里：缺一条、多一条、重一条都算失败。
 *
 * ⚠️ 覆盖边界（如实写出来，不冒充）：
 *   · 「失败清理本次新建空目录」这一条：可移植地**造不出**"目录建成功、发布失败"的
 *     注入点（Windows 的目录只读位对创建文件无效；目标已存在会走"拒覆盖"那条早退）。
 *     所以它由两半覆盖：① 行为面 —— 父路径是文件时写失败、树一个字节没变、没有临时件
 *     （`T03-COMMIT-failure-no-partial`）；② 结构面 —— 清理循环确实在 catch 里
 *     （`T03-ORDER-hard-checks-before-write` 断言 `made.reverse()` + `rmdirSync`）。
 *   · 本卡只动"写课"这条路；HTTP 侧消费 `decodeRequestPath` 的读/服务面是 D01/D03
 *     （不在本卡范围），所以那条函数在这里是**单元级**判据。
 *   · **已知后果**：`test/rebuild-wiring.mjs` ⑦ 拿两个手工夹具包 + `point:'vue'`（包里没有
 *     这个点）验重建接线，正撞在本卡「未知点必须拒」这条上 ⇒ 那套由绿转红（5 条断言）。
 *     修法是把它的前置改成"先建点"（那个文件不在本卡落点，没有动它）。判据的边界**故意**
 *     钉在 `T03-REJECT-unknown-point-no-presets`：不许为了让那套变绿把"是不是课程包"的
 *     判据收窄成"有没有 presets 预设件"（那是拿产品判据换测试绿灯）。
 *
 * 用法：node E:/workplace/dsh-whale-sensei/test/audit/T03.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  createHarness, runChild, makeTempDir, cleanupTempDir, REPO, TEST_DIR, clip,
} from './harness.mjs'

/** 固定用例 ID 集合（**不许漂移**：改了这里就是改了验收面） */
const EXPECTED_IDS = [
  // ① 共享路径策略：唯一实现 + 三个函数的判据矩阵
  'T03-POLICY-single-source',
  'T03-POLICY-validate-id',
  'T03-POLICY-resolve-inside',
  'T03-POLICY-decode-request-path',
  // ② 结构：硬校验排在写盘之前；共享策略随模板发出去
  'T03-ORDER-hard-checks-before-write',
  'T03-TEMPLATE-registered',
  // ③ 拒绝面：非法路径 / 未知点 / 坏配置 / 坏课次 —— 整棵树一个字节都不变
  'T03-REJECT-traversal-halo',
  'T03-REJECT-traversal-point',
  'T03-REJECT-absolute-halo',
  'T03-REJECT-absolute-point',
  'T03-REJECT-unknown-point',
  'T03-REJECT-unknown-point-no-presets',
  'T03-REJECT-circle-mismatch',
  'T03-REJECT-ambiguous-point',
  'T03-REJECT-bad-config',
  'T03-REJECT-number-zero',
  'T03-REJECT-number-fraction',
  'T03-REJECT-number-negative',
  'T03-REJECT-number-over-max',
  'T03-REJECT-force-does-not-bypass',
  'T03-REJECT-sibling-sentinel-untouched',
  // ④ 挑战探针**只读**：拒写不顺手改 state
  'T03-PROBE-readonly-no-state',
  // ⑤ 合法提交：正常落盘 / 拒覆盖 / 失败不留半成品
  'T03-COMMIT-valid-new',
  'T03-COMMIT-no-overwrite',
  'T03-COMMIT-failure-no-partial',
  // ⑥ 负向控制：基线真被这些输入击穿（原始输出留证）
  'T03-NEGCTRL-baseline-traversal-escapes',
  'T03-NEGCTRL-baseline-number-zero-writes',
  'T03-NEGCTRL-baseline-probe-writes-state',
  'T03-NEGCTRL-new-rejects-what-baseline-let-through',
  // ⑦ 回归：T01 入口与统一裁判自检
  'T03-REG-t01-still-passes',
  'T03-REG-selftest-still-passes',
]

/** 基线 commit（cards/T03.md 钉的那一个）—— 负向控制取它的两个写课文件 */
const BASE_COMMIT = 'ba22c948016142482f92d054f033c7dec25f2f83'
/** 基线的两个写课文件（本卡只动这两处写课路径，其余 lib/ 与基线相同） */
const BASE_FILES = ['lib/author.js', 'lib/mods/author.js']
/** 回执标记：子进程只回一行机器可读 JSON（前面可能还有别的输出） */
const MARK = '<<<T03-RESULT>>>'

const NODE = process.execPath
const h = createHarness({ card: 'T03', expectedIds: EXPECTED_IDS, root: REPO })
// 证据目录的子目录要自己建（壳只保证 `audit-evidence/T03/` 在）
fs.mkdirSync(path.join(REPO, 'audit-evidence', 'T03', 'cases'), { recursive: true })

// ---------------------------------------------------------------- 小工具
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
const both = (r) => String(r?.out ?? '') + String(r?.err ?? '')

/** 整棵树快照：**内容 + 存在性**（目录也记，空目录也算） */
function snapTree(root) {
  const out = []
  const walk = (dir, rel) => {
    let es = []
    try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    es.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of es) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { out.push(`${r}|dir`); walk(abs, r) } else {
        let size = -1
        let digest = 'unreadable'
        try { const b = fs.readFileSync(abs); size = b.length; digest = sha(b) } catch { /* 读不动如实标 */ }
        out.push(`${r}|file|${size}|${digest}`)
      }
    }
  }
  walk(root, '')
  return out.join('\n')
}

/** 快照的**逐行差异**（只回变化，不把整棵树塞进失败消息） */
function treeDiff(before, after) {
  const b = new Set(String(before).split('\n'))
  const a = new Set(String(after).split('\n'))
  const added = [...a].filter((l) => !b.has(l))
  const removed = [...b].filter((l) => !a.has(l))
  return { added, removed, changed: [...added.map((l) => `+ ${l}`), ...removed.map((l) => `- ${l}`)] }
}

// ---------------------------------------------------------------- 沙箱与夹具
const SANDBOX = makeTempDir('dsh-whale-T03-sandbox')
const PACKS = path.join(SANDBOX, 'packs')
const PACK = path.join(PACKS, 'target')          // 主夹具课程包
const PACK_BAD = path.join(PACKS, 'badcfg')      // 坏配置夹具（point.json 写坏）
const PACK_BASE = path.join(PACKS, 'baseline')   // 负向控制用的同形夹具
const PACK_NO_PRESETS = path.join(PACKS, 'nopresets') // 同形夹具，但**没有** presets/whale-sensei.css
const ESCAPED = path.join(PACKS, 'escaped')      // 兄弟目录 sentinel（穿越的落点）
const SENTINEL = path.join(SANDBOX, 'sentinel-dir') // 包根**外面**的哨兵
const DRIVER_DIR = path.join(SANDBOX, 'driver')
const DRIVER = path.join(DRIVER_DIR, 'drive-author.mjs')
const BASE_PLUGIN = path.join(SANDBOX, 'plugin-baseline')

/** 某个包根 + 它的兄弟哨兵（拒写类断言比这一整块） */
const snapScope = (packRoot) => [
  `# pack ${path.basename(packRoot)}`,
  snapTree(packRoot),
  '# sentinel（包根之外）',
  snapTree(SENTINEL),
  '# sibling escaped（穿越的落点）',
  snapTree(ESCAPED),
  '# sibling styles（包旁的兄弟目录）',
  snapTree(path.join(PACKS, 'styles')),
].join('\n')

let F = null
try {
  F = await import(pathToFileURL(path.join(TEST_DIR, '_fixture.mjs')).href)
} catch (e) {
  h.block(`读不到 test/_fixture.mjs：${e && e.message ? e.message : String(e)}`)
}
let A = null
try {
  A = await import(pathToFileURL(path.join(REPO, 'lib', 'author.js')).href)
} catch (e) {
  h.block(`读不到 lib/author.js：${e && e.message ? e.message : String(e)}`)
}
let SCAFFOLD = null
try {
  SCAFFOLD = await import(pathToFileURL(path.join(REPO, 'lib', 'pack-scaffold.js')).href)
} catch (e) {
  h.block(`读不到 lib/pack-scaffold.js：${e && e.message ? e.message : String(e)}`)
}
let RULES = null
try {
  RULES = await import(pathToFileURL(path.join(TEST_DIR, 'pack-template-rules.mjs')).href)
} catch (e) {
  h.block(`读不到 test/pack-template-rules.mjs：${e && e.message ? e.message : String(e)}`)
}
let INTAKE = null
try {
  INTAKE = await import(pathToFileURL(path.join(REPO, 'lib', 'intake.js')).href)
} catch (e) {
  h.block(`读不到 lib/intake.js：${e && e.message ? e.message : String(e)}`)
}

const W = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8') }
const WJ = (file, obj) => W(file, JSON.stringify(obj, null, 2) + '\n')

/** 夹具用的合法大纲（缺 why 的节点会被大纲闸砍掉 —— 这里是**合法**的那一份） */
const PLAN = {
  goal: '交付一个能跑起来、访问得到接口的服务',
  nodes: [{
    no: 1, title: '第1课 起步', deliverable: '一个能跑起来、访问得到 /hello 的应用',
    criteria: '访问 /hello 有响应', why: '终点是交付服务 —— 先得让它跑起来',
    sources: [{ label: '夹具出处', url: 'https://example.invalid/plan' }],
  }],
}

/** 一门课的最小源文件（readPack 认得它 = "上一课"存在） */
const lessonSource = (number, title) => [
  '<script type="application/json" data-lesson-meta>',
  JSON.stringify({ title, number, navTitle: title, hintTerm: 'x', terms: {}, source: { label: '夹具出处', url: 'https://example.invalid/lesson' } }, null, 2),
  '</script>',
  '',
].join('\n')

/**
 * 铺一个夹具课程包（**只用仓内模板 + 本文件手写声明**，不读活包）。
 *
 * 三处**有意**的改动（都在夹具副本上，且写在注释里）：
 *   ① 摘掉两条重建脚本 —— 合法提交会自己起重建作业（真 spawn node 进程），
 *      而这一套只验"写课的硬校验"；rebuild-wiring 的判据是"全缺则不起作业"，
 *      摘掉两条 = 一次进程都不平白起，也不会有别的进程改这棵树。
 *   ② 加几个**只属于本夹具**的知识点（fresh / taken / nested / dup / gated）。
 *   ③ `nested` 的目录位故意被一个**同名文件**占着 —— 用来测"失败不留半成品"。
 */
function layPack(root) {
  if (!F) throw new Error('_fixture.mjs 没加载（材料缺失）')
  F.createFixture({ variant: 'multi-domain', root })
  for (const s of ['tools/build-lessons.js', 'tools/build-starmap.js']) fs.rmSync(path.join(root, s), { force: true })
  const addPoint = (circle, id, extra = {}) => WJ(path.join(root, 'lessons', circle, id, 'point.json'), {
    point: id, name: id, label: '', fileBase: 0, ...extra,
  })
  addPoint('math', 'fresh', { plan: PLAN })          // 合法提交的落点（干净点：没有课）
  addPoint('math', 'taken', { plan: PLAN })          // 目标文件**已存在** → 拒覆盖
  addPoint('math', 'nested', { plan: PLAN })         // 目录位被文件占着 → 写失败
  addPoint('math', 'gated', { plan: PLAN })          // 有上一课、没有快照 → 探针只读
  addPoint('math', 'dup')                            // 与下面的 dup 跨圈重名 → 不唯一
  addPoint('programming', 'dup')
  // 已存在的课（让 readPack 认得"上一课"）
  W(path.join(root, 'lessons', 'src', 'math', 'gated', '0001-gated.html'), lessonSource(1, '第1课 门禁'))
  W(path.join(root, 'lessons', 'src', 'math', 'taken', '0001-taken-first.html'), lessonSource(1, '第1课 已存在'))
  // 目录位被同名**文件**占着（nested 的落点要往它下面写）
  W(path.join(root, 'lessons', 'src', 'math', 'nested'), '这个位置故意是个文件（测失败清理）\n')
  // 摸底记录：用**真写入器**（手写 JSONL 容易写成多行 JSON，readIntake 按行读会读不到）
  if (!INTAKE) throw new Error('lib/intake.js 没加载（材料缺失）')
  for (const pt of ['fresh', 'taken', 'nested', 'gated']) {
    const r = INTAKE.recordIntake(root, { point: pt, level: '零基础', goal: '把服务跑起来' })
    if (!r.ok) throw new Error(`夹具：recordIntake(${pt}) 失败：${r.error}`)
  }
}

/** 驱动脚本：只做一件事 —— 用**指定插件根**跑一次 whale_author，回一行 JSON */
const DRIVER_SRC = `#!/usr/bin/env node
// 由 test/audit/T03.mjs 现场生成（属于本次夹具，不属于产品代码）
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const flag = (n) => { const p = '--' + n + '='; const hit = argv.find((a) => a.startsWith(p)); return hit === undefined ? null : hit.slice(p.length) }
const plugin = flag('plugin')
const root = flag('root')
const args = JSON.parse(flag('args') || '{}')

let mod = null
let tool = null
let err = null
try {
  mod = await import(pathToFileURL(path.join(plugin, 'lib', 'mods', 'author.js')).href)
  mod.plugin.install({ paths: { packRoot: root }, log: { info() {}, warn() {}, error() {} }, registerTool: (d) => { tool = d } })
} catch (e) { err = '装载失败：' + String(e && e.message ? e.message : e) }

let out = null
if (!err) {
  if (!tool) err = 'whale_author 没注册上'
  else {
    try { out = await tool.execute({ ...args, root }) } catch (e) { err = 'execute 抛了：' + String(e && e.message ? e.message : e) }
  }
}
const slim = out ? { ...out } : null
if (slim && typeof slim.text === 'string') {
  slim.text = { bytes: Buffer.byteLength(slim.text, 'utf8'), sha256: crypto.createHash('sha256').update(slim.text).digest('hex') }
}
process.stdout.write('${MARK}' + JSON.stringify({ err, result: slim }) + '\\n')
process.exit(0)
`

// ---------------------------------------------------------------- 铺夹具（只在 os.tmpdir 下）
layPack(PACK)
layPack(PACK_BASE)
fs.cpSync(PACK, PACK_BAD, { recursive: true })
W(path.join(PACK_BAD, 'lessons', 'math', 'fresh', 'point.json'), '{ 这不是 JSON（坏配置夹具）\n')
// 同形副本，但把"像课程包"的预设件摘掉 —— 用来钉"判据是 lessons/ 结构，不是这份预设"
fs.cpSync(PACK, PACK_NO_PRESETS, { recursive: true })
fs.rmSync(path.join(PACK_NO_PRESETS, 'presets', 'whale-sensei.css'), { force: true })
fs.mkdirSync(ESCAPED, { recursive: true })
W(path.join(ESCAPED, 'keep.txt'), 'sentinel：这个文件一个字节都不许变\n')
W(path.join(SENTINEL, 'keep.txt'), 'sentinel（包根之外）\n')
W(DRIVER, DRIVER_SRC)

// ---------------------------------------------------------------- 基线插件副本（负向控制）
const BASE_READY = (() => {
  try {
    fs.cpSync(path.join(REPO, 'lib'), path.join(BASE_PLUGIN, 'lib'), { recursive: true })
    W(path.join(BASE_PLUGIN, 'package.json'), JSON.stringify({ name: 't03-baseline', type: 'module' }, null, 2) + '\n')
    for (const rel of BASE_FILES) {
      const r = runChild(['git', '-C', REPO, 'show', `${BASE_COMMIT}:${rel}`], { cwd: REPO, timeoutMs: 60000 })
      if (r.code !== 0 || !String(r.out).trim()) {
        return { ok: false, error: `git show ${BASE_COMMIT}:${rel} 失败（exit=${r.code}）：${clip(both(r), 400)}` }
      }
      W(path.join(BASE_PLUGIN, rel), r.out)
    }
    // 反空转：拿到的必须**真的是**旧实现（否则下面的负向控制是空的）
    const same = BASE_FILES.filter((rel) => fs.readFileSync(path.join(BASE_PLUGIN, rel), 'utf8') === fs.readFileSync(path.join(REPO, rel), 'utf8'))
    if (same.length) return { ok: false, error: `基线副本与当前实现逐字节相同（负向控制会打空）：${same.join('、')}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `造基线副本失败：${e && e.message ? e.message : String(e)}` }
  }
})()
if (!BASE_READY.ok) h.block(`负向控制需要基线实现：${BASE_READY.error}`)

// ---------------------------------------------------------------- 驱动
/** 跑一次 whale_author（真子进程），带回执 + 原始输出 */
function runAuthor(pluginRoot, packRoot, args) {
  const r = runChild([NODE, DRIVER, `--plugin=${pluginRoot}`, `--root=${packRoot}`, `--args=${JSON.stringify(args)}`], {
    cwd: SANDBOX, timeoutMs: 180000,
  })
  const raw = both(r)
  const at = raw.indexOf(MARK)
  let parsed = null
  if (at >= 0) {
    const line = raw.slice(at + MARK.length).split('\n')[0]
    try { parsed = JSON.parse(line) } catch { parsed = null }
  }
  return { ...r, raw, parsed, result: parsed ? parsed.result : null, driverErr: parsed ? parsed.err : null }
}

/** 落一份子进程的**完整原始输出**（超长只留头尾，语义不裁） */
function keepEvidence(id, r, extra = {}) {
  const text = [
    `# ${id}`,
    `exit=${r.code === null ? 'null(无退出码/崩溃)' : r.code} timedOut=${r.timedOut} ms=${r.ms}`,
    `spawnError=${r.spawnError ?? 'none'}`,
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
    `--- 回执（机器可读） ---`,
    JSON.stringify(r.result ?? null, null, 1),
    `driverErr=${r.driverErr ?? 'none'}`,
    '--- stdout ---',
    String(r.out ?? ''),
    '--- stderr ---',
    String(r.err ?? ''),
    '',
  ].join('\n')
  h.evidence(path.join('cases', `${id}.txt`), clip(text, 40000))
}

/** 基线的常量参数（每次重新拼，免得被别处改过） */
const baseArgs = (extra = {}) => ({
  point: 'fresh', number: 1, title: '第一课：跑起来', slug: 'fresh-first',
  hintTerm: 'starter', source: { label: '夹具出处', url: 'https://example.invalid/legal' },
  commit: true, ...extra,
})

/**
 * 一条"必须被拒绝、且整棵树不变"的用例。
 * 快照 → 跑 → 再快照 → 逐字节比（内容 + 存在性 + 兄弟 sentinel）。
 */
function rejectCase(id, { packRoot = PACK, args, mustMatch = null, mustNotMatch = null, extraCheck = null } = {}) {
  const before = snapScope(packRoot)
  const r = runAuthor(REPO, packRoot, args)
  const after = snapScope(packRoot)
  const d = treeDiff(before, after)
  keepEvidence(id, r, { packRoot, args: JSON.stringify(args), treeChanged: d.changed.length })
  h.assert(r.code === 0, `驱动子进程要正常收场（exit=${r.code}；stderr=${clip(String(r.err), 300)}）`)
  h.assert(r.driverErr == null, `驱动不许自己出错（${r.driverErr}）`)
  h.assert(r.result != null, '必须拿到机器可读回执（缺标记 = 判不了，不按通过）')
  h.assert(r.result.ok === false, `必须拒绝（实得 ok=${JSON.stringify(r.result.ok)}）`)
  h.assert(r.result.wrote !== true, '不许写盘（wrote 不是 true）')
  if (mustMatch) h.assert(mustMatch.test(String(r.result.error || '')), `拒绝理由要点到 ${mustMatch}（实得：${r.result.error}）`)
  if (mustNotMatch) h.assert(!mustNotMatch.test(String(r.result.error || '')), `拒绝理由不该是 ${mustNotMatch}（实得：${r.result.error}）`)
  h.eq(d.changed.length, 0, `整棵树（内容 + 存在性 + 兄弟 sentinel）前后必须逐字节相同，实得变化：${clip(d.changed.join(' | '), 600)}`)
  if (extraCheck) extraCheck(r, d)
  return r
}

/** 树里有没有临时件残留（`.tmp-` 开头的那种） */
function tmpLeftovers(root) {
  const out = []
  const walk = (dir, rel) => {
    let es = []
    try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (/\.tmp-/.test(e.name)) out.push(r)
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
    }
  }
  walk(root, '')
  return out
}

// ================================================================ ① 共享路径策略
h.case('T03-POLICY-single-source', 'pass', () => {
  const policyRel = 'lib/pack-template/tools/path-policy.cjs'
  const policyAbs = path.join(REPO, policyRel)
  const authorSrc = fs.readFileSync(path.join(REPO, 'lib', 'author.js'), 'utf8')
  const modSrc = fs.readFileSync(path.join(REPO, 'lib', 'mods', 'author.js'), 'utf8')
  // 全仓（lib/）里谁定义了这三个函数 —— 写课这条路不许有自己的一份
  const defines = (name) => {
    const hits = []
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue }
        if (!/\.(js|cjs|mjs)$/.test(e.name)) continue
        const text = fs.readFileSync(path.join(dir, e.name), 'utf8')
        if (new RegExp(`function\\s+${name}\\s*\\(`).test(text)) hits.push(r)
      }
    }
    walk(path.join(REPO, 'lib'), 'lib')
    return hits
  }
  const vHits = defines('validateId')
  const rHits = defines('resolveInside')
  const dHits = defines('decodeRequestPath')
  h.evidence(path.join('cases', 'T03-POLICY-single-source.txt'), [
    `策略文件在？${fs.existsSync(policyAbs)}`,
    `validateId 的定义处：${vHits.join('、') || '（无）'}`,
    `resolveInside 的定义处：${rHits.join('、') || '（无）'}`,
    `decodeRequestPath 的定义处：${dHits.join('、') || '（无）'}`,
    `lib/author.js 从共享模块取？${/require_\(\s*['"]\.\/pack-template\/tools\/path-policy\.cjs['"]\s*\)/.test(authorSrc)}`,
    `lib/author.js 再导出三件？${/export const validateId = policy\.validateId/.test(authorSrc) && /export const resolveInside = policy\.resolveInside/.test(authorSrc) && /export const decodeRequestPath = policy\.decodeRequestPath/.test(authorSrc)}`,
    `写课模块自己定义 validateId？${/function\s+validateId\s*\(/.test(modSrc)}`,
    '',
  ].join('\n'))
  h.assert(fs.existsSync(policyAbs), `共享策略文件必须在：${policyRel}`)
  h.eq(rHits.join('、'), policyRel, `resolveInside 只能有一份实现（实得 ${rHits.join('、') || '无'}）`)
  h.eq(dHits.join('、'), policyRel, `decodeRequestPath 只能有一份实现（实得 ${dHits.join('、') || '无'}）`)
  // validateId 另有一处**历史**实现（建圈 / 建点入口 lib/mods/create.js，不在本卡写范围）——
  // 这里钉的是"形状口径一致"，不是"假装它不存在"。
  const allowed = new Set([policyRel, 'lib/mods/create.js'])
  h.assert(vHits.every((r) => allowed.has(r)), `validateId 的实现只许在共享策略与建点入口（实得 ${vHits.join('、')}）`)
  const ID_RE = '/^[a-z][a-z0-9-]*$/'
  const createSrc = fs.readFileSync(path.join(REPO, 'lib', 'mods', 'create.js'), 'utf8')
  h.assert(fs.readFileSync(policyAbs, 'utf8').includes(ID_RE), '共享策略里的 id 形状就是仓里那一份')
  h.assert(createSrc.includes(ID_RE), '建点入口的 id 形状与共享策略**同一串**（口径不许漂）')
  h.assert(/export const validateId = policy\.validateId/.test(authorSrc), 'lib/author.js 必须再导出共享的 validateId')
  h.assert(/require_\(\s*['"]\.\/pack-template\/tools\/path-policy\.cjs['"]\s*\)/.test(authorSrc), 'lib/author.js 必须从共享模块取（不是自己写一份）')
  h.eq(/function\s+validateId\s*\(/.test(modSrc), false, '写课模块不许自己定义 validateId')
})

h.case('T03-POLICY-validate-id', 'pass', () => {
  const { validateId } = A
  const ok = ['math', 'programming', 'spring-boot', 'a', 'a1', 'a-b-c', 'x'.repeat(64)]
  const bad = ['', ' ', 'Math', 'A', 'a_b', 'a.b', 'a b', '../x', '..', '.', 'a/b', 'a\\b', '/abs',
    'C:/x', 'C:\\x', '\\\\server\\share', '-a', '1a', 'a\u0000b', 'x'.repeat(65), 123, null, undefined, {}, ['a']]
  const rows = []
  const badAccepted = []
  for (const v of ok) { const e = validateId(v); rows.push(`OK  ${JSON.stringify(v)} -> ${e === null ? 'null' : e}`); if (e !== null) badAccepted.push(v) }
  const okRejected = []
  for (const v of bad) { const e = validateId(v); rows.push(`BAD ${JSON.stringify(v)} -> ${e === null ? 'null(!!)' : '拒绝'}`); if (e === null) okRejected.push(v) }
  h.evidence(path.join('cases', 'T03-POLICY-validate-id.txt'), rows.join('\n') + '\n')
  h.eq(badAccepted.join('、'), '', `合法 id 不许被拒（实得被拒：${badAccepted.join('、')}）`)
  h.eq(okRejected.map((v) => JSON.stringify(v)).join('、'), '', `非法 id 一个都不许放行（实得放行：${okRejected.map((v) => JSON.stringify(v)).join('、')}）`)
})

h.case('T03-POLICY-resolve-inside', 'pass', () => {
  const { resolveInside } = A
  const rows = []
  const good = resolveInside(PACK, 'lessons/src/math/fresh/0001-x.html', {})
  const mustExist = resolveInside(PACK, 'lessons/src/math/fresh/0001-x.html', { mustExist: true })
  const rootSelf = resolveInside(PACK, '.', { allowRoot: true })
  const escapes = {
    dotdot: resolveInside(PACK, '../outside.html', {}),
    deep: resolveInside(PACK, 'lessons/src/../../../outside.html', {}),
    absolute: resolveInside(PACK, 'C:/Windows/win.ini', {}),
    posixAbs: resolveInside(PACK, '/etc/passwd', {}),
    backslash: resolveInside(PACK, 'lessons\\src\\x.html', {}),
    nul: resolveInside(PACK, 'lessons/src/a\u0000b.html', {}),
    empty: resolveInside(PACK, '', {}),
    noRoot: resolveInside(path.join(PACK, 'nope-dir'), 'a.html', {}),
  }
  // 真身边界：包内一个**目录联接**指向包外 —— 字符串上看不出任何问题，必须靠 realpath 拦
  const linkTarget = path.join(SANDBOX, 'link-target')
  fs.mkdirSync(linkTarget, { recursive: true })
  const linkPath = path.join(PACK, 'lessons', 'src', 'link-out')
  let linkMade = false
  try { if (!fs.existsSync(linkPath)) fs.symlinkSync(linkTarget, linkPath, 'junction'); linkMade = fs.existsSync(linkPath) } catch { linkMade = false }
  const viaLink = linkMade ? resolveInside(PACK, 'lessons/src/link-out/evil.html', {}) : null
  rows.push(`good=${JSON.stringify(good)}`, `mustExist=${JSON.stringify(mustExist)}`, `rootSelf=${JSON.stringify(rootSelf)}`)
  for (const [k, v] of Object.entries(escapes)) rows.push(`${k}=${JSON.stringify(v)}`)
  rows.push(`linkMade=${linkMade}`, `viaLink=${JSON.stringify(viaLink)}`)
  h.evidence(path.join('cases', 'T03-POLICY-resolve-inside.txt'), rows.join('\n') + '\n')
  h.assert(good.ok === true, `根内的相对路径要能解出来（${JSON.stringify(good)}）`)
  h.assert(path.isAbsolute(good.abs) && good.abs.startsWith(PACK + path.sep), '解出来的必须是根内的绝对路径')
  h.eq(mustExist.ok, false, 'mustExist:true 时落点不存在 → 拒')
  h.assert(/不存在/.test(mustExist.error), `不存在要给一句能读的话（${mustExist.error}）`)
  h.assert(rootSelf.ok === true && path.resolve(rootSelf.abs) === path.resolve(PACK), 'allowRoot 时 `.` 指向根本身')
  for (const k of ['dotdot', 'deep', 'absolute', 'posixAbs', 'backslash', 'nul', 'empty']) {
    h.assert(escapes[k].ok === false, `${k} 必须拒（实得 ${JSON.stringify(escapes[k])}）`)
  }
  h.assert(escapes.noRoot.ok === false && /根不存在/.test(escapes.noRoot.error), '根不存在 → 拒（写盘的前提）')
  h.assert(linkMade, '本机要能造目录联接（Windows 用 junction，无需管理员）—— 造不出来这条判据就是空的')
  h.assert(viaLink && viaLink.ok === false, `软链 / 目录联接带出根外必须拒（实得 ${JSON.stringify(viaLink)}）`)
  h.assert(viaLink && /之外/.test(viaLink.error), `软链逃逸的理由要说明白（${viaLink && viaLink.error}）`)
  fs.rmSync(linkPath, { force: true, recursive: true })
})

h.case('T03-POLICY-decode-request-path', 'pass', () => {
  const { decodeRequestPath } = A
  const rows = []
  const accepts = [
    ['/lessons/src/a/b.html?x=1#f', 'lessons/src/a/b.html'],
    ['/a/b/', 'a/b'],
    ['a//b', 'a/b'],
    ['/./a/./b', 'a/b'],
    ['/', ''],
  ]
  const rejects = ['/a/%2e%2e%2fetc', '/../x', '/a/..', '/C:/Windows/win.ini', '/a/%5C..%5Cb', '/a/b%00.html', '/a/%zz', '', null]
  const bad = []
  for (const [input, want] of accepts) {
    const r = decodeRequestPath(input)
    rows.push(`OK  ${JSON.stringify(input)} -> ${JSON.stringify(r)}`)
    if (!r.ok || r.rel !== want) bad.push(`${JSON.stringify(input)} 期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(r)}`)
  }
  const leaked = []
  for (const input of rejects) {
    const r = decodeRequestPath(input)
    rows.push(`BAD ${JSON.stringify(input)} -> ${JSON.stringify(r)}`)
    if (r.ok) leaked.push(JSON.stringify(input))
  }
  h.evidence(path.join('cases', 'T03-POLICY-decode-request-path.txt'), rows.join('\n') + '\n')
  h.eq(bad.join('；'), '', `正常请求路径要解对（${bad.join('；')}）`)
  h.eq(leaked.join('、'), '', `穿越 / 绝对 / 反斜杠 / NUL / 坏编码一个都不许放行（实得放行：${leaked.join('、')}）`)
  h.assert(decodeRequestPath('/a/%2e%2e%2fetc').error.includes('..'), '编码过的 `..` 解出来之后仍按穿越拒（只解一次，不是不解）')
})

// ================================================================ ② 结构
h.case('T03-ORDER-hard-checks-before-write', 'pass', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'mods', 'author.js'), 'utf8')
  // ⚠️ 次序要按**执行体**里的位置比：`publishLesson` 是函数声明，住在文件更上面，
  //    拿全文的 indexOf 比会把"函数定义在哪儿"当成"什么时候跑"（本卡第一版就踩了）。
  const at = src.indexOf('async execute(args = {})')
  const body = at >= 0 ? src.slice(at) : ''
  const idx = (s) => body.indexOf(s)
  const order = {
    inspectPack: idx('const insp = inspectPack('),
    checkInput: idx('const schema = checkInput('),
    planGate: idx('planGate(pt.plan'),
    challengeGate: idx('challengeGate({ root, pack, point: gatePoint, probe: false })'),
    authorLesson: idx('a = authorLesson({'),
    validateSkeleton: idx('const v = validateSkeleton(a.text)'),
    publishLesson: idx('const pub = publishLesson('),
  }
  const iMkdirInPublish = src.indexOf('fs.mkdirSync(d)')
  const iPublishDef = src.indexOf('function publishLesson(')
  h.evidence(path.join('cases', 'T03-ORDER-hard-checks-before-write.txt'), [
    `执行体起点=${at}`,
    `次序（执行体里的位置）：${JSON.stringify(order)}`,
    `publishLesson 定义在 ${iPublishDef} / 里面的 mkdirSync 在 ${iMkdirInPublish}`,
    `旧写法还在吗（fs.writeFileSync(abs, a.text)）：${/fs\.writeFileSync\(\s*abs\s*,\s*a\.text/.test(src)}`,
    `临时件 + 独占发布：${/\.tmp-\$\{process\.pid\}/.test(src) && /COPYFILE_EXCL/.test(src)}`,
    `失败清理本次新建空目录：${/made\.reverse\(\)/.test(src) && /fs\.rmdirSync\(/.test(src)}`,
    `硬校验被 force 挡着吗（commit 分支里直接 inspectPack）：${/if \(commit\) \{\s*\n\s*const insp = inspectPack\(/.test(src)}`,
    `教学闸才看 force：${/commit && !force && declared/.test(src)}`,
    `生成之后还有一次路径复核：${/const inside = resolveInside\(root, rel/.test(src)}`,
    '',
  ].join('\n'))
  h.assert(at >= 0, '源码里必须有 execute 执行体')
  for (const [k, v] of Object.entries(order)) h.assert(v >= 0, `执行体里必须找得到 ${k}（实得 ${v}）`)
  const seq = ['inspectPack', 'checkInput', 'planGate', 'challengeGate', 'authorLesson', 'validateSkeleton', 'publishLesson']
  const increasing = seq.every((k, i) => i === 0 || order[seq[i - 1]] < order[k])
  h.assert(increasing, `次序必须是 解析包→点/圈→schema→大纲→教学闸→生成→验证→独占新建（实得 ${JSON.stringify(order)}）`)
  h.assert(iPublishDef >= 0 && iPublishDef < iMkdirInPublish, '目录是在 publishLesson 里建的（不是别处顺手 mkdir）')
  h.eq(/fs\.writeFileSync\(\s*abs\s*,\s*a\.text/.test(src), false, 'B01 那条"直接写正式文件"的写法必须已经不在')
  h.assert(/\.tmp-\$\{process\.pid\}/.test(src), '发布前必须先写**同目录唯一临时文件**')
  h.assert(/COPYFILE_EXCL/.test(src), '发布必须是不覆盖的（COPYFILE_EXCL）')
  h.assert(/made\.reverse\(\)/.test(src) && /fs\.rmdirSync\(/.test(src), '失败要清理本次新建的空目录（自底向上、只删空的）')
  h.assert(/if \(commit\) \{\s*\n\s*const insp = inspectPack\(/.test(src), '解析包 / 点圈 不许被 force 或别的条件挡住')
  h.assert(/commit && !force && declared/.test(src), '只有**教学闸**看 force（硬校验不看）')
  h.assert(/const inside = resolveInside\(root, rel/.test(src), '生成完之后发布前还要再解一次路径（边界不许只有一处）')
})

h.case('T03-TEMPLATE-registered', 'pass', () => {
  const rel = 'tools/path-policy.cjs'
  const inRuntime = SCAFFOLD.TEMPLATE_FILES.includes(rel)
  const inRules = RULES.templatePaths().includes(rel)
  const a = [...SCAFFOLD.TEMPLATE_FILES].sort().join('\n')
  const b = [...RULES.templatePaths()].sort().join('\n')
  const tplAbs = path.join(SCAFFOLD.TEMPLATE_DIR, rel)
  const text = fs.existsSync(tplAbs) ? fs.readFileSync(tplAbs, 'utf8') : ''
  const DRIVE = /(?<![A-Za-z])[A-Za-z]:[\\/][^\s'"`)]*/g
  const SYSTEM_OK = /^[A-Za-z]:\\{1,2}(Program|Windows)\b/i
  const driveHits = [...text.matchAll(DRIVE)].map((m) => m[0]).filter((m) => !SYSTEM_OK.test(m))
  h.evidence(path.join('cases', 'T03-TEMPLATE-registered.txt'), [
    `TEMPLATE_FILES 里有？${inRuntime}（共 ${SCAFFOLD.TEMPLATE_FILES.length} 项）`,
    `templatePaths() 里有？${inRules}（共 ${RULES.templatePaths().length} 项）`,
    `两份清单一致？${a === b}`,
    `模板件在盘上？${fs.existsSync(tplAbs)}`,
    `模板件里的机器专属路径：${driveHits.length ? driveHits.join('、') : '（无）'}`,
    `模板件里有 workplace / dsh-raw-html-v2？${/workplace|dsh-raw-html-v2/i.test(text)}`,
    '',
  ].join('\n'))
  h.assert(inRuntime, `运行时清单（lib/pack-scaffold.js 的 TEMPLATE_FILES）必须有 ${rel}`)
  h.assert(inRules, `规则清单（test/pack-template-rules.mjs 的 templatePaths）必须有 ${rel}`)
  h.eq(a === b, true, '两份清单不许漂（新建的包才拿得到这件）')
  h.assert(fs.existsSync(tplAbs), `模板件必须在盘上：${tplAbs}`)
  h.eq(driveHits.length, 0, `模板件里不许有机器专属路径（实得 ${driveHits.join('、') || '无'}）`)
  h.eq(/workplace|dsh-raw-html-v2/i.test(text), false, '模板件里不许出现作者机器的目录名 / 兄弟仓名')
})

// ================================================================ ③ 拒绝面
h.case('T03-REJECT-traversal-halo', 'pass', () => {
  rejectCase('T03-REJECT-traversal-halo', {
    args: baseArgs({ halo: '../../../escaped' }),
    mustMatch: /halo|id 不合法|路径/,
  })
})

h.case('T03-REJECT-traversal-point', 'pass', () => {
  rejectCase('T03-REJECT-traversal-point', {
    args: baseArgs({ point: '../../escaped' }),
    mustMatch: /point|id 不合法|路径/,
  })
})

h.case('T03-REJECT-absolute-halo', 'pass', () => {
  rejectCase('T03-REJECT-absolute-halo', { args: baseArgs({ halo: 'C:/Windows' }), mustMatch: /halo|id 不合法/ })
})

h.case('T03-REJECT-absolute-point', 'pass', () => {
  rejectCase('T03-REJECT-absolute-point', { args: baseArgs({ point: 'C:\\Windows\\Temp' }), mustMatch: /point|id 不合法/ })
})

h.case('T03-REJECT-unknown-point', 'pass', () => {
  rejectCase('T03-REJECT-unknown-point', {
    args: baseArgs({ point: 'no-such-point' }),
    mustMatch: /未知知识点/,
  })
})

h.case('T03-REJECT-unknown-point-no-presets', 'pass', () => {
  // ⚠️ 这条**故意钉死判据的边界**（不许以后悄悄放松）：判"是不是课程包"用的是
  //    **有 `lessons/`**（结构声明），不是"有 presets/whale-sensei.css"。
  //    理由：写错目录的代价与有没有那份预设无关 —— 只要目录里已经有知识点登记表，
  //    请求一个不在册的点就是**结构错**，写下去 readPack 会把它当孤儿跳过（假进度）。
  //    （`test/rebuild-wiring.mjs` ⑦ 用两个手工夹具包 + `point:'vue'`（包里没这个点）
  //      去验重建接线，正好撞在这条上 —— 那是**旧测试的假设失效**，不是这里该放松。）
  const half = path.join(PACKS, 'half-built')
  fs.rmSync(half, { recursive: true, force: true })
  W(path.join(half, 'lessons', 'math', 'halo.json'), JSON.stringify({ halo: 'math', name: '数学' }, null, 2) + '\n')
  const rows = []
  // ① 有登记表、但没有这个点（fixture 的副本，去掉 presets/whale-sensei.css）
  const r1 = rejectCase('T03-REJECT-unknown-point-no-presets', {
    packRoot: PACK_NO_PRESETS,
    args: baseArgs({ point: 'no-such-point' }),
    mustMatch: /未知知识点/,
  })
  rows.push(`① 无 presets、有登记表：${r1.result?.error}`)
  // ② 连知识点都还没有（只有圈）—— 同样拒（不猜归属）
  const before = snapScope(half)
  const r2 = runAuthor(REPO, half, baseArgs({ point: 'vue' }))
  const d2 = treeDiff(before, snapScope(half))
  rows.push(`② 只有圈、没有点：ok=${r2.result?.ok} error=${r2.result?.error}`, `树变化=${d2.changed.join(' | ') || '（无）'}`)
  h.evidence(path.join('cases', 'T03-REJECT-unknown-point-no-presets-extra.txt'), rows.join('\n') + '\n')
  h.assert(r2.result != null && r2.result.ok === false && r2.result.wrote !== true, `只有圈的半成品目录里，未知点也要拒（实得 ok=${r2.result?.ok} wrote=${r2.result?.wrote}）`)
  h.assert(/未知知识点/.test(String(r2.result.error || '')), `理由要点到"未知知识点"（实得：${r2.result.error}）`)
  h.eq(d2.changed.length, 0, `拒写时树一个字节不变（实得 ${d2.changed.join(' | ')}）`)
})

h.case('T03-REJECT-circle-mismatch', 'pass', () => {
  rejectCase('T03-REJECT-circle-mismatch', {
    args: baseArgs({ point: 'spring-boot', halo: 'math', slug: 'mismatch' }),
    mustMatch: /对不上/,
  })
})

h.case('T03-REJECT-ambiguous-point', 'pass', () => {
  // 两侧都要证：不给 halo → 拒（不唯一）；给了 halo → **不再因为"不唯一"被拒**
  // （`dup` 故意没有地图，所以给了 halo 之后接棒的是大纲闸 —— 这正是"过了唯一性"的证据）
  const r1 = rejectCase('T03-REJECT-ambiguous-point', {
    args: baseArgs({ point: 'dup', slug: 'dup-a' }),
    mustMatch: /唯一识别|都有/,
  })
  const before = snapScope(PACK)
  const r2 = runAuthor(REPO, PACK, baseArgs({ point: 'dup', halo: 'math', slug: 'dup-b' }))
  const d2 = treeDiff(before, snapScope(PACK))
  h.evidence(path.join('cases', 'T03-REJECT-ambiguous-point.txt'), [
    '--- 不给 halo（必须按"不唯一"拒） ---',
    String(r1.result?.error ?? ''),
    '--- 给了 halo（必须过了唯一性，改由大纲闸接棒） ---',
    `ok=${r2.result?.ok} needsPlan=${r2.result?.needsPlan} error=${r2.result?.error}`,
    `树变化：${d2.changed.join(' | ') || '（无）'}`,
    '',
  ].join('\n'))
  h.assert(r2.result != null, '给了 halo 那一次也要拿到回执')
  h.eq(r2.result.needsPlan, true, `给了 halo 之后必须过了"唯一识别"（接棒的是大纲闸，实得 ${JSON.stringify({ ok: r2.result.ok, needsPlan: r2.result.needsPlan, error: r2.result.error })}）`)
  h.assert(!/唯一识别|都有/.test(String(r2.result.error || '')), '给了 halo 就不该再拿"不唯一"当理由')
  h.eq(d2.changed.length, 0, `被大纲闸拒时树也要一个字节不变（实得 ${d2.changed.join(' | ')}）`)
})

h.case('T03-REJECT-bad-config', 'pass', () => {
  rejectCase('T03-REJECT-bad-config', {
    packRoot: PACK_BAD,
    args: baseArgs({ slug: 'badcfg' }),
    mustMatch: /配置坏|读不动/,
  })
})

h.case('T03-REJECT-number-zero', 'pass', () => {
  rejectCase('T03-REJECT-number-zero', { args: baseArgs({ number: 0 }), mustMatch: /number/ })
})

h.case('T03-REJECT-number-fraction', 'pass', () => {
  rejectCase('T03-REJECT-number-fraction', { args: baseArgs({ number: 2.5 }), mustMatch: /number/ })
})

h.case('T03-REJECT-number-negative', 'pass', () => {
  rejectCase('T03-REJECT-number-negative', { args: baseArgs({ number: -1 }), mustMatch: /number/ })
})

h.case('T03-REJECT-number-over-max', 'pass', () => {
  rejectCase('T03-REJECT-number-over-max', { args: baseArgs({ number: 10000 }), mustMatch: /number/ })
})

h.case('T03-REJECT-force-does-not-bypass', 'pass', () => {
  // force 只绕教学闸；路径 / 结构 / schema 三条硬校验它一条都绕不过
  const rows = []
  const cases = [
    ['traversal', baseArgs({ halo: '../../../escaped', force: true }), /halo|id 不合法|路径/],
    ['absolute', baseArgs({ point: 'C:\\Windows\\Temp', force: true }), /point|id 不合法/],
    ['unknown-point', baseArgs({ point: 'no-such-point', force: true }), /未知知识点/],
    ['number-zero', baseArgs({ number: 0, force: true }), /number/],
    ['bad-config', baseArgs({ slug: 'badcfg-force', force: true }), /配置坏|读不动/],
  ]
  for (const [name, args, re] of cases) {
    const packRoot = name === 'bad-config' ? PACK_BAD : PACK
    const before = snapScope(packRoot)
    const r = runAuthor(REPO, packRoot, args)
    const d = treeDiff(before, snapScope(packRoot))
    rows.push(`## ${name}`, `args=${JSON.stringify(args)}`, `ok=${r.result?.ok} wrote=${r.result?.wrote} error=${r.result?.error}`, `树变化=${d.changed.join(' | ') || '（无）'}`, '')
    h.evidence(path.join('cases', `T03-REJECT-force-does-not-bypass-${name}.txt`), clip(r.raw, 20000))
    h.assert(r.result != null, `${name}：要拿到回执`)
    h.assert(r.result.ok === false && r.result.wrote !== true, `${name}：force 也必须是拒绝且不写盘（实得 ok=${r.result.ok} wrote=${r.result.wrote}）`)
    h.assert(re.test(String(r.result.error || '')), `${name}：拒绝理由要点到 ${re}（实得：${r.result.error}）`)
    h.eq(d.changed.length, 0, `${name}：树必须一个字节不变（实得 ${d.changed.join(' | ')}）`)
  }
  h.evidence(path.join('cases', 'T03-REJECT-force-does-not-bypass.txt'), rows.join('\n'))
})

h.case('T03-REJECT-sibling-sentinel-untouched', 'pass', () => {
  // 兄弟目录 sentinel 的**逐字节**比对（穿越的落点就在那儿）
  const sentinelFiles = [path.join(ESCAPED, 'keep.txt'), path.join(SENTINEL, 'keep.txt')]
  const beforeBytes = sentinelFiles.map((f) => fs.readFileSync(f))
  const beforeTree = snapTree(ESCAPED)
  const r1 = runAuthor(REPO, PACK, baseArgs({ halo: '../../../escaped', slug: 'sentinel-a' }))
  const r2 = runAuthor(REPO, PACK, baseArgs({ point: '../../escaped', slug: 'sentinel-b' }))
  const afterBytes = sentinelFiles.map((f) => fs.readFileSync(f))
  const afterTree = snapTree(ESCAPED)
  h.evidence(path.join('cases', 'T03-REJECT-sibling-sentinel-untouched.txt'), [
    `sentinel 文件：${sentinelFiles.join('、')}`,
    `字节相同？${beforeBytes.every((b, i) => b.equals(afterBytes[i]))}`,
    `兄弟目录树相同？${beforeTree === afterTree}`,
    `两次回执：${JSON.stringify([r1.result?.ok, r2.result?.ok])}`,
    '',
  ].join('\n'))
  h.assert(r1.result?.ok === false && r2.result?.ok === false, '两次穿越尝试都必须被拒')
  h.assert(beforeBytes.every((b, i) => b.equals(afterBytes[i])), 'sentinel 文件必须**逐字节**不变')
  h.eq(afterTree, beforeTree, '兄弟目录（穿越的落点）整棵树必须不变')
  h.eq(fs.readdirSync(ESCAPED).sort().join(','), 'keep.txt', `兄弟目录里只许有那个 sentinel（实得 ${fs.readdirSync(ESCAPED).sort().join(',')}）`)
})

// ================================================================ ④ 挑战探针只读
h.case('T03-PROBE-readonly-no-state', 'pass', () => {
  // `gated` 有上一课、包里**没有**判据快照 → 老实现会 probe:true 重判并**写回 state.json**；
  // 新实现必须 probe:false（只读判定）：拒写，且一个字节都不写。
  const stateAbs = path.join(PACK, 'learning-records', 'state.json')
  const before = snapScope(PACK)
  h.assert(!fs.existsSync(stateAbs), '前置：这个夹具里本来没有判据快照（否则这条判据是空的）')
  const r = runAuthor(REPO, PACK, baseArgs({ point: 'gated', number: 2, slug: 'gated-second' }))
  const d = treeDiff(before, snapScope(PACK))
  keepEvidence('T03-PROBE-readonly-no-state', r, { stateAbs, treeChanged: d.changed.length })
  h.assert(r.result != null && r.result.ok === false, `必须拒绝（实得 ${JSON.stringify(r.result && r.result.ok)}）`)
  h.eq(r.result.needsChallenge, true, '拒绝的理由必须是"上一课挑战"那道闸')
  h.eq(r.result.challenge?.code, 'no-snapshot', `判词要与门禁同源（实得 ${r.result.challenge?.code}）`)
  h.eq(fs.existsSync(stateAbs), false, '拒写**不许**顺手把 learning-records/state.json 写出来（探针只读）')
  h.eq(d.changed.length, 0, `整棵树必须一个字节不变（实得 ${d.changed.join(' | ')}）`)
})

// ================================================================ ⑤ 合法提交
h.case('T03-COMMIT-valid-new', 'pass', () => {
  const args = baseArgs({ slug: 'fresh-first' })
  const expected = A.authorLesson({
    halo: 'math', point: 'fresh', number: 1, title: args.title, slug: args.slug,
    hintTerm: args.hintTerm, source: args.source, minutes: undefined, terms: undefined,
  })
  const before = snapScope(PACK)
  const r = runAuthor(REPO, PACK, args)
  const after = snapScope(PACK)
  const d = treeDiff(before, after)
  const abs = path.join(PACK, ...expected.file.split('/'))
  keepEvidence('T03-COMMIT-valid-new', r, { expectedFile: expected.file, treeAdded: d.changed.join(' | ') })
  h.assert(r.result != null, '要拿到回执')
  h.assert(r.result.ok === true && r.result.wrote === true, `合法新课必须正常提交（实得 ok=${r.result?.ok} wrote=${r.result?.wrote} error=${r.result?.error}）`)
  h.eq(r.result.file, expected.file, '落点与 authorLesson 给的相对路径一致')
  h.assert(fs.existsSync(abs), `文件必须真的在盘上：${expected.file}`)
  h.eq(fs.readFileSync(abs, 'utf8'), expected.text, '写下去的必须**逐字节**是生成的那份文本')
  h.eq(tmpLeftovers(PACK).join('、'), '', '不许留临时件（.tmp-*）')
  // 树变化必须**只有**这一门课（目录 + 文件），没有别的副作用
  h.eq(d.removed.length, 0, `只许增不许减（实得被删：${d.removed.join(' | ')}）`)
  const wantAdded = [
    `lessons/src/math/fresh|dir`,
    `lessons/src/math/fresh/${path.basename(expected.file)}|file|${Buffer.byteLength(expected.text, 'utf8')}|${sha(Buffer.from(expected.text, 'utf8'))}`,
  ].sort()
  h.eq(d.added.slice().sort().join(' | '), wantAdded.join(' | '), '树里多出来的必须恰好是这门课（目录 + 文件）')
})

h.case('T03-COMMIT-no-overwrite', 'pass', () => {
  // 目标文件已经在了：**拒覆盖**，而且一个字节都不许动（连目录都不建）
  const rel = 'lessons/src/math/taken/0001-taken-first.html'
  const abs = path.join(PACK, ...rel.split('/'))
  const beforeBytes = fs.readFileSync(abs)
  const before = snapScope(PACK)
  // force:true 把教学闸让开，让"已存在"成为**唯一**的拒绝理由
  const r = runAuthor(REPO, PACK, baseArgs({ point: 'taken', slug: 'taken-first', force: true }))
  const d = treeDiff(before, snapScope(PACK))
  keepEvidence('T03-COMMIT-no-overwrite', r, { rel, treeChanged: d.changed.join(' | ') })
  h.assert(r.result != null && r.result.ok === false, `已存在必须拒绝（实得 ok=${r.result?.ok}）`)
  h.assert(/拒绝覆盖/.test(String(r.result.error || '')), `理由要点到"拒绝覆盖"（实得：${r.result.error}）`)
  h.eq(r.result.wrote, undefined, '被拒时不许说 wrote')
  h.assert(fs.readFileSync(abs).equals(beforeBytes), '已存在的那份文件必须**逐字节**不变')
  h.eq(d.changed.length, 0, `整棵树必须一个字节不变（实得 ${d.changed.join(' | ')}）`)
  h.eq(tmpLeftovers(PACK).join('、'), '', '不许留临时件')
})

h.case('T03-COMMIT-failure-no-partial', 'pass', () => {
  // 落点的目录位被一个同名**文件**占着 → 写失败；失败之后不许留半成品（临时件 / 新目录）
  const nested = path.join(PACK, 'lessons', 'src', 'math', 'nested')
  h.assert(fs.statSync(nested).isFile(), '前置：这个夹具里 nested 的目录位是个文件')
  const before = snapScope(PACK)
  const r = runAuthor(REPO, PACK, baseArgs({ point: 'nested', slug: 'nested-first' }))
  const d = treeDiff(before, snapScope(PACK))
  keepEvidence('T03-COMMIT-failure-no-partial', r, { nested, treeChanged: d.changed.join(' | ') })
  h.assert(r.result != null && r.result.ok === false, `写不动时必须如实拒绝（实得 ok=${r.result?.ok}）`)
  h.assert(/写不动|拒绝/.test(String(r.result.error || '')), `要明说写不动（实得：${r.result.error}）`)
  h.eq(r.result.wrote, undefined, '没写成就不许说 wrote')
  h.eq(d.changed.length, 0, `失败之后整棵树必须一个字节不变（实得 ${d.changed.join(' | ')}）`)
  h.eq(tmpLeftovers(PACK).join('、'), '', '失败不许留临时件')
  h.assert(fs.statSync(nested).isFile(), '占位的那个文件不许被动过')
})

// ================================================================ ⑥ 负向控制（基线真的被击穿）
h.case('T03-NEGCTRL-baseline-traversal-escapes', 'pass', () => {
  const before = snapTree(ESCAPED)
  const r = runAuthor(BASE_PLUGIN, PACK_BASE, baseArgs({ point: 'fresh', halo: '../../../escaped', slug: 'esc', force: true }))
  const after = snapTree(ESCAPED)
  const d = treeDiff(before, after)
  keepEvidence('T03-NEGCTRL-baseline-traversal-escapes', r, { plugin: BASE_PLUGIN, treeAdded: d.added.join(' | ') })
  h.assert(r.result != null, '基线那一次也要拿到回执')
  h.assert(r.result.ok === true && r.result.wrote === true,
    `基线必须**真的**把课写到包根之外（实得 ok=${r.result?.ok} wrote=${r.result?.wrote} file=${r.result?.file}）`)
  h.assert(/\.\.\//.test(String(r.result.file || '')), `基线给的相对路径里必须带着穿越（实得 ${r.result.file}）`)
  h.assert(d.added.length > 0, `兄弟目录里必须真的多出东西（基线逃逸的证据，实得 ${d.added.join(' | ') || '无'}）`)
  h.assert(!fs.existsSync(path.join(PACK_BASE, 'lessons', 'src', 'esc')), '基线那门课**不在**包内（它是写出去的，不是写进来的）')
})

h.case('T03-NEGCTRL-baseline-number-zero-writes', 'pass', () => {
  const r = runAuthor(BASE_PLUGIN, PACK_BASE, baseArgs({ point: 'fresh', number: 0, slug: 'zero', force: true }))
  const written = r.result && r.result.file ? path.join(PACK_BASE, ...String(r.result.file).split('/')) : null
  keepEvidence('T03-NEGCTRL-baseline-number-zero-writes', r, { written })
  h.assert(r.result != null, '基线那一次也要拿到回执')
  h.eq(r.result.ok, false, '基线对 number:0 会回 ok:false（"调用失败"）')
  h.eq(r.result.wrote, true, '**但** wrote:true（B01：调用失败 ≠ 没有副作用）')
  h.eq(r.result.valid, false, '基线自己也知道骨架不合规（valid:false）')
  h.assert(written && fs.existsSync(written), `而文件**真的**在盘上：${written}`)
})

h.case('T03-NEGCTRL-baseline-probe-writes-state', 'pass', () => {
  const stateAbs = path.join(PACK_BASE, 'learning-records', 'state.json')
  fs.rmSync(stateAbs, { force: true })
  h.assert(!fs.existsSync(stateAbs), '前置：跑基线之前这个包里没有判据快照')
  const r = runAuthor(BASE_PLUGIN, PACK_BASE, baseArgs({ point: 'gated', number: 2, slug: 'gated-old' }))
  const wrote = fs.existsSync(stateAbs)
  keepEvidence('T03-NEGCTRL-baseline-probe-writes-state', r, { stateAbs, stateWritten: wrote })
  h.assert(r.result != null, '基线那一次也要拿到回执')
  h.eq(wrote, true, '基线在**拒写**的路上顺手把 state.json 写出来了（这正是 T03 要断掉的那条副作用）')
})

h.case('T03-NEGCTRL-new-rejects-what-baseline-let-through', 'pass', () => {
  // 同一批输入，换成新实现：必须拒绝，且从那之后树一个字节都不再变
  const before = snapScope(PACK_BASE)
  const rTraversal = runAuthor(REPO, PACK_BASE, baseArgs({ point: 'fresh', halo: '../../../escaped', slug: 'esc-new', force: true }))
  const rZero = runAuthor(REPO, PACK_BASE, baseArgs({ point: 'fresh', number: 0, slug: 'zero-new', force: true }))
  const after = snapScope(PACK_BASE)
  const d = treeDiff(before, after)
  keepEvidence('T03-NEGCTRL-new-rejects-what-baseline-let-through', rTraversal, { note: '穿越那条（新实现）' })
  h.evidence(path.join('cases', 'T03-NEGCTRL-new-rejects-what-baseline-let-through-zero.txt'), clip(rZero.raw, 20000))
  h.assert(rTraversal.result?.ok === false && rZero.result?.ok === false, '新实现对同一批输入必须两条都拒')
  h.assert(rTraversal.result?.wrote !== true && rZero.result?.wrote !== true, '新实现不许写盘')
  h.eq(d.changed.length, 0, `新实现跑完树必须一个字节不变（实得 ${d.changed.join(' | ')}）`)
})

// ================================================================ ⑦ 回归
h.case('T03-REG-t01-still-passes', 'pass', () => {
  // ⚠️ T01 自己只保证 `audit-evidence/T01/`，**不建** `cases/` 子目录（T01.mjs 不在本卡
  //    写范围，不许改）—— 全新 clone 上直接跑 T01 会因为 ENOENT 而红。这里替它把目录备好，
  //    判据（T01 的断言与退出码）一个字都不动。
  fs.mkdirSync(path.join(REPO, 'audit-evidence', 'T01', 'cases'), { recursive: true })
  const r = runChild([NODE, path.join(TEST_DIR, 'audit', 'T01.mjs')], { cwd: REPO, timeoutMs: 900000 })
  keepEvidence('T03-REG-t01-still-passes', r, {})
  h.eq(r.code, 0, `T01 专项必须仍然 PASS（exit 0），实际 ${r.code}`)
  h.assert(/^PASS T01 checks=\d+ failed=0 skipped=0$/m.test(both(r).trim()), `T01 判词要仍是 PASS（实得：${both(r).trim().split('\n').slice(-1)[0]}）`)
})

h.case('T03-REG-selftest-still-passes', 'pass', () => {
  const r = runChild([NODE, path.join(TEST_DIR, 'all.mjs'), '--selftest'], { cwd: REPO, timeoutMs: 300000 })
  keepEvidence('T03-REG-selftest-still-passes', r, {})
  h.eq(r.code, 0, `all.mjs --selftest 必须仍全绿（exit 0），实际 ${r.code}`)
  h.assert(/selftest: \d+ 通过 \/ 0 失败/.test(both(r)), `selftest 摘要要仍是 0 失败（实得：${clip(both(r), 300)}）`)
  h.assert(/selftest: 17 通过 \/ 0 失败/.test(both(r)), 'selftest 仍是 17/17（判据面不许悄悄少几条）')
})

// ---------------------------------------------------------------- 收尾：清理夹具
{
  const notes = []
  const c = cleanupTempDir(SANDBOX, 'T03-sandbox')
  notes.push(`${SANDBOX} removed=${c.removed}${c.error ? ` err=${c.error}` : ''}`)
  h.note(notes.join('\n'))
}

process.exit(h.run())
