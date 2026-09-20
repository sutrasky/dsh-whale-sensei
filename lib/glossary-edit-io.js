/**
 * lib/glossary-edit-io.js —— 术语增改的**落盘层**（字符串手术在 lib/glossary.js）
 *
 * 四条判据，每条都能反空转：
 *   ① 写后必须真的能被 require 回来，且目标记录与传入逐字段一致
 *   ② require 自检不过 → 按写前快照**逐字节回滚**，并明确报出 rolledBack
 *   ③ 同 key 且 replace=false → 拒绝，文件**一动不动**（手术放在写盘之前抛）
 *   ④ 一律 UTF-8 **不带 BOM**（本机 BOM 是一类 bug：JSON.parse 直接抛、
 *      逐行解析会静默少一条）
 *
 * 为什么自检要用 require 而不是"再看一眼文本"：文本看着对、加载后字段错
 * （引号/转义/模板串写坏）是最容易漏的一类，只有真加载一次才知道。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { upsertTermSource, parseTermKeys } from './glossary.js'

export const LEDGER_REL = path.join('assets', 'glossary-data.js')
const FIELDS = ['label', 'category', 'official', 'short', 'analogy', 'lesson']

/** 加载并逐字段核对目标记录 */
export function verifyLoadedTerm(abs, key, record) {
  try {
    const req = createRequire(abs)
    delete req.cache[abs]
    const led = req(abs)
    const got = led && led[key]
    if (!got) return { ok: false, error: '加载后找不到键 ' + key }
    for (const f of FIELDS) {
      if (got[f] !== record[f]) {
        return { ok: false, error: '字段 ' + f + ' 不一致：期望 ' + JSON.stringify(record[f]) + '，实得 ' + JSON.stringify(got[f]) }
      }
    }
    if (record.code !== undefined && got.code !== record.code) {
      return { ok: false, error: '字段 code 不一致' }
    }
    return { ok: true, keys: Object.keys(led) }
  } catch (e) {
    return { ok: false, error: 'require 失败：' + e.message }
  }
}

/**
 * 在课程包里插入/替换一条术语记录，写后自检，失败回滚。
 * @param {{root: string, key: string, record: object, replace?: boolean, corrupt?: boolean}} o
 *        corrupt 仅供测试：故意写入语法错误，用来验证回滚分支真的会走
 */
export function writeTermSurgically(o = {}) {
  const { root, key, record, replace = false, corrupt = false } = o
  if (!root) throw new Error('缺少 root')
  if (!key) throw new Error('缺少 key')
  const abs = path.resolve(root, LEDGER_REL)
  if (!fs.existsSync(abs)) throw new Error('找不到台账文件：' + abs)

  const before = fs.readFileSync(abs)
  const src = before.toString('utf8')
  // 手术失败（同键且没给 replace、或 replace 不存在的键）在写盘之前抛 → 文件不动
  const next = upsertTermSource(src, key, record, { replace })
  const body = corrupt ? next + '\nfunction (\n' : next

  fs.writeFileSync(abs, Buffer.from(body, 'utf8'))

  const check = verifyLoadedTerm(abs, key, record)
  if (!check.ok) {
    fs.writeFileSync(abs, before)
    return { ok: false, error: '写后自检没过，已回滚：' + check.error, rolledBack: true, abs }
  }
  return { ok: true, abs, keys: parseTermKeys(body), bytes: Buffer.byteLength(body), replaced: replace }
}
