/**
 * lib/notes-io.js —— 笔记 box 的唯一写入口（A1b ③ 的下半）
 *
 * 规矩（2026-09-24 定，全部可机械判据）：
 *   · schema：`{ id, seq, kind:'笔记', anchor, text }`（`date` 可选，**只能由调用方显式给**）
 *   · 路径：`notes/notes.jsonl`（正本）+ `notes/seq.txt`（计数器）——
 *     常量只在 `pack-model.js` 定义一次，本文件只引用。2026-09-24 用户裁定正本为
 *     `notes/notes.jsonl`：课程包侧 7 个读者全读这个路径，写成包根等于写进没人读的文件。
 *   · `id` 四位零填充，来自 `notes/seq.txt` 的**单调计数器** —— 不用时间戳
 *     （写时间戳会让"同一输入两次写"产出不同文件 ✗，`--check` 的逐字节对拍就废了）
 *   · 只追加：要用的 id 已存在 → 拒绝（同 key 只追加不覆盖）
 *   · **孤儿锚点当场拒写**：anchor 必须能被课次映射表解析成**规范身份**（U09 收敛后只认
 *     `circle/point/NNNN` 与哨兵 `未归课`；显示名与历史两段课键一律 null）
 *     —— 脏数据不进台账，否则星图挂不上还不知道为什么 ✗
 *   · **anchor → 星图课次键的推导在这里做，且只在这里做**（2026-09-24 用户裁定）：
 *     落盘一律是映射表认的规范键 —— 台账里因此只有一种写法，读点直接比字符串，不许各自再推一遍
 *   · **序号与记录是同一个写集**（T10 / 报告 C01）：`notes.jsonl` 与 `notes/seq.txt`
 *     在同一个提交计划里一起落位（U06 三闸 + 包锁）；第二次写失败 ⇒ 两件都回到写前字节，
 *     不会留下「台账写了、seq 没走」或反过来。版本（seq）在锁内算。
 *   · 写后必须 re-read + `JSON.parse` 自检；不过就**不提交**（事务 rejected，原树不动）
 *   · 一律 UTF-8 **不带 BOM**
 *
 * U14 起**记录形状与共同提交只有一个出处**：`lib/unify/records.cjs`（`appendNoteRecord`）。
 * 本文件仍是"笔记写入口"：保留 root/text/anchor/date 校验、`lessonIndex` + `keyOfAnchor` 的
 * 锚点解析、大小闸与返回/抛错形状**逐字不变**，但记录构建、序号分配、写后自检与
 * 「台账 + seq 同一写集」的提交全部委托那份内核（不再有本文件自己的回滚逻辑）。
 *
 * 路由层（页面表单 → 插件 connection.fetch 通道）是这一层上面的薄壳，本文件不碰网络。
 * `node lib/notes-io.js --selftest` 在**临时合成的包**上验，不碰真包。
 *
 * **MIRROR-OF: tools/ask-server.js**（同源实现；对拍落在 `test/mirror-parity.mjs`，登记在
 * `_plugin-prep/同源实现-对拍登记表.md`）。改这里就必须同步改那一份，否则对拍会红。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { lessonIndex, keyOfAnchor, NOTES_REL } from './pack-model.js'

/** 路径常量**只有一份**，在 `pack-model.js`（数据层唯一入口）；这里只引用，不再抄一遍 ✗ */
export { NOTES_REL }
export const SEQ_REL = path.join('notes', 'seq.txt')

/** 笔记正文上限 —— 与课程包侧 `tools/ask-server.js` 的 MAX_BODY = 16*1024 **同阈值** */
export const NOTE_MAX_BYTES = 16 * 1024

/**
 * 包级事务件（随包发；T09 的接口，卡面 T10 要求六个宿主写口统一走它）。
 * 用 `createRequire` 是因为它是 CommonJS（UMD 风格），与 `ask-io.js` 读 CJS 台账同一手法。
 *
 * U14 起提交边界收口到 `lib/unify/records.cjs` 的 `appendNoteRecord()`
 * （它走 U06 的 `planCommit`/`applyCommit`，底下仍是**同一份**事务件）。
 * 这里保留 require 的理由是把它当**显式注入的提交能力**往下传：
 * 调用方（或测试）可以给一个替身事务件，本层原样往下传，绝不自己另造一套。
 */
