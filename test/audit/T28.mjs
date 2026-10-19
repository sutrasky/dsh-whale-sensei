/**
 * T28 —— 缺许可或运行时不匹配时**阻止打包** + 显式的分发模式声明（20 个固定用例）
 * ==================================================================
 * 判据纪律（卡片 §5/§6 + 用户 2026-10-19 收窄裁定）：
 *   · 每条断言打在**产品行为**上：真调 `verifyDistributionMaterials`、真跑 CLI 子进程、
 *     真读生成出来的字节（`install.ps1` 首三字节 / receipt / payload 根的文件集合）；
 *   · 不许 `ok(true, …)` 兜底、不许把 skip 计 pass、子进程 exit 必须真实断言；
 *   · **反空转**：M02 用 `331b5cf` 的旧构建器真跑一遍（删掉许可它照样 exit 0 产出 node.exe），
 *     R01 证明那个 revision 连发布入口都不存在 —— 于是"新闸能红"不是自说自话；
 *   · **合成夹具一律标 SYNTHETIC**（首行 `SYNTHETIC-LICENSE-FIXTURE — NOT A REAL LICENSE`），
 *     node 材料用**本机真二进制**的 hash/版本 —— 不联网、不冒充任何发行版的真实许可材料。
 *     真实 Node/Three/字体的许可材料**没有接入**（T29 被用户弃权），所以私模式必须非零。
 *
 * 所有破坏性夹具都在 `E:/Temp/whale-T28-cases-*` 下；仓内**一个字节都不写**
 * （唯一的写是 harness 自己的证据目录 `audit-evidence/T28/`）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHarness, REPO, runChild, clip } from './harness.mjs'

const IDS = [
  'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07',
  'P01', 'P02', 'P03', 'P04', 'P05', 'P06',
  'I01', 'I02',
  'B01',
  'R01', 'R02',
  'C01', 'C02',
]
const h = createHarness({ card: 'T28', expectedIds: IDS })

const require_ = createRequire(import.meta.url)
const DL = require_(path.join(REPO, 'lib', 'pack-template', 'tools', 'distribution-license.cjs'))
const TEMPLATE = path.join(REPO, 'lib', 'pack-template')
const BASE_COMMIT = '331b5cf'
const TMP = fs.mkdtempSync('E:/Temp/whale-T28-cases-')

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const sha256File = (p) => sha256(fs.readFileSync(p))
const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }
const rows = (...xs) => xs.filter((x) => x !== undefined && x !== null).join('\n')
const budget = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

/** 「本机真二进制」作为 node 材料（**不联网、不冒充发行版**） */
const NODE_BIN = process.execPath
const NODE_VERSION = process.versions.node
const NODE_SHA = sha256File(NODE_BIN)

/** 合成许可（首行照 T28 §4 的写法；它不是任何真实许可，也不许被当成真实许可） */
const LICENSE_TEXT = [
  'SYNTHETIC-LICENSE-FIXTURE — NOT A REAL LICENSE',
  '这是一份**测试夹具**，不是 Node.js / Three.js / 任何字体的真实许可材料。',
  'T28 只验证"材料对不上就阻止打包"这台机器；真实许可能否接入由 T29 决定（用户已弃权）。',
  '',
].join('\n')
const LICENSE_NAME = 'LICENSE-node.txt'
/** 许可聚合件的固定名（T28-A2：唯一固定名才可能预先登记，不拷动态 basename） */
const LICENSES_NAME = 'LICENSES.txt'
const LICENSE_SHA = sha256(Buffer.from(LICENSE_TEXT, 'utf8'))

/* ══════════════════════════════════════════════════ 夹具（全部在 E:/Temp） */

const ev = []   // 逐步记录，最后落 notes.txt

/** 写一份 manifest + 它的许可件；返回 manifest 绝对路径。`manifestText` 给了就原样写（坏 JSON 用）。 */
function materials(dir, opts = {}) {
  const {
    nodeSha = NODE_SHA,
    version = NODE_VERSION,
    licenseText = LICENSE_TEXT,
    declaredLicenseSha = null,
    omitLicense = false,
    omitEvidence = false,
    schema = DL.MANIFEST_SCHEMA,
    manifestText = null,
  } = opts
  fs.mkdirSync(dir, { recursive: true })
  if (!omitLicense) fs.writeFileSync(path.join(dir, LICENSE_NAME), licenseText, 'utf8')
  const item = {
    name: 'node',
    version,
    source: `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`,
    sha256: nodeSha,
    path: 'node.exe',
    licenseFiles: [LICENSE_NAME],
    licenseSha256: { [LICENSE_NAME]: declaredLicenseSha || LICENSE_SHA },
  }
  if (!omitEvidence) {
    item.redistributionEvidence = [`evidence:node-runtime（SYNTHETIC 夹具：本机真二进制的 hash/版本，不代表真实发行版许可）`]
  }
  const manifest = { schema, items: [item] }
  const file = path.join(dir, 'manifest.json')
  fs.writeFileSync(file, manifestText !== null ? manifestText : `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return file
}

/**
 * 一份"够像课程包"的 reader 构建源：模板目录原样。
 *
 * ⚠️ 故意**不**在包根 `tools/` 下放 `LICENSE-node.txt`：`publish-policy.cjs#READER_LICENSE`
 * 是按"包根有没有这个名字"条件登记的，登记了它就会与聚合件 `LICENSES.txt` 重复
 * （T28-A2：二者不重复）。
 */
function makePack(name) {
  const pack = path.join(TMP, name)
  fs.cpSync(TEMPLATE, pack, { recursive: true })
  return pack
}

function buildPayload(pack, args, env) {
  return runChild([process.execPath, path.join(pack, 'tools', 'build-offline-payload.js'), ...args], {
    cwd: pack, env: env || {}, timeoutMs: 240000,
  })
}

function treeHash(root) {
  const all = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else all.push([path.relative(root, abs).replace(/\\/g, '/'), sha256File(abs)])
    }
  }
  walk(root)
  return sha256(JSON.stringify(all))
}

