/**
 * lib/engine.js — **受信引擎闭包**：核验 / 升级计划 / 显式升级（T04 / 报告 D01）
 * ------------------------------------------------------------------
 * 报告 D01 的事实（证据行号）：
 *   · `lib/pack-server.js#L87-L118` —— 宿主 `createRequire(包)` 直接 **require 包里的**
 *     `tools/app-server.js`；
 *   · `lib/rebuild-job.js#L75-L96` —— 宿主 `spawn(process.execPath, [包内脚本])`；
 *   · `lib/pack-template/tools/offline-server.js#L427-L444` —— 离线阅读器同样按包内脚本起服务。
 *   三处执行的都是**课程包里可写的那份代码** ⇒ 换掉一个字节，宿主下一次预览 / 重建就跑别人的代码。
 *
 * 本模块给三处调用点提供**同一份**前置核验与升级手段：
 *
 *   verifyEngine(root, expectedManifest) → {ok, digest, missing, mismatched}
 *   planEngineUpgrade(root)              → {files, beforeHashes, planDigest}
 *   applyEngineUpgrade(root, {confirm, planDigest})
 *   trustedManifest()                    → 插件**自己模板**的那份受信清单
 *
 * 判据口径（**唯一一份实现**在 `lib/pack-template/tools/engine-policy.cjs`，本文件只做再导出 +
 * 升级那一半）：
 *   · 清单 = **仓内明确代码清单**（`ENGINE_FILES`）逐件 SHA-256；涵盖传递 require / import
 *     与构建子进程（闭包怎么算出来的写在那个文件的注释里，判据在 `test/audit/T04.mjs` 重算）。
 *   · **不信导入包自带的清单**：受信清单只从插件模板算（`trustedManifest`）。
 *   · 缺件 / 字节不一致 / 空清单 → `ok:false`；调用方必须**零 require / 零 spawn** 地拒绝。
 *   · 升级源**只取插件模板**（`TEMPLATE_DIR`），不接受调用方给任意来源路径。
 *   · 备份失败**不得替换**；计划过期（digest 对不上）拒绝；目标**是软链**拒绝。
 *
 * 边界（说清，别当它是沙箱）：
 *   这是**引擎一致性核验**，不是任意数据沙箱。学生自己的课、笔记、代码、台账**不在**清单里，
 *   它们变了不影响核验；把"哈希匹配"说成"任意数据沙箱"是错的（本卡 outOfScope 明写）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { TEMPLATE_DIR } from './pack-scaffold.js'

const requireCJS = createRequire(import.meta.url)

/** 受信引擎口径的唯一实现（随包发的那一份，与课程包侧**同一个文件**） */
const policy = requireCJS(path.join(TEMPLATE_DIR, 'tools', 'engine-policy.cjs'))

export const MANIFEST_VERSION = policy.MANIFEST_VERSION
/** 受信引擎闭包（仓内明确代码清单，POSIX 相对路径） */
export const ENGINE_FILES = policy.ENGINE_FILES
/** 入口注册表（固定：预览 / 答疑归档 / 笔记 / 重建 / 术语） */
export const ENTRY_REGISTRY = policy.ENTRY_REGISTRY
export const buildManifest = policy.buildManifest
export const verifyEngine = policy.verifyEngine
export const digestOfManifest = policy.digestOfManifest
export const sha256 = policy.sha256
export const registryScripts = policy.registryScripts
export const checkRegistry = policy.checkRegistry
export const summarizeFailure = policy.summarizeFailure

/** 升级时**不进**备份、也不算"改动"的临时件前缀 */
const TMP_PREFIX = '.tmp-engine-'
/** 备份目录名前缀（在包根下；`<prefix><时间戳>`） */
const BACKUP_PREFIX = '.engine-backup-'

/**
 * 插件**自己模板**的受信清单（唯一可信来源；**绝不**读包自带的清单）。
 * @returns {object} 与 `buildManifest` 同形
 */
export function trustedManifest() {
  return buildManifest(TEMPLATE_DIR)
}

/**
 * 一次核验的**人话**结论（调用方直接贴进 error / note）。
 * @param {{ok:boolean, missing:string[], mismatched:object[]}} v
 * @param {string} [what] 主语（如「预览服务」）
 */