const requireCJS = createRequire(import.meta.url)
const PACK_TXN = requireCJS('./pack-template/tools/ledger-transaction.cjs')
/** 记录构建内核（U14 唯一实现：记录形状 / 序号 / 共同提交 / 归档判定） */
const RECORDS = requireCJS('./unify/records.cjs')

/** 把 seq 文本解析成计数器（剥 BOM / 空文件 = 0；与旧实现同口径） */
const seqFromText = (text) => {
  const n = Number(String(text == null ? '' : text).replace(/^\uFEFF/, '').trim())
  return Number.isFinite(n) && n >= 0 ? n : 0
}

const readSeq = (abs) => {
  const p = path.join(abs, SEQ_REL)
  if (!fs.existsSync(p)) return 0
  return seqFromText(fs.readFileSync(p, 'utf8'))
}

/** 解析台账行（剥 BOM；坏行跳过，留给自检/读点去报） */
const parseNotesText = (text) => {
  const out = []
  for (const line of String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 坏行留给自检去报 */ }
  }
  return out
}

/** 读现有笔记行（顺带剥 BOM） */
export function readNotes(root) {
  const p = path.join(path.resolve(root), NOTES_REL)
  if (!fs.existsSync(p)) return []
  return parseNotesText(fs.readFileSync(p, 'utf8'))
}

/** 事务失败 → 抛出带**明确事务状态**的错误（原错误形状 = 抛出；不把回滚失败写成成功） */
function txnFailure(action, r) {
  const state = r && r.state ? r.state : 'rejected'
  const e = new Error(`${action}失败（事务 ${state}）：${r && r.error ? r.error : '未知错误'}`)
  e.txnState = state
  if (r && r.txnId) e.txnId = r.txnId
  if (r && r.journal) e.journal = r.journal
  if (r && r.rollbackError) e.rollbackError = r.rollbackError
  // 路由层按 httpStatus 回码：锁忙/待恢复是可重试的 503；其它 I/O 失败是 500
  e.httpStatus = (state === 'busy' || state === 'recovery-required') ? 503 : 500
  return e
}

/**
 * 追加一条笔记。
 * @param {{root:string, text:string, anchor:string, date?:string, corrupt?:boolean,
 *          txn?:{fs?:object, ownerToken?:string, timeoutMs?:number, transaction?:object}}} o
 *        corrupt 仅供测试：故意写坏一行，用来验证自检分支真的会走
 *        txn 仅供测试注入事务件的 fs / 令牌（生产调用点不传）
 */
