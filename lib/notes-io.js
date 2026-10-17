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
 *   · **孤儿锚点当场拒写**：anchor 必须能被课次映射表解析（`第N课` 或 `point/NNNN`）
 *     —— 脏数据不进台账，否则星图挂不上还不知道为什么 ✗
 *   · **anchor → 星图课次键的推导在这里做，且只在这里做**（2026-09-24 用户裁定）：
 *     调用方给 `第1课` 还是 `spring-boot/0001` 都行，落盘一律是映射表里的 `entry.key` ——
 *     台账里因此只有一种写法，读点直接比字符串，不许各自再推一遍
 *   · **序号与记录是同一个写集**（T10 / 报告 C01）：`notes.jsonl` 与 `notes/seq.txt`
 *     在包锁内通过 `withPackTransaction` 一起提交；第二次写失败 ⇒ 两件都回到写前字节，
 *     不会留下「台账写了、seq 没走」或反过来。版本（seq）在锁内算。
 *   · 写后必须 re-read + `JSON.parse` 自检；不过就**不提交**（事务 rejected，原树不动）
 *   · 一律 UTF-8 **不带 BOM**
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
 * 事务写集只认**包内 POSIX 相对路径**（事务件会把 `rel` 的 `\` 归一成 `/`）。
 * 盘上路径仍用 `path.join`，两者不要混。
 */
const NOTES_REL_POSIX = 'notes/notes.jsonl'
const SEQ_REL_POSIX = 'notes/seq.txt'

/**
 * 包级事务件（随包发；T09 的接口，卡面 T10 要求六个宿主写口统一走它）。
 * 用 `createRequire` 是因为它是 CommonJS（UMD 风格），与 `ask-io.js` 读 CJS 台账同一手法。
 */
const requireCJS = createRequire(import.meta.url)
const PACK_TXN = requireCJS('./pack-template/tools/ledger-transaction.cjs')

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

/** 事务选项：只把调用方**显式**给的件传下去（默认值仍由事务件说了算） */
function txnOpts(txn) {
  if (!txn || typeof txn !== 'object') return undefined
  const o = {}
  if (txn.fs) o.fs = txn.fs
  if (txn.ownerToken !== undefined) o.ownerToken = String(txn.ownerToken)
  if (txn.timeoutMs !== undefined) o.timeoutMs = txn.timeoutMs
  return o
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

/** 写后自检（对**将要提交的字节**做，等价于写完 re-read） */
function checkWrittenNotes(text, rec, key, hasDate) {
  const back = parseNotesText(text)
  const last = back[back.length - 1]
  if (!last) return 're-read 后一条都没有'
  if (last.id !== rec.id || last.text !== rec.text || last.anchor !== key) return 're-read 的字段与写入不一致'
  if (Object.prototype.hasOwnProperty.call(last, 'date') !== hasDate) return 'date 字段存在性与预期不符'
  return null
}

/**
 * 追加一条笔记。
 * @param {{root:string, text:string, anchor:string, date?:string, corrupt?:boolean,
 *          txn?:{fs?:object, ownerToken?:string, timeoutMs?:number}}} o
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
  // 调用方给的可能是 `第N课`（label）或 `point/NNNN`（key），两种写法在这里收敛成**同一个键**，
  // 台账里因此永远只有一种写法；课次显示名由读点用映射表反推（交接 §五）。
  // 实现只有一处（`pack-model.js` 的 keyOfAnchor），课程包侧的旧 `/note` 走它的镜像。
  const key = keyOfAnchor(anchor, idx)
  if (!key) {
    throw new Error('孤儿锚点：' + anchor + ' 在课次映射表里解析不到（现有：' + Object.keys(idx.byKey).join(' / ') + '）')
  }

  const notesAbs = path.join(abs, NOTES_REL)
  let buildError = null
  let value = null
  let result
  try {
    // 包根必须先在（事务的锁目录建在包根下）；目录本身不是台账字节
    fs.mkdirSync(abs, { recursive: true })
    result = PACK_TXN.withPackTransaction(abs, ({ files }) => {
      try {
        // 第一次调用只声明写集（事务件这时还没给出写前字节）
        const declared = Object.prototype.hasOwnProperty.call(files, NOTES_REL_POSIX)
          && Object.prototype.hasOwnProperty.call(files, SEQ_REL_POSIX)
        if (!declared) {
          return [
            { rel: NOTES_REL_POSIX, content: '' },
            { rel: SEQ_REL_POSIX, content: '' },
          ]
        }
        const beforeText = files[NOTES_REL_POSIX] == null ? '' : String(files[NOTES_REL_POSIX])
        const seqText = files[SEQ_REL_POSIX] == null ? '' : String(files[SEQ_REL_POSIX])

        // ── 序号在**锁内**算：与台账同一份写前快照 ──
        const seq = seqFromText(seqText) + 1
        const id = String(seq).padStart(4, '0')
        if (parseNotesText(beforeText).some((n) => String(n.id) === id)) {
          throw new Error('id ' + id + ' 已存在（seq.txt 落后于台账？）：只追加不覆盖')
        }

        const rec = { id, seq, kind: '笔记', anchor: key, text: String(text) }
        if (date !== undefined) rec.date = String(date)
        let line = JSON.stringify(rec)
        if (corrupt) line = line + ' 这行故意写坏'

        // 已有记录的前缀字节**原样保留**（只追加）
        const had = beforeText.length > 0 && !beforeText.endsWith('\n')
        const body = beforeText + (had ? '\n' : '') + line + '\n'

        const why = checkWrittenNotes(body, rec, key, date !== undefined)
        if (why) {
          const e = new Error(why)
          e.selfCheckFailure = true
          throw e
        }
        value = { id, seq, body }
        return {
          files: [
            { rel: NOTES_REL_POSIX, content: Buffer.from(body, 'utf8') },
            { rel: SEQ_REL_POSIX, content: Buffer.from(String(seq) + '\n', 'utf8') },
          ],
          value,
        }
      } catch (e) {
        buildError = e
        throw e
      }
    }, txnOpts(o.txn))
  } catch (e) {
    if (e && e.txnState) throw e
    const wrapped = new Error(`笔记写入失败（事务 rejected）：${e && e.message ? e.message : String(e)}`)
    wrapped.txnState = 'rejected'
    wrapped.httpStatus = 500
    throw wrapped
  }

  if (result.ok) {
    return {
      ok: true,
      id: value.id,
      seq: value.seq,
      abs: notesAbs,
      bytes: Buffer.byteLength(value.body),
      hasDate: date !== undefined,
    }
  }
  if (buildError) {
    if (buildError.selfCheckFailure) {
      // 自检不过 ⇒ 事务**未提交**（一个字节都没落），台账与 seq 都还是写前状态。
      // 保留原回执形状（ok:false / rolledBack:true），并加上明确事务 state。
      return {
        ok: false,
        error: '写后自检没过，已回滚（台账与 seq 都回到写前）：' + buildError.message,
        rolledBack: true,
        state: result.state,
        txnId: result.txnId,
      }
    }
    throw buildError
  }
  throw txnFailure('笔记写入', result)
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

  const P1 = mk()
  const r1 = appendNote({ root: P1, text: '第一条笔记', anchor: '第1课' })
  ok(r1.ok === true && r1.id === '0001' && r1.seq === 1, '按 第N课 锚点写入成功且 id=0001')
  ok(readSeq(P1) === 1, 'notes/seq.txt 前进到 1（单调计数器，不是时间戳）')
  const after1 = hash(path.join(P1, NOTES_REL))
  ok(!/date/.test(after1), '没给 date 时产物里就没有 date 字段（不默认今天）')

  const r2 = appendNote({ root: P1, text: '第二条笔记', anchor: 'pt/0001' })
  ok(r2.ok === true && r2.id === '0002', 'point/NNNN 锚点同样可用（两种写法都能解析）')
  const rows = readNotes(P1)
  ok(rows.length === 2, '两条都在台账里')
  ok(rows[0].anchor === 'pt/0001', '给「第1课」时落盘的是**星图课次键** pt/0001，不是 label（推导在入口做）')
  ok(rows[1].anchor === 'pt/0001' && rows[0].anchor === rows[1].anchor, '第N课 与 point/NNNN 两种写法收敛成同一个键 —— 台账里只有一种写法')

  const beforeBad = hash(path.join(P1, NOTES_REL))
  const seqBeforeBad = readSeq(P1)
  let threw = ''
  try { appendNote({ root: P1, text: 'x', anchor: 'nope/9999' }) } catch (e) { threw = e.message }
  ok(/孤儿锚点/.test(threw), '孤儿锚点当场拒写')
  ok(hash(path.join(P1, NOTES_REL)) === beforeBad && readSeq(P1) === seqBeforeBad, '被拒后台账与计数器都没动')

  fs.writeFileSync(path.join(P1, SEQ_REL), '1\n')   // 模拟 seq 落后
  threw = ''
  try { appendNote({ root: P1, text: 'x', anchor: '第1课' }) } catch (e) { threw = e.message }
  ok(/已存在/.test(threw), 'seq 落后导致 id 撞车时拒绝（只追加不覆盖）')
  ok(hash(path.join(P1, NOTES_REL)) === beforeBad, '撞车被拒后台账没动')

  const P2 = mk()
  appendNote({ root: P2, text: '  同样一条  ', anchor: '第1课' })
  const P3 = mk()
  appendNote({ root: P3, text: '  同样一条  ', anchor: '第1课' })
  ok(hash(path.join(P2, NOTES_REL)) === hash(path.join(P3, NOTES_REL)), '确定性：同一输入两次（各自冷启动）产出逐字节相同')

  const P4 = mk()
  const w = appendNote({ root: P4, text: '会写坏', anchor: '第1课', corrupt: true })
  ok(w.ok === false && w.rolledBack === true, '自检不过时明确报 rolledBack')
  ok(hash(path.join(P4, NOTES_REL)) === '(无)' && readSeq(P4) === 0, '回滚后台账与 seq 都回到写前（文件根本没留下）')

  // 日期两条各自用一个新的临时包 —— **收进数组一起清**：早先这两处直接用 mk() 没留引用，
  // 于是每跑一次自检就在 %TEMP% 里漏两个 whale-notes-* 目录（2026-09-24 实测漏了 4 个才被发现）
  const P5 = mk()
  const d5 = appendNote({ root: P5, text: '带日期', anchor: '第1课', date: '2026-09-24' })
  ok(d5.ok === true && d5.hasDate === true, '显式给 date 时可以写入')
  const P6 = mk()
  let threw2 = ''
  try { appendNote({ root: P6, text: 'x', anchor: '第1课', date: '今天' }) } catch (e) { threw2 = e.message }
  ok(/YYYY-MM-DD/.test(threw2), 'date 形状不对就拒绝（不许默认"今天"）')

  // 大小闸：与包侧 `/note` 同阈值、同单位（按**字节**）、同口径文案 —— 写前拒，台账一字不动
  const P7 = mk()
  const HUGE = '超'.repeat(6000)                       // 6000 字 = 18000 字节 > 16KB，但**字符数**没超
  let threw3 = ''
  try { appendNote({ root: P7, text: HUGE, anchor: '第1课' }) } catch (e) { threw3 = e.message }
  ok(threw3 === '笔记太长了，请精简到 16KB 以内', `超限笔记当场拒，文案与包侧 /note 逐字相同（实得 ${JSON.stringify(threw3)}）`)
  ok(hash(path.join(P7, NOTES_REL)) === '(无)' && readSeq(P7) === 0, '超限被拒后台账与计数器都没动（写前拒）')
  ok(Buffer.byteLength(HUGE, 'utf8') > NOTE_MAX_BYTES && HUGE.length < NOTE_MAX_BYTES,
    '样本按字节超限、按字符没超 —— 单位改回字符数就会放行（反空转）')

  for (const d of [P1, P2, P3, P4, P5, P6, P7]) fs.rmSync(d, { recursive: true, force: true })
  console.log('\n=== selftest: ' + (failures.length ? failures.length + ' 失败' : '全部通过') + ' ===')
  process.exit(failures.length ? 1 : 0)
}
