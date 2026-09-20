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
 *   · 写后必须 re-read + `JSON.parse` 自检；不过就按写前快照**逐字节回滚**（含 seq）
 *   · 一律 UTF-8 **不带 BOM**
 *
 * 路由层（页面表单 → 插件 connection.fetch 通道）是这一层上面的薄壳，本文件不碰网络。
 * `node lib/notes-io.js --selftest` 在**临时合成的包**上验，不碰真包。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lessonIndex, keyOfAnchor, NOTES_REL } from './pack-model.js'

/** 路径常量**只有一份**，在 `pack-model.js`（数据层唯一入口）；这里只引用，不再抄一遍 ✗ */
export { NOTES_REL }
export const SEQ_REL = path.join('notes', 'seq.txt')

const readSeq = (abs) => {
  const p = path.join(abs, SEQ_REL)
  if (!fs.existsSync(p)) return 0
  const n = Number(String(fs.readFileSync(p, 'utf8')).replace(/^\uFEFF/, '').trim())
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** 读现有笔记行（顺带剥 BOM） */
export function readNotes(root) {
  const p = path.join(path.resolve(root), NOTES_REL)
  if (!fs.existsSync(p)) return []
  const out = []
  for (const line of fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 坏行留给自检去报 */ }
  }
  return out
}

/**
 * 追加一条笔记。
 * @param {{root:string, text:string, anchor:string, date?:string, corrupt?:boolean}} o
 *        corrupt 仅供测试：故意写坏一行，用来验证回滚分支真的会走
 */
export function appendNote(o = {}) {
  const { root, text, anchor, date, corrupt = false } = o
  if (!root) throw new Error('缺少 root')
  if (!text || !String(text).trim()) throw new Error('缺 text（空笔记不写）')
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
  const seqAbs = path.join(abs, SEQ_REL)
  const before = fs.existsSync(notesAbs) ? fs.readFileSync(notesAbs) : Buffer.from('', 'utf8')
  const beforeSeq = fs.existsSync(seqAbs) ? fs.readFileSync(seqAbs) : null

  const seq = readSeq(abs) + 1
  const id = String(seq).padStart(4, '0')
  if (readNotes(abs).some((n) => String(n.id) === id)) {
    throw new Error('id ' + id + ' 已存在（seq.txt 落后于台账？）：只追加不覆盖')
  }

  const rec = { id, seq, kind: '笔记', anchor: key, text: String(text) }
  if (date !== undefined) rec.date = String(date)
  let line = JSON.stringify(rec)
  if (corrupt) line = line + ' 这行故意写坏'

  const had = before.length > 0 && !before.toString('utf8').endsWith('\n')
  const body = before.toString('utf8') + (had ? '\n' : '') + line + '\n'
  fs.mkdirSync(path.dirname(seqAbs), { recursive: true })
  fs.writeFileSync(notesAbs, Buffer.from(body, 'utf8'))
  fs.writeFileSync(seqAbs, Buffer.from(String(seq) + '\n', 'utf8'))

  // 写后自检：re-read + parse 最后一条，逐字段核对
  let why = null
  try {
    const back = readNotes(abs)
    const last = back[back.length - 1]
    if (!last) why = 're-read 后一条都没有'
    else if (last.id !== id || last.text !== rec.text || last.anchor !== key) why = 're-read 的字段与写入不一致'
    else if (Object.prototype.hasOwnProperty.call(last, 'date') !== (date !== undefined)) why = 'date 字段存在性与预期不符'
  } catch (e) {
    why = 're-read 失败：' + e.message
  }
  if (why) {
    // 回滚要回到**写前状态**：原先根本没有这个文件（before 为空）时，
    // 不能留下一个 0 字节空壳 ✗ —— 那和"没写过"不是同一个状态（本轮自检就是这么抓到的）
    if (before.length === 0) {
      try { fs.rmSync(notesAbs, { force: true }) } catch { /* 删不掉就算了 */ }
    } else {
      fs.writeFileSync(notesAbs, before)
    }
    if (beforeSeq === null) { try { fs.rmSync(seqAbs, { force: true }) } catch { /* 删不掉就算了 */ } } else fs.writeFileSync(seqAbs, beforeSeq)
    return { ok: false, error: '写后自检没过，已回滚（台账与 seq 都回到写前）：' + why, rolledBack: true }
  }
  return { ok: true, id, seq, abs: notesAbs, bytes: Buffer.byteLength(body), hasDate: date !== undefined }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain && process.argv.includes('--selftest')) {
  const failures = []
  const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures.push(msg) }

  // 合成一个最小包（不碰真包）：映射表需要 EXPECT 的 id + 源页 + 产物页
  const mk = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-notes-'))
    fs.mkdirSync(path.join(d, 'lessons', 'src'), { recursive: true })
    fs.mkdirSync(path.join(d, 'code', 'proj'), { recursive: true })
    fs.writeFileSync(path.join(d, 'lessons', 'src', '0001-a.html'), '<html></html>')
    fs.writeFileSync(path.join(d, 'lessons', '0001-a.html'), '<html></html>')
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

  for (const d of [P1, P2, P3, P4, P5, P6]) fs.rmSync(d, { recursive: true, force: true })
  console.log('\n=== selftest: ' + (failures.length ? failures.length + ' 失败' : '全部通过') + ' ===')
  process.exit(failures.length ? 1 : 0)
}