export function appendNote(o = {}) {
  const { root, text, anchor, date, corrupt = false } = o
  if (!root) throw new Error('缺少 root')
  if (!text || !String(text).trim()) throw new Error('缺 text（空笔记不写）')
  // ── 大小闸（与课程包侧 `/note` 同阈值、同单位、同口径）─────────────────────
  // 包侧 `tools/ask-server.js` 的 `/note` 一直有 `Buffer.byteLength(body,'utf8') > MAX_BODY`
  // → 413 + 「笔记太长了，请精简到 16KB 以内」；本侧原先**一条大小判断都没有** ⇒ 同一本
  // `notes/notes.jsonl` 两个写入口一个收一个拒。单位必须按**字节**（2026-09-25 裁定的先例：
  // 中文一字 3 字节，按字符数会判宽），拒法 = 状态码与文案逐字相同 + **写前**拒（台账一字不动）。
  //
  // ⚠️ **已知差异（有意，不是漂移）**：本侧测的是**正文**字节，包侧测的是**请求体**字节 ——
  //    16KB 顶端两者约差 35 字节（JSON 外壳的开销）。这是两层职责本身决定的：包侧是传输层守卫
  //    （还没解析完就得先把请求体挡住），本侧是内容层守卫。**不要**为了抹平这几十字节去按 `raw` 判
  //    —— 那要动 `lib/mods/note.js` 的入参形状，收益（35 字节的边界）远小于风险。双方实况由
  //    `test/mirror-parity.mjs` 的「已知差异登记」一节**同时钉住**：任一边改了判据就红。
  if (Buffer.byteLength(String(text), 'utf8') > NOTE_MAX_BYTES) {
    const e = new Error('笔记太长了，请精简到 16KB 以内')
    e.httpStatus = 413          // 与包侧 `/note` 的 413 同码（路由层据此回执，见 lib/mods/note.js）
    throw e
  }
  if (!anchor) throw new Error('缺 anchor（笔记必须挂在某颗星上）')
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new Error('date 给就必须是 YYYY-MM-DD（不许默认"今天"）')
  }

  const abs = path.resolve(root)
  const idx = lessonIndex(abs)
  // ── anchor → 星图课次键：**推导在入口做，读点不许再推一遍**（2026-09-24 用户裁定）──
  // 调用方给的可能是 `第N课`（label）或规范课次键；U09 收敛后 `keyOfAnchor` 只认规范身份
  // （显示名与历史形状 → null，不再隐式归一），台账里因此永远只有一种写法。
  const key = keyOfAnchor(anchor, idx)
  if (!key) {
    throw new Error('孤儿锚点：' + anchor + ' 在课次映射表里解析不到（现有：' + Object.keys(idx.byKey).join(' / ') + '）')
  }
  // ── 课程身份**单独严格验证**（U14）：页面锚点（`q0001` 一类）绝不许当课程键 ──
  const gate = RECORDS.classifyNoteAnchor(key)
  if (!gate.ok) {
    const e = new Error(`笔记锚点不是课程身份：${gate.error}`)
    e.httpStatus = 400
    throw e
  }

  const notesAbs = path.join(abs, NOTES_REL)
  const txnIn = o.txn && typeof o.txn === 'object' ? o.txn : null
  let receipt = null
  try {
    // 包根必须先在（事务的锁目录建在包根下）；目录本身不是台账字节
    fs.mkdirSync(abs, { recursive: true })
    // 记录构建 + 序号分配 + 写后自检 + 「台账与 seq 同一写集」的提交**全在 records 里**（U14 唯一实现）
    receipt = RECORDS.appendNoteRecord(abs, {
      text: String(text),
      anchorKey: key,
      date: date === undefined ? undefined : String(date),
    }, {
      // 既有 corrupt 钩子：只在测试里用，生产不传
      tamper: corrupt ? ' 这行故意写坏' : null,
      // 提交能力：调用方显式注入优先，否则就是包级事务件（**同一份**，不是第二套事务系统）
      transaction: (txnIn && txnIn.transaction) || PACK_TXN,
      fs: txnIn && txnIn.fs,
      ownerToken: txnIn && txnIn.ownerToken,
      timeoutMs: txnIn && txnIn.timeoutMs,
    })
  } catch (e) {
    if (e && e.txnState) throw e
    const wrapped = new Error(`笔记写入失败（事务 rejected）：${e && e.message ? e.message : String(e)}`)
    wrapped.txnState = 'rejected'
    wrapped.httpStatus = 500
    throw wrapped
  }

  if (receipt.ok === true) {
    const v = receipt.value || {}
    return {
      ok: true,
      id: v.id,
      seq: v.seq,
      abs: notesAbs,
      bytes: Buffer.byteLength(String(v.body == null ? '' : v.body)),
      hasDate: date !== undefined,
    }
  }
  if (receipt.buildError) {
    if (receipt.selfCheckFailure) {
      // 自检不过 ⇒ 事务**未提交**（一个字节都没落），台账与 seq 都还是写前状态。
      // 保留原回执形状（ok:false / rolledBack:true），并加上明确事务 state。
      return {
        ok: false,
        error: '写后自检没过，已回滚（台账与 seq 都回到写前）：' + receipt.buildError,
        rolledBack: true,
        state: receipt.state,
        txnId: receipt.txnId,
      }
    }
    // id 撞车一类的领域拒绝：保留"抛出"的旧形状（原文照旧）
    throw new Error(receipt.buildError)
  }
  throw txnFailure('笔记写入', receipt)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain && process.argv.includes('--selftest')) {
  const failures = []
  const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures.push(msg) }

  // 合成一个最小包（不碰真包）：映射表需要 EXPECT 的 id + 源页 + 产物页
  // ⚠️ 页面必须摆在**知识点目录**下（`lessons/pt/0001-a.html`）—— 2026-09-24 起 `byNumber`
  //    的键是 `point/NNNN`，平铺布局会被判成历史归属（programming/spring-boot），
  //    与这里声明的 `pt/0001` 对不上 ⇒ 映射表为空、锚点成孤儿（这正是跨圈串页缺陷的修复）
  const mk = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-notes-'))
    fs.mkdirSync(path.join(d, 'lessons', 'src', 'pt'), { recursive: true })
    fs.mkdirSync(path.join(d, 'lessons', 'pt'), { recursive: true })
    fs.mkdirSync(path.join(d, 'code', 'proj'), { recursive: true })
    fs.writeFileSync(path.join(d, 'lessons', 'src', 'pt', '0001-a.html'), '<html></html>')
    fs.writeFileSync(path.join(d, 'lessons', 'pt', '0001-a.html'), '<html></html>')
    fs.writeFileSync(path.join(d, 'code', 'proj', 'EXPECT.json'), JSON.stringify({ lessons: [{ id: 'pt/0001', title: '第1课' }] }))
    return d
  }
  const hash = (p) => (fs.existsSync(p) ? fs.readFileSync(p).toString('utf8') : '(无)')
  /**
   * 读台账并解析（**先看文件在不在**）。
   * 2026-10-20 修：旧自测在"第一条就写失败"时仍然去 `JSON.parse(hash(...))` ——
   * 拿到 `(无)` 就抛 SyntaxError/`Unexpected token '('`，把**真正的**拒绝原因（400 的响应体）
   * 盖掉了。现在：不存在就明确说"（文件不存在）"，不解析不存在的台账。
   */
  const ledgerRows = (root) => {
    const text = hash(path.join(root, NOTES_REL))
    if (text === '(无)') return { exists: false, rows: [], raw: '(文件不存在)' }
    const rows = []
    for (const l of text.split(/\r?\n/)) if (l.trim()) rows.push(JSON.parse(l))
    return { exists: true, rows, raw: text }
  }
  /** 拒写样本必须**一字不落**：台账 + seq 都回到写前字节（零写） */
  const rejectsWithoutWrite = (label, fn) => {
    const before = { notes: hash(path.join(P1, NOTES_REL)), seq: hash(path.join(P1, SEQ_REL)) }
    let message = ''
    let extra = ''
    try {
      fn()
    } catch (e) {
      message = e && e.message ? e.message : String(e)
      if (e && e.httpStatus) extra = `（httpStatus=${e.httpStatus}）`
    }
    const same = hash(path.join(P1, NOTES_REL)) === before.notes && hash(path.join(P1, SEQ_REL)) === before.seq
    ok(!!message && same, `${label} 当场拒写且台账/seq 一字未动（响应：${message || '（没抛错！）'}${extra}）`)
    return message
  }

  const P1 = mk()
  // ⚠️ 成功样本用**规范课次键** `programming/pt/0001`（夹具里 `pt/` 没有圆圈目录，映射表按
  //    LEGACY_HALO 归到 programming）。显示名与两段课键 U09 起是**拒写样本**，见下面 ③′。
  const CANON = 'programming/pt/0001'
  const r1 = appendNote({ root: P1, text: '第一条笔记', anchor: CANON })
  ok(r1.ok === true && r1.id === '0001' && r1.seq === 1,
    `按规范课次键 ${CANON} 写入成功且 id=0001（实际回执：${JSON.stringify(r1)}）`)
  ok(readSeq(P1) === 1, 'notes/seq.txt 前进到 1（单调计数器，不是时间戳）')
  const after1 = hash(path.join(P1, NOTES_REL))
  ok(!/date/.test(after1), '没给 date 时产物里就没有 date 字段（不默认今天）')

  const r2 = appendNote({ root: P1, text: '第二条笔记', anchor: CANON })
  ok(r2.ok === true && r2.id === '0002', `同一门课再写一条照旧成功（实际回执：${JSON.stringify(r2)}）`)
  const rows1 = ledgerRows(P1)
  ok(rows1.rows.length === 2, `两条都在台账里（实得 ${rows1.rows.length} 条）`)
  ok(rows1.rows.every((r) => r.anchor === CANON),
    `落盘 anchor 一律是**规范课次键** ${CANON}，不是显示名、也不是两段课键（实得 ${JSON.stringify(rows1.rows.map((r) => r.anchor))}）`)

  // ── ③′ 旧写法继续是**拒写样本**（U09 起的运行态口径）────────────────────────────
  const twoSegMsg = rejectsWithoutWrite('两段课键 pt/0001', () => appendNote({ root: P1, text: 'x', anchor: 'pt/0001' }))
  ok(/孤儿锚点/.test(twoSegMsg), `两段课键的拒绝理由点名「孤儿锚点」（实得 ${JSON.stringify(twoSegMsg)}）`)
  const labelMsg = rejectsWithoutWrite('显示名 第1课', () => appendNote({ root: P1, text: 'x', anchor: '第1课' }))
  ok(/孤儿锚点/.test(labelMsg), `显示名的拒绝理由点名「孤儿锚点」（实得 ${JSON.stringify(labelMsg)}）`)

  const beforeBad = hash(path.join(P1, NOTES_REL))
  const seqBeforeBad = readSeq(P1)
  let threw = ''
  try { appendNote({ root: P1, text: 'x', anchor: 'nope/9999' }) } catch (e) { threw = e.message }
  ok(/孤儿锚点/.test(threw), `孤儿锚点当场拒写（实得 ${JSON.stringify(threw)}）`)
  ok(hash(path.join(P1, NOTES_REL)) === beforeBad && readSeq(P1) === seqBeforeBad, '被拒后台账与计数器都没动')

  fs.writeFileSync(path.join(P1, SEQ_REL), '1\n')   // 模拟 seq 落后
  threw = ''
  try { appendNote({ root: P1, text: 'x', anchor: CANON }) } catch (e) { threw = e.message }
  ok(/已存在/.test(threw), `seq 落后导致 id 撞车时拒绝（只追加不覆盖）（实得 ${JSON.stringify(threw)}）`)
  ok(hash(path.join(P1, NOTES_REL)) === beforeBad, '撞车被拒后台账没动')

  const P2 = mk()
  appendNote({ root: P2, text: '  同样一条  ', anchor: CANON })
  const P3 = mk()
  appendNote({ root: P3, text: '  同样一条  ', anchor: CANON })
  ok(hash(path.join(P2, NOTES_REL)) === hash(path.join(P3, NOTES_REL)), '确定性：同一输入两次（各自冷启动）产出逐字节相同')

  const P4 = mk()
  const w = appendNote({ root: P4, text: '会写坏', anchor: CANON, corrupt: true })
  ok(w.ok === false && w.rolledBack === true, '自检不过时明确报 rolledBack')
  ok(hash(path.join(P4, NOTES_REL)) === '(无)' && readSeq(P4) === 0, '回滚后台账与 seq 都回到写前（文件根本没留下）')

  // 日期两条各自用一个新的临时包 —— **收进数组一起清**：早先这两处直接用 mk() 没留引用，
  // 于是每跑一次自检就在 %TEMP% 里漏两个 whale-notes-* 目录（2026-09-24 实测漏了 4 个才被发现）
  const P5 = mk()
  const d5 = appendNote({ root: P5, text: '带日期', anchor: CANON, date: '2026-09-24' })
  ok(d5.ok === true && d5.hasDate === true, '显式给 date 时可以写入')
  const P6 = mk()
  let threw2 = ''
  try { appendNote({ root: P6, text: 'x', anchor: CANON, date: '今天' }) } catch (e) { threw2 = e.message }
  ok(/YYYY-MM-DD/.test(threw2), 'date 形状不对就拒绝（不许默认"今天"）')

  // 大小闸：与包侧 `/note` 同阈值、同单位（按**字节**）、同口径文案 —— 写前拒，台账一字不动
  const P7 = mk()
  const HUGE = '超'.repeat(6000)                       // 6000 字 = 18000 字节 > 16KB，但**字符数**没超
  let threw3 = ''
  try { appendNote({ root: P7, text: HUGE, anchor: CANON }) } catch (e) { threw3 = e.message }
  ok(threw3 === '笔记太长了，请精简到 16KB 以内', `超限笔记当场拒，文案与包侧 /note 逐字相同（实得 ${JSON.stringify(threw3)}）`)
  ok(hash(path.join(P7, NOTES_REL)) === '(无)' && readSeq(P7) === 0, '超限被拒后台账与计数器都没动（写前拒）')
  ok(Buffer.byteLength(HUGE, 'utf8') > NOTE_MAX_BYTES && HUGE.length < NOTE_MAX_BYTES,
    '样本按字节超限、按字符没超 —— 单位改回字符数就会放行（反空转）')

  for (const d of [P1, P2, P3, P4, P5, P6, P7]) fs.rmSync(d, { recursive: true, force: true })
  console.log('\n=== selftest: ' + (failures.length ? failures.length + ' 失败' : '全部通过') + ' ===')
  process.exit(failures.length ? 1 : 0)
}