export function engineVerdict(v, what = '引擎') {
  if (v && v.ok) return `${what}与插件受信版本一致`
  const parts = []
  if (v && v.missing && v.missing.length) parts.push(`缺 ${v.missing.length} 件（${v.missing.slice(0, 3).join('、')}${v.missing.length > 3 ? ' …' : ''}）`)
  if (v && v.mismatched && v.mismatched.length) parts.push(`字节不一致 ${v.mismatched.length} 件（${v.mismatched.slice(0, 3).map((m) => m.path).join('、')}${v.mismatched.length > 3 ? ' …' : ''}）`)
  return `${what}与插件受信版本不一致：${parts.join('；') || (v && v.error) || '核验不通过'}`
}

/* ── 升级计划 ─────────────────────────────────────────────────────────── */

/** 一条计划项的形状（给判据与 CLI 共用） */
function planItem(rel, before, after) {
  return {
    path: rel,
    action: before === null ? 'add' : 'replace',
    before,
    after,
    bytes: after.bytes,
  }
}

/**
 * 算一份**升级计划**（**只读、不写盘**）。
 *
 * `files` 只列**真的要动**的那些（`after` 与包内现况不同的）；已经一致的不列。
 * `beforeHashes` = 包里**现在**的字节（`null` = 现在没有这一件）。
 * `planDigest` 覆盖「清单 + 包里现况 + 模板目标字节」——所以它同时是
 *   · **计划身份**（`--apply` 必须回同一个 digest），
 *   · **过期判据**（计划算完之后包又变了 → 重算的 digest 不同 → 拒绝）。
 *
 * @param {string} root 课程包根
 * @returns {{ok:boolean, root?:string, source?:string, files?:object[], beforeHashes?:object,
 *            planDigest?:string, upToDate?:boolean, error?:string}}
 */
export function planEngineUpgrade(root) {
  const abs = path.resolve(String(root ?? ''))
  if (!String(root ?? '').trim()) return { ok: false, error: '没有课程包根目录' }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { ok: false, error: `课程包根不存在或不是目录：${abs}` }
  }

  // 来源**只取插件模板**（不接受调用方给任意来源路径）
  const src = TEMPLATE_DIR
  const missingSrc = ENGINE_FILES.filter((rel) => {
    const p = path.join(src, ...rel.split('/'))
    try { return !fs.statSync(p).isFile() } catch { return true }
  })
  if (missingSrc.length) {
    return { ok: false, error: `插件模板不完整（缺 ${missingSrc.length} 件引擎件）：${missingSrc.slice(0, 5).join('、')}` }
  }

  const files = []
  const beforeHashes = {}
  for (const rel of ENGINE_FILES) {
    const target = path.join(abs, ...rel.split('/'))
    const source = path.join(src, ...rel.split('/'))

    // 目标**是软链 / 目录联接**：拒绝（写进去只会穿过链接落到别处，包内那一件仍是旧的；
    // 而核验读的正是包内那一件 —— 两边不一致比不升级更坏）。列进 files 让 CLI 报清楚。
    let lst = null
    try { lst = fs.lstatSync(target) } catch { /* 不存在 = add */ }
    if (lst && lst.isSymbolicLink()) {
      files.push({ path: rel, action: 'reject', before: null, after: null, why: '目标是软链 / 目录联接 —— 拒绝替换' })
      beforeHashes[rel] = null
      continue
    }

    const srcBuf = fs.readFileSync(source)
    const afterHash = sha256(srcBuf)
    let beforeHash = null
    if (lst && lst.isFile()) beforeHash = sha256(fs.readFileSync(target))
    beforeHashes[rel] = beforeHash
    if (beforeHash !== afterHash) files.push(planItem(rel, beforeHash, { sha256: afterHash, bytes: srcBuf.length }))
  }

  const planDigest = digestOfPlan({ root: abs, source: src, files, beforeHashes })
  return {
    ok: true,
    root: abs,
    source: src,
    files,
    beforeHashes,
    planDigest,
    upToDate: files.length === 0,
  }
}

/**
 * 计划摘要：覆盖「根 + 来源 + 每项的目标字节 + 每项的现况字节」。
 * 纯函数 —— 同样输入永远同样摘要（判据可复算）。
 */
export function digestOfPlan({ root, source, files, beforeHashes }) {
  const rows = [...(files ?? [])]
    .map((f) => `${f.path}\t${f.action}\t${(f.after && f.after.sha256) || ''}`)
    .sort()
  const before = Object.keys(beforeHashes ?? {}).sort().map((k) => `${k}\t${beforeHashes[k] ?? ''}`)
  const text = [
    `plan=${MANIFEST_VERSION}`,
    `root=${path.resolve(String(root ?? ''))}`,
    `source=${path.resolve(String(source ?? ''))}`,
    ...rows,
    '--before--',
    ...before,
  ].join('\n')
  return sha256(Buffer.from(text, 'utf8'))
}