/** `git show <rev>:<rel>` 的**原始字节**（重定向到文件会写成 UTF-16LE，所以走 Buffer） */
function gitShow(relPath, rev = BASE_COMMIT) {
  const r = spawnSync('git', ['show', `${rev}:${relPath}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git show ${rev}:${relPath} 失败（${String(r.stderr || '').trim()}）`)
  return r.stdout
}

const PREP = { error: null }
const FIX = {}
try {
  // ① 三个 pack 夹具：新代码用的正式构建源 / 旧行为对照 / installer+bootstrap 的副本
  FIX.pack = makePack('pack')
  FIX.oldPack = makePack('oldpack')
  FIX.toolPack = makePack('toolpack')
  // 公开站档要有 lessons/ 与 reference/（白名单目录必须真实存在）——只用来证明回执**不进**公开站产物
  FIX.publicPack = makePack('publicpack')
  for (const d of ['lessons', 'reference']) fs.mkdirSync(path.join(FIX.publicPack, d), { recursive: true })
  fs.writeFileSync(path.join(FIX.publicPack, 'GLOSSARY.md'), '# 名词表（T28 夹具，空表）\n', 'utf8')
  // 旧行为对照：把 `331b5cf` 的构建器与发布策略放回去（两件要**成对**换，否则产物集合判据会先红）
  fs.writeFileSync(path.join(FIX.oldPack, 'tools', 'build-offline-payload.js'), gitShow('lib/pack-template/tools/build-offline-payload.js'))
  fs.writeFileSync(path.join(FIX.oldPack, 'tools', 'publish-policy.cjs'), gitShow('lib/pack-template/tools/publish-policy.cjs'))
  // "许可材料没接入"：包内自带的那份也不在（旧代码于是只剩 console.warn）
  fs.rmSync(path.join(FIX.oldPack, 'tools', 'node-license.txt'), { force: true })

  // ② 材料目录：good + 各变异体
  FIX.goodManifest = materials(path.join(TMP, 'materials', 'good'))
  FIX.missingManifest = materials(path.join(TMP, 'materials', 'missing-license'), { omitLicense: true })
  FIX.badLicSha = materials(path.join(TMP, 'materials', 'bad-license-sha'), {
    licenseText: `${LICENSE_TEXT}`.replace('SYNTHETIC-LICENSE-FIXTURE', 'SYNTHETIC-TAMPERED'),
  })
  FIX.badVersion = materials(path.join(TMP, 'materials', 'bad-version'), { version: '0.0.0-test' })
  FIX.badNodeSha = materials(path.join(TMP, 'materials', 'bad-node-sha'), { nodeSha: '0'.repeat(64) })
  FIX.noEvidence = materials(path.join(TMP, 'materials', 'no-evidence'), { omitEvidence: true })
  FIX.badJson = materials(path.join(TMP, 'materials', 'bad-json'), { manifestText: '{ 这不是 JSON，是一条坏材料\n' })
  FIX.badSchema = materials(path.join(TMP, 'materials', 'bad-schema'), { schema: 'whale-distribution/2' })

  // ③ 正式构建（P03）先跑一遍：P06 要读它落盘的 .ps1 字节
  FIX.outP03 = path.join(TMP, 'out-p03')
  fs.mkdirSync(FIX.outP03, { recursive: true })
  FIX.p03 = buildPayload(FIX.pack, [`--out=${FIX.outP03}`, `--node=${NODE_BIN}`, `--manifest=${FIX.goodManifest}`])
  FIX.p03Product = path.join(FIX.outP03, 'whale-reader')

  // ④ PowerShell 5.1 解析探针（ASCII 脚本，避开任何编码坑）
  FIX.probe = path.join(TMP, 'ps-parse-probe.ps1')
  fs.writeFileSync(FIX.probe, [
    'param([string]$Path)',
    '$bytes = [System.IO.File]::ReadAllBytes($Path)',
    '$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)',
    '$t = $null; $e = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$t, [ref]$e)',
    '$fileErrors = @($e).Count',
    'if ($hasBom) { $body = $bytes[3..($bytes.Length - 1)] } else { $body = $bytes }',
    '$gbk = [System.Text.Encoding]::GetEncoding(936).GetString($body)',
    '$t2 = $null; $e2 = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseInput($gbk, [ref]$t2, [ref]$e2)',
    '$gbkErrors = @($e2).Count',
    '$hex = ("{0:X2}{1:X2}{2:X2}" -f $bytes[0], $bytes[1], $bytes[2])',
    'ConvertTo-Json -Compress @{ hasBom = $hasBom; first3 = $hex; fileErrors = $fileErrors; gbkErrors = $gbkErrors }',
  ].join('\r\n') + '\r\n', 'utf8')
  ev.push(`夹具根：${TMP}`)
} catch (e) {
  PREP.error = e && e.stack ? e.stack : String(e)
  ev.push(`夹具准备失败：${PREP.error}`)
}

/** 用例里"夹具没准备好"要如实红，而不是抛一个看不懂的 undefined 错 */
function need(fn) {
  if (PREP.error) throw new Error(`夹具没准备好（先看 notes.txt）：${PREP.error.split('\n')[0]}`)
  return fn()
}

/** 跑 PS 5.1 探针：`{hasBom, first3, fileErrors, gbkErrors}` */
function psProbe(ps1) {
  const r = runChild(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FIX.probe, '-Path', ps1], { timeoutMs: 120000 })
  if (r.code !== 0) throw new Error(`PowerShell 探针失败（exit ${r.code}）：${clip(r.out + r.err, 1200)}`)
  const line = String(r.out).trim().split(/\r?\n/).pop()
  return JSON.parse(line)
}

/* ══════════════════════════════════════════════════════════ M：校验器 */

h.case('M01', 'pass', () => need(() => {
  const r = DL.verifyDistributionMaterials({ manifestPath: FIX.goodManifest, nodePath: NODE_BIN })
  h.eq(r.ok, true, `合法合成 manifest 必须 ok===true（problems=${JSON.stringify(r.problems)}）`)
  h.assert(Array.isArray(r.files) && r.files.length > 0, `files 必须非空（实得 ${JSON.stringify(r.files)}）`)
  h.assert(r.files.includes(LICENSE_NAME), `files 要点名已核验的许可件（实得 ${JSON.stringify(r.files)}）`)
  h.eq(DL.MANIFEST_SCHEMA, 'whale-distribution/1', 'MANIFEST_SCHEMA 逐字是 whale-distribution/1')
}))

