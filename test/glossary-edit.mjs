/**
 * glossary-edit.mjs —— 术语增改的字符串手术（纯函数 + require 往返自检）
 *
 * 判据都要能**反空转**：这里的每个 ok 都对应一个"改坏了就会 FAIL"的场景，
 * 尤其是 code 里带 `{` 的那条（朴素数括号会在这里断掉）。
 *   ① 认出已有键名
 *   ② 插入后键 +1、旧键保留
 *   ③ 同键再插 → 拒绝（只追加不覆盖）
 *   ④ replace 不存在的键 → 抛错
 *   ⑤ require 往返：写出的源码真的能被加载，新旧记录都对
 *   ⑥ code 含 `{ }` 时 replace 只动这一条，其余字段原样
 *   ⑦ 确定性：同样输入产出逐字节相同
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { upsertTermSource, parseTermKeys } from '../lib/glossary.js'
import { writeTermSurgically } from '../lib/glossary-edit-io.js'
import { plugin as glPlugin } from '../lib/mods/glossary.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)

let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}

const SRC = `(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
}(this, function () {
  return {
    body: {
      label: '响应体',
      category: 'Web 基础',
      official: '官方',
      short: '大白话',
      analogy: '类比',
      lesson: '第1课'
    }
  };
}));
`
const rec = { label: '测试词', category: 'Web 基础', official: 'O', short: 'S', analogy: 'A', lesson: '第2课' }
const recCode = Object.assign({}, rec, { code: 'public class A {\n  int x = 1;\n}' })

ok(parseTermKeys(SRC).join(',') === 'body', 'parseTermKeys 认出已有键 body')

const added = upsertTermSource(SRC, 'testword', rec)
const keys2 = parseTermKeys(added)
ok(keys2.length === 2 && keys2.indexOf('testword') !== -1 && keys2.indexOf('body') !== -1,
  '插入后键从 1 个变 2 个且旧键还在')

let threw = ''
try { upsertTermSource(added, 'testword', rec) } catch (e) { threw = e.message }
ok(/只追加不覆盖/.test(threw), '同键再插一次被拒绝（只追加不覆盖）')

threw = ''
try { upsertTermSource(SRC, 'nope', rec, { replace: true }) } catch (e) { threw = e.message }
ok(/无法 replace/.test(threw), 'replace 一个不存在的键会抛错')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-gloss-'))
const req = createRequire(import.meta.url)
const f1 = path.join(tmp, 'ledger1.js')
fs.writeFileSync(f1, added)
const loaded = req(f1)
ok(!!(loaded.testword && loaded.testword.label === '测试词'), 'require 往返：新记录真的可加载且字段正确')
ok(!!(loaded.body && loaded.body.label === '响应体'), 'require 往返：旧记录未被破坏')

const withCode = upsertTermSource(added, 'coded', recCode)
const replaced = upsertTermSource(withCode, 'coded', Object.assign({}, recCode, { short: 'S2' }), { replace: true })
const f2 = path.join(tmp, 'ledger2.js')
fs.writeFileSync(f2, replaced)
const loaded2 = req(f2)
ok(!!(loaded2.coded && loaded2.coded.short === 'S2'), 'replace：code 含 { } 时仍只替换该条')
ok(loaded2.coded && loaded2.coded.code === recCode.code, 'replace：code 原样保留')
ok(parseTermKeys(replaced).length === 3 && loaded2.body.label === '响应体', 'replace 后三条都在、旧记录未动')

ok(upsertTermSource(SRC, 'testword', rec) === added, '同样输入产出逐字节相同（确定性）')

fs.rmSync(tmp, { recursive: true, force: true })

/* ── 落盘层：在**影副本**上跑，真包只核对哈希 ───────────────────────── */
import { packRoot } from './_pack.mjs'

const PACK = packRoot()
const realLedger = path.join(PACK, 'assets', 'glossary-data.js')
const packSha = sha(fs.readFileSync(realLedger))
ok(!!packSha, '真包台账存在（后面核对它没被动过）')

const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pack-'))
fs.mkdirSync(path.join(shadow, 'assets'), { recursive: true })
fs.copyFileSync(realLedger, path.join(shadow, 'assets', 'glossary-data.js'))
const shadowLedger = path.join(shadow, 'assets', 'glossary-data.js')
const shadowSha0 = sha(fs.readFileSync(shadowLedger))

const dupKey = parseTermKeys(fs.readFileSync(shadowLedger, 'utf8'))[0]
let threw2 = ''
try { writeTermSurgically({ root: shadow, key: dupKey, record: rec }) } catch (e) { threw2 = e.message }
ok(/只追加不覆盖/.test(threw2), '落盘层：同键插入被拒（手术在写盘之前抛）')
ok(sha(fs.readFileSync(shadowLedger)) === shadowSha0, '落盘层：被拒后文件逐字节没变')

const w1 = writeTermSurgically({ root: shadow, key: 'whaletest', record: rec })
ok(w1.ok === true, '落盘层：新键写成功且 require 自检通过')
const loaded3 = createRequire(shadowLedger)(shadowLedger)
ok(!!(loaded3.whaletest && loaded3.whaletest.label === '测试词'), '落盘层：新记录可加载')
ok(!!loaded3[dupKey], '落盘层：旧记录仍在')