/* ── 显式升级 ─────────────────────────────────────────────────────────── */

/**
 * **显式升级**：把插件模板的引擎件铺进这个包（**先备份，再替换**）。
 *
 * 三道闸，缺一不可：
 *   ① `confirm === true` —— 学生点头了才动盘；
 *   ② `planDigest` 必须是**当下**重算出来的那一个 —— 计划过期（包在算完计划之后又变了）拒绝；
 *   ③ 目标是软链 → 拒绝（见 `planEngineUpgrade`）。
 *
 * 备份语义：**备份失败不得替换**。先把**全部**要动的件备份进
 * `<root>/.engine-backup-<时间戳>/`（含 `plan.json`），备份全成了才开始替换。
 * 替换用「同目录唯一临时文件 + rename」原子落地；中途失败 → **就地回滚**（从备份还原、
 * 删掉本次新增的、清掉临时件），并把失败如实回报。
 *
 * @param {string} root
 * @param {{confirm?:boolean, planDigest?:string, now?:() => number}} [opts]
 * @returns {{ok:boolean, root?:string, planDigest?:string, replaced?:string[], added?:string[],
 *            backupDir?:string, rolledBack?:boolean, error?:string}}
 */
export function applyEngineUpgrade(root, { confirm = false, planDigest = '', now } = {}) {
  if (confirm !== true) {
    return { ok: false, error: '升级会覆盖包里的引擎件 —— 必须显式确认（--confirm）才动盘' }
  }
  const abs = path.resolve(String(root ?? ''))
  if (!String(root ?? '').trim()) return { ok: false, error: '没有课程包根目录' }
  if (!planDigest || typeof planDigest !== 'string') {
    return { ok: false, error: '没给计划摘要（--plan-digest=<digest>）—— 没有它就无法判"这份计划还是不是当初那一份"' }
  }

  const plan = planEngineUpgrade(abs)
  if (!plan.ok) return { ok: false, error: plan.error }
  if (plan.planDigest !== planDigest) {
    return {
      ok: false,
      error: `计划过期或对不上（当下重算的摘要 ${plan.planDigest} ≠ 你给的 ${planDigest}）—— `
        + '包里那些引擎件在算完计划之后又变过，重新跑一次 --plan 再提交',
    }
  }
  const rejected = (plan.files || []).filter((f) => f.action === 'reject')
  if (rejected.length) {
    return { ok: false, error: `拒绝替换软链目标：${rejected.map((f) => f.path).join('、')}（写进去会穿过链接落到别处）` }
  }
  if (!plan.files.length) {
    return { ok: true, root: abs, planDigest, replaced: [], added: [], backupDir: null, rolledBack: false, note: '已经与插件受信引擎一致，没有要动的件' }
  }

  // ── ① 备份（**全部**备份成功才继续）────────────────────────────────
  const stamp = typeof now === 'function' ? String(now()) : String(Date.now())
  const backupDir = path.join(abs, `${BACKUP_PREFIX}${stamp}`)
  const replaced = []
  const added = []
  try {
    fs.mkdirSync(backupDir, { recursive: true })
    for (const f of plan.files) {
      if (f.action !== 'replace') continue
      const target = path.join(abs, ...f.path.split('/'))
      const dst = path.join(backupDir, ...f.path.split('/'))
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(target, dst)
    }
    fs.writeFileSync(path.join(backupDir, 'plan.json'), `${JSON.stringify({
      planDigest, root: abs, source: plan.source, files: plan.files.map((f) => ({ path: f.path, action: f.action, before: f.before, after: f.after })),
    }, null, 2)}\n`, 'utf8')
  } catch (e) {
    // 备份没成 → **一件都不替换**（卡面原文：「备份失败不得替换」）
    try { fs.rmSync(backupDir, { recursive: true, force: true }) } catch { /* 清理尽力而为 */ }
    return { ok: false, error: `备份失败（${e && e.message ? e.message : e}）—— 已中止，包里一件都没动` }
  }

  // ── ② 替换（原子：同目录临时件 + rename）──────────────────────────
  const done = []
  const restore = () => {
    for (const f of done.slice().reverse()) {
      const target = path.join(abs, ...f.path.split('/'))
      try {
        if (f.action === 'add') { fs.rmSync(target, { force: true }) } else {
          const src = path.join(backupDir, ...f.path.split('/'))
          const tmp = `${target}.${TMP_PREFIX}${process.pid}`
          fs.copyFileSync(src, tmp)
          fs.renameSync(tmp, target)
        }
      } catch { /* 回滚尽力而为；下面如实报 */ }
    }
  }

  try {
    for (const f of plan.files) {
      const target = path.join(abs, ...f.path.split('/'))
      const source = path.join(plan.source, ...f.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const tmp = `${target}.${TMP_PREFIX}${process.pid}`
      fs.copyFileSync(source, tmp)
      fs.renameSync(tmp, target)
      done.push(f)
      if (f.action === 'add') added.push(f.path)
      else replaced.push(f.path)
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    restore()
    return {
      ok: false,
      root: abs,
      planDigest,
      replaced,
      added,
      backupDir,
      rolledBack: true,
      error: `升级中途失败（${msg}）—— 已就地回滚到升级前（备份留在 ${backupDir}）`,
    }
  }

  return { ok: true, root: abs, planDigest, replaced, added, backupDir, rolledBack: false, note: `已升级 ${replaced.length + added.length} 件（备份在 ${backupDir}）` }
}

/**
 * 从一份备份目录**显式回滚**（`applyEngineUpgrade` 自动回滚之外的"人工后悔"口）。
 * 只认**本模块**写出来的备份（`plan.json` 必须在、`root` 必须与传入的根一致）。
 *
 * @param {string} root
 * @param {{confirm?:boolean, backupDir?:string}} [opts]
 */
export function rollbackEngineUpgrade(root, { confirm = false, backupDir = '' } = {}) {
  if (confirm !== true) return { ok: false, error: '回滚会覆盖包里的引擎件 —— 必须显式确认（--confirm）' }
  const abs = path.resolve(String(root ?? ''))
  const dir = path.resolve(String(backupDir ?? ''))
  if (!backupDir) return { ok: false, error: '没给备份目录' }
  if (!dir.startsWith(abs + path.sep) || !path.basename(dir).startsWith(BACKUP_PREFIX)) {
    return { ok: false, error: `拒绝：${dir} 不是这个包里的引擎备份目录（须在 ${abs} 下且以 ${BACKUP_PREFIX} 开头）` }
  }
  const planFile = path.join(dir, 'plan.json')
  let rec = null
  try { rec = JSON.parse(fs.readFileSync(planFile, 'utf8')) } catch (e) {
    return { ok: false, error: `读不到备份里的 plan.json：${e && e.message ? e.message : e}` }
  }
  if (path.resolve(String(rec.root ?? '')) !== abs) {
    return { ok: false, error: `备份记录的根（${rec.root}）与传入的根（${abs}）不是同一个 —— 拒绝` }
  }
  const restored = []
  const removed = []
  try {
    for (const f of rec.files ?? []) {
      const target = path.join(abs, ...String(f.path).split('/'))
      const src = path.join(dir, ...String(f.path).split('/'))
      if (f.action === 'add') { fs.rmSync(target, { force: true }); removed.push(f.path); continue }
      if (!fs.existsSync(src)) return { ok: false, error: `备份里缺 ${f.path} —— 拒绝半套回滚` }
      const tmp = `${target}.${TMP_PREFIX}${process.pid}`
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(src, tmp)
      fs.renameSync(tmp, target)
      restored.push(f.path)
    }
  } catch (e) {
    return { ok: false, error: `回滚失败（${e && e.message ? e.message : e}）—— 备份仍在 ${dir}`, restored, removed }
  }
  return { ok: true, root: abs, backupDir: dir, restored, removed, note: `已回滚 ${restored.length} 件、移除 ${removed.length} 件` }
}

/** 插件模板里那份引擎清单的摘要（给界面/日志一个"我们认的是哪一版"的指纹） */
export function trustedDigest() {
  return trustedManifest().digest
}

/** 供判据用：备份目录名常量 */
export const ENGINE_BACKUP_PREFIX = BACKUP_PREFIX
/** 供判据用：临时件前缀 */
export const ENGINE_TMP_PREFIX = TMP_PREFIX
/** 供判据用：`crypto` 的同一份实现（别在别处再写一份 sha256 口径） */
export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