h.case('M02', 'pass', () => need(() => {
  // ① 新判据：删掉一份必需许可文件 ⇒ 必须红，且 problem 点名该文件
  const r = DL.verifyDistributionMaterials({ manifestPath: FIX.missingManifest, nodePath: NODE_BIN })
  h.eq(r.ok, false, '缺一份必需许可文件必须 ok===false')
  h.assert(r.problems.some((p) => p.includes(LICENSE_NAME) && p.includes('不存在')),
    `problem 必须点名缺的那个文件（实得 ${JSON.stringify(r.problems)}）`)

  // ② 反空转：**旧行为**（331b5cf 的构建器）在同一情形下照样 exit 0 产出 node.exe
  const out = path.join(TMP, 'out-old')
  fs.mkdirSync(out, { recursive: true })
  const old = runChild([process.execPath, path.join(FIX.oldPack, 'tools', 'build-offline-payload.js'), `--out=${out}`], {
    cwd: FIX.oldPack, timeoutMs: 240000,
  })
  const oldProduct = path.join(out, 'whale-reader')
  const rootFiles = exists(oldProduct)
    ? fs.readdirSync(oldProduct, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()
    : []
  const oldLicenses = rootFiles.filter((n) => /LICENSE/i.test(n))
  const oldTxt = `${old.out}${old.err}`
  h.eq(old.code, 0, `旧构建器（${BASE_COMMIT}）在"包内没有许可"时确实照样 exit 0（实得 ${old.code}）：${clip(oldTxt, 800)}`)
  h.assert(/没找到 Node 的 LICENSE/.test(oldTxt), `旧行为必须留下那句 console.warn（实得：${clip(oldTxt, 500)}）`)
  h.assert(rootFiles.includes('node.exe'), `旧产物里确实带了 node.exe（实得 ${JSON.stringify(rootFiles)}）`)
  h.eq(oldLicenses.length, 0, `旧产物里没有任何许可件（实得 ${JSON.stringify(oldLicenses)}）——这就是 G03 的"警告后继续产出"`)
  h.evidence('M02-old-behavior.txt', rows(
    `旧构建器：${BASE_COMMIT}:lib/pack-template/tools/build-offline-payload.js（与 publish-policy.cjs 成对取旧版）`,
    `exit=${old.code}`,
    `产物根文件：${JSON.stringify(rootFiles)}`,
    `许可件：${oldLicenses.length} 个 ${JSON.stringify(oldLicenses)}`,
    '--- 原始 stdout+stderr ---',
    clip(oldTxt, 6000),
  ))
  // 对照跑完就把 87 MB 的 node.exe 清掉（路径已核实属于本次夹具）
  if (oldProduct.startsWith(TMP)) fs.rmSync(out, { recursive: true, force: true })
}))

h.case('M03', 'pass', () => need(() => {
  const r = DL.verifyDistributionMaterials({ manifestPath: FIX.badLicSha, nodePath: NODE_BIN })
  h.eq(r.ok, false, '许可件字节被换掉（sha256 不符）必须 ok===false')
  h.assert(r.problems.some((p) => p.includes(LICENSE_NAME) && p.includes('sha256 不符')),
    `problem 要点名"sha256 不符 + 文件名"（实得 ${JSON.stringify(r.problems)}）`)
}))

h.case('M04', 'pass', () => need(() => {
  const r = DL.verifyDistributionMaterials({ manifestPath: FIX.badVersion, nodePath: NODE_BIN })
  h.eq(r.ok, false, 'manifest 写的 Node 版本与真二进制不符必须 ok===false')
  h.assert(r.problems.some((p) => /Node 版本不符/.test(p) && p.includes('0.0.0-test')),
    `problem 要点名 version（实得 ${JSON.stringify(r.problems)}）`)
}))

h.case('M05', 'pass', () => need(() => {
  const r = DL.verifyDistributionMaterials({ manifestPath: FIX.badNodeSha, nodePath: NODE_BIN })
  h.eq(r.ok, false, 'node 二进制的 sha256 不符必须 ok===false')
  h.assert(r.problems.some((p) => p.includes('node 二进制 sha256 不符')), `problem 要点名 node 的 sha256（实得 ${JSON.stringify(r.problems)}）`)
}))

h.case('M06', 'pass', () => need(() => {
  const r = DL.verifyDistributionMaterials({ manifestPath: FIX.noEvidence, nodePath: NODE_BIN })
  h.eq(r.ok, false, '缺 redistributionEvidence 必须 ok===false')
  h.assert(r.problems.some((p) => p.includes('redistributionEvidence')), `problem 要点名 redistributionEvidence（实得 ${JSON.stringify(r.problems)}）`)
}))

h.case('M07', 'pass', () => need(() => {
  // 坏 JSON / 错 schema：都要**返回 problems**，不许把调用方崩掉
  let badJsonThrew = null
  let badJson = null
  try { badJson = DL.verifyDistributionMaterials({ manifestPath: FIX.badJson, nodePath: NODE_BIN }) } catch (e) { badJsonThrew = e }
  h.eq(badJsonThrew, null, `坏 JSON 不许抛崩（实得：${badJsonThrew && badJsonThrew.message}）`)
  h.eq(badJson && badJson.ok, false, '坏 JSON 必须 ok===false')
  h.assert(Array.isArray(badJson.problems) && badJson.problems.length > 0, '坏 JSON 必须给出 problems 数组')

  let badSchemaThrew = null
  let badSchema = null
  try { badSchema = DL.verifyDistributionMaterials({ manifestPath: FIX.badSchema, nodePath: NODE_BIN }) } catch (e) { badSchemaThrew = e }
  h.eq(badSchemaThrew, null, `错 schema 不许抛崩（实得：${badSchemaThrew && badSchemaThrew.message}）`)
  h.eq(badSchema && badSchema.ok, false, '错 schema 必须 ok===false')
  h.assert(badSchema.problems.some((p) => p.includes('schema')), `错 schema 的 problem 要点名 schema（实得 ${JSON.stringify(badSchema.problems)}）`)
  h.evidence('M07-broken-manifest.txt', rows(
    `坏 JSON problems：${JSON.stringify(badJson.problems, null, 2)}`,
    `错 schema problems：${JSON.stringify(badSchema.problems, null, 2)}`,
  ))
}))

/* ══════════════════════════════════════════════════════════ P：payload 构建 */

h.case('P01', 'pass', () => need(() => {
  const out = path.join(TMP, 'out-p01')
  fs.mkdirSync(out, { recursive: true })
  const r = buildPayload(FIX.pack, [`--out=${out}`])
  const product = path.join(out, 'whale-reader')
  h.assert(r.code === 1, `正式构建缺 --node/--manifest 必须 exit 1（实得 ${r.code}）`)
  h.assert(/必须给 --node/.test(r.out + r.err), `要给出用法提示（实得：${clip(r.out + r.err, 800)}）`)
  h.eq(exists(product), false, `缺材料时不许产出 payload（${product}）`)
  h.evidence('P01-no-materials.txt', rows(`exit=${r.code}`, '--- stdout+stderr ---', clip(r.out + r.err, 4000), `产物存在=${exists(product)}`))
}))

h.case('P02', 'pass', () => need(() => {
  const out = path.join(TMP, 'out-p02')
  fs.mkdirSync(out, { recursive: true })
  const r = buildPayload(FIX.pack, [`--out=${out}`, `--node=${NODE_BIN}`, `--manifest=${FIX.missingManifest}`])
  const product = path.join(out, 'whale-reader')
  h.assert(r.code === 1, `用缺许可的 manifest 正式构建必须 exit 1（实得 ${r.code}）`)
  h.assert(/许可文件不存在/.test(r.out + r.err), `要逐条打印问题（实得：${clip(r.out + r.err, 1200)}）`)
  h.eq(exists(product), false, `失败时不许留下可误认正式包的半成品（${product}）`)
  h.eq(exists(path.join(product, 'node.exe')), false, '不许留下 node.exe')
  h.eq(exists(path.join(product, 'distribution-receipt.json')), false, '不许留下 distribution-receipt.json')
  const leftovers = fs.readdirSync(FIX.pack).filter((n) => n.startsWith('.tmp-publication-'))
  h.eq(leftovers.length, 0, `不许留暂存目录（实得 ${JSON.stringify(leftovers)}）`)
  h.evidence('P02-missing-license.txt', rows(`exit=${r.code}`, '--- stdout+stderr ---', clip(r.out + r.err, 4000), `产物存在=${exists(product)}`))
}))

h.case('P03', 'pass', () => need(() => {
  const r = FIX.p03
  h.eq(r.code, 0, `合法合成材料必须构建成功（实得 exit ${r.code}）：${clip(r.out + r.err, 2000)}`)
  const product = FIX.p03Product
  h.eq(exists(product), true, 'payload 必须产出')

  const receiptPath = path.join(product, 'distribution-receipt.json')
  h.eq(exists(receiptPath), true, 'payload 根必须有 distribution-receipt.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  h.eq(receipt.schema, DL.RECEIPT_SCHEMA, `receipt schema 逐字（实得 ${JSON.stringify(receipt.schema)}）`)
  h.eq(receipt.mode, 'public', `receipt mode 必须是 public（实得 ${JSON.stringify(receipt.mode)}）`)
  h.eq(receipt.verified, true, 'receipt verified 必须是 true')
  h.eq(receipt.manifestSha256, sha256File(FIX.goodManifest), 'receipt 的 manifestSha256 必须是 manifest 字节的 sha256')
  h.eq(Array.isArray(receipt.items) && receipt.items.length, 1, 'receipt items 必须是 manifest 的项')
  h.eq(receipt.items[0].name, 'node', 'receipt items[0].name === node')
  h.eq(receipt.items[0].version, NODE_VERSION, `receipt items[0].version === ${NODE_VERSION}（实得 ${receipt.items[0].version}）`)
  h.eq(receipt.items[0].sha256, NODE_SHA, 'receipt items[0].sha256 === 真二进制的 sha256')

  // 许可**聚合件**（T28-A2）：固定名 LICENSES.txt，节头逐字 `=== <name> <version> sha256:<sha256> ===`
  const licAgg = path.join(product, 'LICENSES.txt')
  h.eq(exists(licAgg), true, `许可正文必须聚合进固定名 ${LICENSES_NAME}（T28-A2）`)
  const licText = fs.readFileSync(licAgg, 'utf8')
  h.assert(licText.includes(`=== node ${NODE_VERSION} sha256:${NODE_SHA} ===`),
    `LICENSES.txt 的节头必须逐字是 "=== name version sha256:<hash> ==="（实得首行：${clip(licText.split('\n')[0], 300)}）`)
  h.assert(licText.includes('SYNTHETIC-LICENSE-FIXTURE'), 'LICENSES.txt 里必须有该 item 的许可原文（合成夹具自陈 SYNTHETIC）')
  h.assert(licText.includes('NOT A REAL LICENSE'), '聚合件里要原样保留"这不是真实许可"的自陈（不许冒充）')
  // 不许再拷动态 basename（那种名字不可能预先登记 ⇒ 必然撞"产物全集 == plan.files"）
  h.eq(exists(path.join(product, LICENSE_NAME)), false, `payload 根不许出现动态 basename 的许可件（${LICENSE_NAME}）`)

  // payload 根的文件集合必须**恰好**等于 plan.files 的根级条目（A10 不靠改 plan 通过）
  const PUB = require_(path.join(TEMPLATE, 'tools', 'publish-policy.cjs'))
  const plan = PUB.planPublication(FIX.pack, { kind: 'reader', withNode: true })
  const planRoot = plan.files.filter((f) => !f.includes('/')).sort()
  const gotRoot = fs.readdirSync(product, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()
  h.eq(JSON.stringify(gotRoot), JSON.stringify(planRoot), `payload 根文件集合必须与 plan.files 根级条目逐项相等（got=${JSON.stringify(gotRoot)} plan=${JSON.stringify(planRoot)}）`)

  // node.exe：就是 manifest 核过的那一个
  h.eq(sha256File(path.join(product, 'node.exe')), NODE_SHA, 'payload 里的 node.exe 必须是核过的那个二进制')
  h.eq(fs.existsSync(path.join(product, 'app', 'tools', 'offline-server.js')), true, 'app/ 骨架仍在（离线端要起得来）')

  // GBK 判据（字节层）：`.ps1` 首三字节必须是 EF BB BF
  const bInstall = fs.readFileSync(path.join(product, 'install.ps1'))
  const bUninstall = fs.readFileSync(path.join(product, 'uninstall.ps1'))
  const hex = (b) => [...b.slice(0, 3)].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ')
  h.eq(hex(bInstall), 'EF BB BF', `install.ps1 首三字节必须是 EF BB BF（实得 ${hex(bInstall)}）`)
  h.eq(hex(bUninstall), 'EF BB BF', `uninstall.ps1 首三字节必须是 EF BB BF（实得 ${hex(bUninstall)}）`)
  h.evidence('P03-official-build.txt', rows(
    `exit=${r.code}`,
    `--- stdout+stderr ---`,
    clip(r.out + r.err, 6000),
    `payload 根文件：${JSON.stringify(fs.readdirSync(product, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort())}`,
    `receipt：${JSON.stringify(receipt, null, 2)}`,
    `install.ps1 首三字节：${hex(bInstall)} · uninstall.ps1 首三字节：${hex(bUninstall)}`,
  ))
}))

h.case('P04', 'pass', () => need(() => {
  const out = path.join(TMP, 'out-p04')
  fs.mkdirSync(out, { recursive: true })
  const dev = buildPayload(FIX.pack, [`--out=${out}`, '--no-node'])
  h.eq(dev.code, 0, `--no-node 是开发产物，必须能构建成功（实得 ${dev.code}）：${clip(dev.out + dev.err, 1500)}`)
  const product = path.join(out, 'whale-reader')
  const receipt = JSON.parse(fs.readFileSync(path.join(product, 'distribution-receipt.json'), 'utf8'))
  h.eq(receipt.mode, 'dev', `--no-node 的 receipt mode 必须是 dev（实得 ${JSON.stringify(receipt.mode)}）`)
  h.eq(receipt.verified, false, '--no-node 的 verified 必须是 false')
  h.eq(receipt.items.length, 0, '--no-node 的 receipt.items 必须是空数组')
  h.assert(/DEV — 开发产物（未做再分发合规核验），不得发布/.test(dev.out), `stdout 必须写明 DEV 开发产物（实得：${clip(dev.out, 800)}）`)
  h.eq(exists(path.join(product, 'node.exe')), false, '--no-node 不许带 node.exe')
  h.eq(exists(path.join(product, LICENSE_NAME)), false, '--no-node 不许带任何许可件')
  const devLic = path.join(product, 'LICENSES.txt')
  h.eq(exists(devLic), true, '--no-node 也要写出**已登记**的固定名 LICENSES.txt（否则产物集合与 plan.files 两张皮）')
  h.assert(fs.readFileSync(devLic, 'utf8').includes('DEV — 开发产物（未做再分发合规核验），不得发布'),
    '开发产物的 LICENSES.txt 必须如实自陈"没有接入材料"，不许冒充许可正文')

  const mixed = buildPayload(FIX.pack, [`--out=${out}`, '--no-node', `--node=${NODE_BIN}`])
  h.assert(mixed.code === 1, `--no-node 与 --node/--manifest 同时给必须 exit 1（实得 ${mixed.code}）`)
  h.assert(/不能与 --node \/ --manifest 同时给/.test(mixed.out + mixed.err), `要给用法错（实得：${clip(mixed.out + mixed.err, 800)}）`)
  h.evidence('P04-dev-artifact.txt', rows(
    `--no-node exit=${dev.code}`,
    clip(dev.out + dev.err, 5000),
    `receipt=${JSON.stringify(receipt)}`,
    `--no-node + --node exit=${mixed.code}：${clip(mixed.out + mixed.err, 1200)}`,
  ))
}))

h.case('P05', 'pass', () => need(() => {
  const out = path.join(TMP, 'out-p05')
  const before = treeHash(FIX.pack)
  const r = buildPayload(FIX.pack, ['--plan', `--out=${out}`])
  const after = treeHash(FIX.pack)
  h.eq(r.code, 0, `--plan 不许被材料闸硬拦：无材料也必须 exit 0（实得 ${r.code}）：${clip(r.out + r.err, 1500)}`)
  const lines = String(r.out).trim().split(/\r?\n/).filter(Boolean)
  h.eq(lines.length, 1, `--plan 只许打印一行 JSON（实得 ${lines.length} 行）`)
  const plan = JSON.parse(lines[0])
  h.assert(/^[0-9a-f]{64}$/.test(plan.planDigest), '--plan 那一行必须有 planDigest')
  h.eq(exists(out), false, `--plan 不许写盘（${out} 不该被建出来）`)
  h.eq(after, before, '--plan 跑完源包必须逐字节未变')
  h.evidence('P05-plan-without-materials.txt', rows(`exit=${r.code}`, `stdout 行数=${lines.length}`, `planDigest=${plan.planDigest}`, `源包树 hash：${before} → ${after}`))
}))

h.case('P06', 'pass', () => need(() => {
  const product = FIX.p03Product
  const out = []
  for (const name of ['install.ps1', 'uninstall.ps1']) {
    const p = path.join(product, name)
    h.eq(exists(p), true, `${name} 必须在 payload 根`)
    const probe = psProbe(p)
    out.push(`${name}：首三字节 ${probe.first3} · hasBom=${probe.hasBom} · PS5.1 ParseFile 错误=${probe.fileErrors} · 无 BOM 字节按 GBK 解码后 ParseInput 错误=${probe.gbkErrors}`)
    h.eq(probe.hasBom, true, `${name} 必须带 UTF-8 BOM（实得首三字节 ${probe.first3}）`)
    h.eq(probe.fileErrors, 0, `${name} 在 PS 5.1 里必须 0 语法错（实得 ${probe.fileErrors}）`)
    // 反例：同一份字节**去掉 BOM** 后按 ANSI/GBK 解码 —— 这正是 T05 记录的旧缺陷形态
    h.assert(probe.gbkErrors > 0, `${name} 的旧形态（无 BOM）按 GBK 解码必须能复现语法错（实得 ${probe.gbkErrors}）`)
  }
  h.evidence('P06-gbk-bytes.txt', rows(
    '判据：payload 生成的 .ps1 首三字节必须是 EF BB BF（要么带 BOM、要么全 ASCII）。',
    '旧缺陷取证（越界观察）：audit-evidence/T05/out-of-scope-install-ps1-gbk.txt（无 BOM 时 install 4 错 / uninstall 1 错）。',
    ...out,
  ))
}))

/* ══════════════════════════════════════════════════════════ I：安装器硬闸 */

/** 给 installer 一个 fake payload 目录（可能带 receipt），返回跑一次的结果 */
function runInstaller(pack, { receipt = null, env = {} } = {}) {
  const payload = path.join(pack, 'dist-offline', 'whale-reader')
  fs.mkdirSync(payload, { recursive: true })
  if (receipt) fs.writeFileSync(path.join(payload, 'distribution-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  return runChild([process.execPath, path.join(pack, 'tools', 'build-offline-installer.js')], {
    cwd: pack, env, timeoutMs: 180000,
  })
}

h.case('I01', 'pass', () => need(() => {
  const pack = FIX.toolPack
  // 哨兵：`INNO_ISCC` 指到**一个目录**——真去调 ISCC 的话必然留下"编译"字样（这是本用例的判别器）
  const sentinel = path.join(TMP, 'iscc-sentinel-dir')
  fs.mkdirSync(sentinel, { recursive: true })
  const r = runInstaller(pack, { env: { INNO_ISCC: sentinel } })
  const txt = `${r.out}${r.err}`
  h.assert(r.code === 1, `payload 无 receipt 时 installer 必须 exit 1（实得 ${r.code}）：${clip(txt, 1500)}`)
  h.assert(txt.includes('✗ payload 不是核验过的正式产物'), `要打印那道硬闸的话（实得：${clip(txt, 1200)}）`)
  h.assert(txt.includes('（mode='), '闸的话里要点名 mode')
  h.assert(!txt.includes('用 ') || !txt.includes(' 编译…'), `不许走到"用 <iscc> 编译…"那一步（实得：${clip(txt, 1200)}）`)
  h.eq(/找不到 Inno Setup/.test(txt), false, '更不许落到"找不到 ISCC"那条路上（说明闸在 ISCC 之前）')
  h.evidence('I01-installer-no-receipt.txt', rows(`exit=${r.code}`, `INNO_ISCC=${sentinel}（目录哨兵）`, '--- stdout+stderr ---', clip(txt, 5000)))
}))

h.case('I02', 'pass', () => need(() => {
  const pack = FIX.toolPack
  const sentinel = path.join(TMP, 'iscc-sentinel-dir')
  const dev = runInstaller(pack, {
    receipt: { schema: DL.RECEIPT_SCHEMA, mode: 'dev', verified: false, items: [] },
    env: { INNO_ISCC: sentinel },
  })
  const devTxt = `${dev.out}${dev.err}`
  h.assert(dev.code === 1, `receipt mode=dev 时 installer 必须 exit 1（实得 ${dev.code}）：${clip(devTxt, 1500)}`)
  h.assert(devTxt.includes('✗ payload 不是核验过的正式产物'), `要打印硬闸的话（实得：${clip(devTxt, 1200)}）`)
  h.assert(devTxt.includes('mode=dev'), `要点名 mode=dev（实得：${clip(devTxt, 1200)}）`)
  h.assert(!devTxt.includes(' 编译…'), '不许走到编译那一步')

  // 正向对照：同一份 payload 换成核验过的正式 receipt ⇒ 闸必须**放行**（不能是"恒拦"）
  const ok = runInstaller(pack, {
    receipt: { schema: DL.RECEIPT_SCHEMA, mode: 'public', verified: true, manifestSha256: sha256File(FIX.goodManifest), items: [{ name: 'node', version: NODE_VERSION, sha256: NODE_SHA }] },
    // 把 ISCC 的所有探测根都指到空目录：既不会真的编译，也能看清"闸放行了"
    env: {
      INNO_ISCC: path.join(TMP, 'no-such-iscc', 'ISCC.exe'),
      ProgramFiles: path.join(TMP, 'no-such-pf'),
      'ProgramFiles(x86)': path.join(TMP, 'no-such-pf-86'),
      LOCALAPPDATA: path.join(TMP, 'no-such-local'),
    },
  })
  const okTxt = `${ok.out}${ok.err}`
  h.eq(okTxt.includes('不是核验过的正式产物'), false, `核验过的正式 receipt 必须放行（实得：${clip(okTxt, 1200)}）`)
  h.evidence('I02-installer-dev-receipt.txt', rows(
    `dev receipt：exit=${dev.code}`, clip(devTxt, 4000),
    `正向对照（public receipt）：exit=${ok.code}`, clip(okTxt, 4000),
  ))
}))

/* ══════════════════════════════════════════════════════════ B：bootstrap 如实回显 */

h.case('B01', 'pass', () => need(() => {
  const pack = FIX.toolPack
  const dest1 = path.join(TMP, 'bootstrap-dest-1')
  const r1 = runChild([process.execPath, path.join(pack, 'tools', 'offline-bootstrap.js'), dest1], { cwd: pack, timeoutMs: 180000 })
  h.eq(r1.code, 0, `bootstrap 必须能跑（实得 ${r1.code}）：${clip(r1.out + r1.err, 1200)}`)
  h.assert(String(r1.out).includes('模式：dev（未做再分发合规核验）'), `无 receipt 时必须如实打印 dev 模式（实得：${clip(r1.out, 800)}）`)
  h.eq(/已核验/.test(`${r1.out}${r1.err}`), false, `任何路径都不许输出"已核验"（实得：${clip(r1.out + r1.err, 800)}）`)

  // 有 receipt 的那一支：只回显 mode，不许自己下"合规"结论
  fs.writeFileSync(path.join(pack, 'distribution-receipt.json'), `${JSON.stringify({ schema: DL.RECEIPT_SCHEMA, mode: 'dev', verified: false, items: [] }, null, 2)}\n`, 'utf8')
  const dest2 = path.join(TMP, 'bootstrap-dest-2')
  const r2 = runChild([process.execPath, path.join(pack, 'tools', 'offline-bootstrap.js'), dest2], { cwd: pack, timeoutMs: 180000 })
  fs.rmSync(path.join(pack, 'distribution-receipt.json'), { force: true })
  h.eq(r2.code, 0, `有 receipt 时 bootstrap 也必须能跑（实得 ${r2.code}）`)
  h.assert(String(r2.out).includes('模式：dev（verified=false）'), `有 receipt 时要回显 mode（实得：${clip(r2.out, 800)}）`)
  h.eq(/已核验/.test(`${r2.out}${r2.err}`), false, '有 receipt 也不许说"已核验"（它没有核验能力）')
  h.evidence('B01-bootstrap-mode-echo.txt', rows(
    `无 receipt：exit=${r1.code}`, clip(r1.out, 3000),
    `有 receipt（mode=dev/verified=false）：exit=${r2.code}`, clip(r2.out, 3000),
  ))
}))

/* ══════════════════════════════════════════════════════════ R：发布检查器 */

h.case('R01', 'pass', () => need(() => {
  const r = runChild([process.execPath, path.join(REPO, 'test', 'audit', 'release.mjs')], { cwd: REPO, timeoutMs: 180000 })
  const out = String(r.out)
  const findingLines = out.split(/\r?\n/).filter((l) => l.startsWith('发现 '))
  h.assert(r.code !== 0, `release.mjs 必须**非零**（实得 ${r.code}）：私模式 + 缺材料 + 4 个 blocked 发现`)
  h.eq(findingLines.length, 24, `必须固定枚举 24 个发现（实得 ${findingLines.length}）`)
  h.assert(out.includes('发现 G03 waived'), `G03 必须按用户裁定记 waived（实得：${clip(out, 1500)}）`)
  h.assert(out.includes('未做再分发合规核验'), `私模式必须打印「未做再分发合规核验」（实得：${clip(out, 1200)}）`)
  h.assert(out.includes('waivers.json'), `必须引用 audit-evidence/waivers.json（实得：${clip(out, 1200)}）`)
  h.assert(/BLOCKED release findings=24/.test(out), `结论行必须是 BLOCKED release findings=24（实得：${clip(out.split(/\r?\n/).slice(-3).join('\n'), 600)}）`)

  const j = runChild([process.execPath, path.join(REPO, 'test', 'audit', 'release.mjs'), '--json'], { cwd: REPO, timeoutMs: 180000 })
  const parsed = JSON.parse(String(j.out).trim())
  h.eq(parsed.schema, 'whale-release/1', '--json 的 schema 逐字')
  h.eq(parsed.findings, 24, '--json findings=24')
  h.eq(parsed.distribution.mode, 'private', '--json distribution.mode=private')
  h.eq(parsed.distribution.verified, false, '--json distribution.verified=false')
  h.eq(parsed.distribution.waiver, 'T29', '--json distribution.waiver=T29')
  h.eq(parsed.ok, false, '--json ok=false')
  h.assert(j.code !== 0, `--json 也必须非零（实得 ${j.code}）`)

  // 反空转：旧 revision 里根本**没有**发布入口（所以"旧行为"是"无人拦"）
  const oldRelease = spawnSync('git', ['cat-file', '-e', `${BASE_COMMIT}:test/audit/release.mjs`], { cwd: REPO })
  const oldCheck = spawnSync('git', ['cat-file', '-e', `${BASE_COMMIT}:tools/check-distribution.mjs`], { cwd: REPO })
  h.assert(oldRelease.status !== 0, `${BASE_COMMIT} 里不该有 test/audit/release.mjs（否则反空转不成立）`)
  h.assert(oldCheck.status !== 0, `${BASE_COMMIT} 里不该有 tools/check-distribution.mjs`)

  // 分发入口本体（T28 §3.2）：私模式**永远**非零，公模式缺参数也算用法错 —— 任何路径都不许把 private 记成 ok
  const cd = runChild([process.execPath, path.join(REPO, 'tools', 'check-distribution.mjs')], { cwd: REPO, timeoutMs: 120000 })
  const cdTxt = `${cd.out}${cd.err}`
  h.eq(cd.code, 2, `check-distribution 私模式必须 exit 2（实得 ${cd.code}）`)
  h.assert(cdTxt.includes('PRIVATE MODE — 未做再分发合规核验'), `私模式必须打印这句（实得：${clip(cdTxt, 800)}）`)
  h.assert(cdTxt.includes('waivers.json') && cdTxt.includes('T29=WAIVED'), `私模式必须引用 waivers.json 的裁定（实得：${clip(cdTxt, 800)}）`)
  const cdj = runChild([process.execPath, path.join(REPO, 'tools', 'check-distribution.mjs'), '--json'], { cwd: REPO, timeoutMs: 120000 })
  const cdJson = JSON.parse(String(cdj.out).trim())
  h.eq(cdJson.schema, 'whale-distribution-check/1', '--json 的 schema 逐字')
  h.eq(cdJson.mode, 'private', '--json mode=private')
  h.eq(cdJson.verified, false, '--json verified=false')
  h.eq(cdJson.waiver, 'T29', '--json waiver=T29')
  h.eq(cdj.code, 2, `--json 也必须 exit 2（实得 ${cdj.code}）`)
  const noMat = runChild([process.execPath, path.join(REPO, 'tools', 'check-distribution.mjs'), '--mode=public'], { cwd: REPO, timeoutMs: 120000 })
  h.eq(noMat.code, 2, `--mode=public 缺 --manifest/--node 必须 exit 2（实得 ${noMat.code}）`)
  const bogus = runChild([process.execPath, path.join(REPO, 'tools', 'check-distribution.mjs'), '--mode=bogus'], { cwd: REPO, timeoutMs: 120000 })
  h.eq(bogus.code, 2, `--mode 写错必须 exit 2（不许静默回落；实得 ${bogus.code}）`)

  h.evidence('R01-release-run.txt', rows(
    `release exit=${r.code}`, '--- release stdout ---', clip(out, 12000),
    `--- release --json exit=${j.code} ---`, JSON.stringify(parsed, null, 2),
    `${BASE_COMMIT}:test/audit/release.mjs → cat-file exit=${oldRelease.status}（不存在）`,
    `${BASE_COMMIT}:tools/check-distribution.mjs → cat-file exit=${oldCheck.status}（不存在）`,
    `--- check-distribution 私模式 exit=${cd.code} ---`, clip(cdTxt, 3000),
    `check-distribution --json exit=${cdj.code}：${JSON.stringify(cdJson)}`,
    `check-distribution --mode=public（缺材料）exit=${noMat.code}：${clip(`${noMat.out}${noMat.err}`, 800)}`,
    `check-distribution --mode=bogus exit=${bogus.code}：${clip(`${bogus.out}${bogus.err}`, 800)}`,
  ))
}))

h.case('R02', 'pass', () => need(() => {
  // 伪造一份「全部 PASS」的验收台账：私模式 + 缺材料**仍然**必须非零
  const fake = path.join(TMP, 'fake-repo')
  fs.mkdirSync(path.join(fake, 'audit-evidence'), { recursive: true })
  fs.mkdirSync(path.join(fake, 'test', 'audit'), { recursive: true })
  fs.mkdirSync(path.join(fake, 'tools'), { recursive: true })
  fs.mkdirSync(path.join(fake, 'lib', 'pack-template', 'tools'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'test', 'audit', 'release.mjs'), path.join(fake, 'test', 'audit', 'release.mjs'))
  fs.copyFileSync(path.join(REPO, 'tools', 'check-distribution.mjs'), path.join(fake, 'tools', 'check-distribution.mjs'))
  fs.copyFileSync(path.join(REPO, 'lib', 'pack-template', 'tools', 'distribution-license.cjs'), path.join(fake, 'lib', 'pack-template', 'tools', 'distribution-license.cjs'))
  fs.copyFileSync(path.join(REPO, 'audit-evidence', 'findings-map.json'), path.join(fake, 'audit-evidence', 'findings-map.json'))
  fs.copyFileSync(path.join(REPO, 'audit-evidence', 'waivers.json'), path.join(fake, 'audit-evidence', 'waivers.json'))
  fs.writeFileSync(path.join(fake, 'package.json'), `${JSON.stringify({ name: 'fake', dsh: { distribution: { mode: 'private' } } }, null, 2)}\n`, 'utf8')
  const map = JSON.parse(fs.readFileSync(path.join(REPO, 'audit-evidence', 'findings-map.json'), 'utf8'))
  const cards = [...new Set(map.findings.flatMap((f) => f.cards.map(String)))]
  const results = cards.map((id) => (id === 'T29'
    ? { id, verdict: 'WAIVED', code: null, line: `WAIVED ${id} :: 用户弃权` }
    : { id, verdict: 'PASS', code: 0, line: `PASS ${id} checks=999 failed=0 skipped=0` }))
  fs.writeFileSync(path.join(fake, 'audit-evidence', 'planner-acceptance-summary.json'),
    `${JSON.stringify({ schema: 'whale-planner-acceptance/1', results }, null, 2)}\n`, 'utf8')

  const r = runChild([process.execPath, path.join(fake, 'test', 'audit', 'release.mjs')], { cwd: fake, timeoutMs: 180000 })
  const out = String(r.out)
  h.assert(r.code !== 0, `伪造"全 PASS"也不许返 0（实得 ${r.code}）：私模式 + 没核验过材料`)
  h.assert(out.includes('未做再分发合规核验'), `私模式行必须还在（实得：${clip(out, 1200)}）`)
  h.eq(/发现 \w+ blocked/.test(out), false, '（夹具前提）伪造台账里不该有 blocked 发现')
  h.eq(/发现 \w+ open/.test(out), false, '（夹具前提）伪造台账里不该有 open 发现')

  const j = runChild([process.execPath, path.join(fake, 'test', 'audit', 'release.mjs'), '--json'], { cwd: fake, timeoutMs: 180000 })
  const parsed = JSON.parse(String(j.out).trim())
  h.eq(parsed.tally.blocked, 0, '伪造台账的 blocked 必须是 0（否则这条判据是空转）')
  h.eq(parsed.tally.open, 0, '伪造台账的 open 必须是 0')
  h.eq(parsed.distribution.verified, false, '--json 里 verified 必须是 false')
  h.eq(parsed.ok, false, '--json 里 ok 必须是 false（全 PASS 也不能变绿）')
  h.assert(j.code !== 0, `--json 也必须非零（实得 ${j.code}）`)
  h.evidence('R02-forged-all-pass.txt', rows(
    `exit=${r.code}`, '--- stdout ---', clip(out, 8000),
    `--- --json exit=${j.code} ---`, JSON.stringify(parsed, null, 2),
    `伪造台账卡数=${cards.length}（T29=WAIVED，其余全 PASS）`,
  ))
}))

/* ══════════════════════════════════════════════════════════ C：声明与闭包 */

h.case('C01', 'pass', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  h.assert(pkg.dsh && pkg.dsh.distribution, 'package.json 必须有 dsh.distribution（显式模式声明）')
  h.eq(pkg.dsh.distribution.mode, 'private', `dsh.distribution.mode 必须是 private（T29 弃权后不写 public；实得 ${JSON.stringify(pkg.dsh.distribution.mode)}）`)
  h.assert(Array.isArray(pkg.files) && pkg.files.includes('docs'), `package.json#files 必须含 docs（T27 的 docs/capabilities.md 要随包发；实得 ${JSON.stringify(pkg.files)}）`)
  h.eq(fs.existsSync(path.join(REPO, 'docs', 'capabilities.md')), true, '（前提）docs/capabilities.md 真的在')
  h.eq(pkg.dsh.bundle && pkg.dsh.bundle.patch, './cordis.patch.yml', '既有的 dsh.bundle 声明不许被改动')
  h.eq(DL.modeOf(path.join(REPO, 'package.json')), 'private', 'modeOf 读出来也必须是 private')
  h.evidence('C01-package-declaration.txt', rows(JSON.stringify(pkg.dsh, null, 2), `files=${JSON.stringify(pkg.files)}`))
})

h.case('C02', 'pass', () => need(() => {
  // ① 新件在模板里
  const dlAbs = path.join(TEMPLATE, 'tools', 'distribution-license.cjs')
  h.eq(exists(dlAbs), true, 'distribution-license.cjs 必须存在于模板目录')
  // ② 引擎闭包把它排除（否则 T18 的 L06 会判"模板里有、清单里没有"）
  const ENGINE = require_(path.join(TEMPLATE, 'tools', 'engine-files.cjs'))
  h.eq(ENGINE.CODE_EXCLUDE.includes('tools/distribution-license.cjs'), true,
    `CODE_EXCLUDE 必须登记它（实得 ${JSON.stringify(ENGINE.CODE_EXCLUDE)}）`)
  h.eq(ENGINE.engineFiles({ profile: 'pack' }).includes('tools/distribution-license.cjs'), false,
    '它不该出现在随包代码闭包里（它属于离线安装器通道）')
  // ③ 产物集合登记：**用发布计划**证明（不是 grep 源码）
  const PUB = require_(path.join(TEMPLATE, 'tools', 'publish-policy.cjs'))
  const readerPlan = PUB.planPublication(FIX.pack, { kind: 'reader', withNode: false })
  for (const name of ['distribution-receipt.json', 'LICENSES.txt']) {
    h.assert(readerPlan.files.includes(name),
      `reader 档的 plan.files 必须登记 ${name}（实得根级条目 ${JSON.stringify(readerPlan.files.filter((f) => !f.includes('/')))}）`)
  }
  const publicPlan = PUB.planPublication(FIX.publicPack, { kind: 'public' })
  h.eq(publicPlan.files.includes('distribution-receipt.json'), false, '公开站产物里不该有这份回执（它是离线 payload 的包装件）')
  h.eq(publicPlan.files.includes('LICENSES.txt'), false, '公开站产物里不该有许可聚合件（同上）')
  h.evidence('C02-packaging-closure.txt', rows(
    `CODE_EXCLUDE=${JSON.stringify(ENGINE.CODE_EXCLUDE)}`,
    `reader 根级件=${JSON.stringify(readerPlan.files.filter((f) => !f.includes('/')))}`,
    `public 是否含 receipt=${publicPlan.files.includes('distribution-receipt.json')}`,
  ))
}))

/* ══════════════════════════════════════════════════════════ 收尾 */

/**
 * 清理本次夹具。**清理前核实绝对路径确实属于本次夹具**（T28 的夹具按卡面要求落在 E:/Temp，
 * 不在 os.tmpdir() 下 —— 所以不用 harness 的 cleanupTempDir，自己按同一条纪律核实）。
 */
function cleanupLocal(dir) {
  const abs = path.resolve(String(dir))
  const root = path.resolve('E:/Temp')
  const inside = abs.startsWith(root + path.sep)
  const named = path.basename(abs).startsWith('whale-T28-cases-')
  if (!inside || !named) {
    return { removed: false, error: `拒绝清理：${abs} 不属于本次夹具（需在 ${root} 下且名字以 whale-T28-cases- 开头）` }
  }
  try {
    fs.rmSync(abs, { recursive: true, force: true })
    return { removed: true, error: null }
  } catch (e) {
    return { removed: false, error: `清理失败：${e && e.message ? e.message : String(e)}` }
  }
}

const cleaned = cleanupLocal(TMP)
ev.push(`夹具清理：${cleaned.removed ? '已删' : '未删'} ${TMP}${cleaned.error ? `（${cleaned.error}）` : ''}`)
h.note(ev.join('\n'))
h.note(`判据摘要：node=${NODE_VERSION}（真二进制 ${budget(fs.statSync(NODE_BIN).size)}）· 许可夹具 = SYNTHETIC-LICENSE-FIXTURE`)
const code = h.run()
process.exit(code)