const shaBefore = sha(fs.readFileSync(shadowLedger))
const w2 = writeTermSurgically({ root: shadow, key: 'whalebad', record: rec, corrupt: true })
ok(w2.ok === false && w2.rolledBack === true, '落盘层：自检不过时明确报 rolledBack')
ok(sha(fs.readFileSync(shadowLedger)) === shaBefore, '落盘层：回滚后逐字节等于写前')
ok(fs.readFileSync(shadowLedger)[0] !== 0xEF, '落盘层：写出的文件不带 BOM')

ok(sha(fs.readFileSync(realLedger)) === packSha, '真包台账全程未被改动')
fs.rmSync(shadow, { recursive: true, force: true })

/* ── 工具面：默认只读、写盘才落、改完自动同步 GLOSSARY.md ───────────── */
const shadow2 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-tool-'))
fs.mkdirSync(path.join(shadow2, 'assets'), { recursive: true })
fs.copyFileSync(realLedger, path.join(shadow2, 'assets', 'glossary-data.js'))
const shadow2Ledger = path.join(shadow2, 'assets', 'glossary-data.js')
const sha2 = () => sha(fs.readFileSync(shadow2Ledger))

let tool = null
glPlugin.install({ paths: { packRoot: shadow2 }, registerTool: (t) => { tool = t } })
ok(!!(tool && typeof tool.execute === 'function'), '工具面：install 注册出 whale_glossary 且带 execute')

const before2 = sha2()
const vNoWrite = await tool.execute({ root: shadow2, action: 'add', key: 'toolword', record: rec })
ok(vNoWrite.ok === false && /write=true/.test(vNoWrite.error), '工具面：add 不带 write=true 被拒')
ok(sha2() === before2, '工具面：被拒后台账逐字节没变')

const vCheck = await tool.execute({ root: shadow2, write: true })
ok(vCheck.ok === true, '工具面：check 分支可重建 GLOSSARY.md')

const vAdd = await tool.execute({ root: shadow2, action: 'add', key: 'toolword', record: rec, write: true })
ok(vAdd.ok === true && vAdd.replaced === false, '工具面：add 成功且 replaced=false')
const vDrift = await tool.execute({ root: shadow2 })
ok(vDrift.ok === true, '工具面：改完后台账与 GLOSSARY.md 仍一致（自动同步生效）')

const vEdit = await tool.execute({ root: shadow2, action: 'edit', key: 'toolword', record: Object.assign({}, rec, { short: 'S9' }), write: true })
ok(vEdit.ok === true && vEdit.replaced === true, '工具面：edit 成功且 replaced=true')
const led2b = createRequire(shadow2Ledger)(shadow2Ledger)
ok(!!(led2b.toolword && led2b.toolword.short === 'S9'), '工具面：edit 后字段真的换了')

const beforeEdit = sha2()
const vMissing = await tool.execute({ root: shadow2, action: 'edit', key: 'nope', record: rec, write: true })
ok(vMissing.ok === false && /未改动/.test(vMissing.error), '工具面：edit 不存在的键被拒且说明台账未改动')
ok(sha2() === beforeEdit, '工具面：被拒后台账逐字节没变')
ok(sha(fs.readFileSync(realLedger)) === packSha, '真包台账在工具面测试后仍未被改动')
fs.rmSync(shadow2, { recursive: true, force: true })

/* T26-A1: the first real transactional write to an explicitly empty ledger. */
const emptyShadow = fs.mkdtempSync('E:/Temp/whale-T26-empty-')
fs.mkdirSync(path.join(emptyShadow,'assets'))
const emptyPath = path.join(emptyShadow,'assets/glossary-data.js')
fs.writeFileSync(emptyPath, SRC.replace(/    body: \{[\s\S]*?\n    \}/, ''))
const firstEmpty = writeTermSurgically({root:emptyShadow,key:'first',record:rec})
ok(firstEmpty.ok === true, '空台账：首次真实事务新增成功')
const emptyReq = createRequire(emptyPath)
delete emptyReq.cache[emptyPath]
ok(JSON.stringify(emptyReq(emptyPath).first) === JSON.stringify(rec), '空台账：加载后六字段逐字一致')
const emptyBefore = fs.readFileSync(emptyPath)
let duplicateEmpty = false
try {writeTermSurgically({root:emptyShadow,key:'first',record:rec})} catch(e) {duplicateEmpty = /只追加不覆盖/.test(e.message)}
ok(duplicateEmpty && fs.readFileSync(emptyPath).equals(emptyBefore), '空台账：第二次同键拒绝且字节不变')
const corruptEmpty = writeTermSurgically({root:emptyShadow,key:'bad',record:rec,corrupt:true})
ok(corruptEmpty.ok === false && corruptEmpty.rolledBack === true && fs.readFileSync(emptyPath).equals(emptyBefore), '空台账：corrupt 自检拒绝且原字节不变')
if (!path.resolve(emptyShadow).startsWith('E:\\Temp\\whale-T26-empty-')) throw new Error('拒绝清理未知空台账夹具')
fs.rmSync(emptyShadow,{recursive:true,force:true})

// ⚠️ 这一行是 run-all.mjs 的解析契约（正则 `=== (\d+) 通过 / (\d+) 失败 ===`），
// 前缀多一个字都会被记成「0 通过 / 1 失败」——不要改成「=== 结果：...」
console.log('\n=== ' + pass + ' 通过 / ' + fails.length + ' 失败 ===')
process.exit(fails.length ? 1 : 0)
