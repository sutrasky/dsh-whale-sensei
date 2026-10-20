#!/usr/bin/env node
/**
 * tools/sync-unify-core.mjs — **权威内核 → 随包副本**的唯一生成器（U19）
 * ==================================================================
 * U-SPEC §5：`lib/unify/*.cjs` 是**唯一手工源码**；随包那份 `lib/pack-template/tools/unify/*.cjs`
 * 是**逐字节生成物**，禁止手改。本文件就是那个生成器 —— `--write` 写、`--check` 对拍。
 *
 * 为什么必须有个生成器（而不是"拷一次就算"）：
 *   包侧（`<包>/tools/*.js` / `<包>/assets/*.js`）现在只 `require('./unify/<模块>.cjs')`，
 *   计算在副本里、而且副本里的字节必须**就是**权威字节。手拷一次以后就没人知道它漂没漂：
 *   改了 `lib/unify/render.cjs` 而忘了拷 ⇒ 宿主与课程包跑的是两套逻辑，还都是"看起来对"的。
 *
 * 纪律（与 U19 卡面一致）：
 *   · **生成器不是运行依赖**：它不进 `package.json#files` / `bin`；课程包运行期永远不需要它。
 *   · **migration.cjs 不随包**：那是**显式迁移**专用件（U05），不进日常运行态内核 ——
 *     本生成器的清单里没有它，`--check` 还会把镜像目录里多出来的它判成 `extra`。
 *   · **只依赖 node: 内置**；不读时钟、不读环境变量、不写时间戳 —— 同样的输入产出同样的字节。
 *   · **不做"顺手补一个"**：缺件/改字节/多件一律**拒绝**（`--check` 非零），不静默修。
 *
 * 用法：
 *
 *     node tools/sync-unify-core.mjs --check              # 对拍（默认模式）：只读，退出码 0/1
 *     node tools/sync-unify-core.mjs --write              # 生成：写 14 份副本（多余的件会被清掉并点名）
 *     node tools/sync-unify-core.mjs --check --root=<仓>  # 对拍另一个仓根（夹具/副本用）
 *     node tools/sync-unify-core.mjs --check --json       # 机器可读（stdout 一行 JSON）
 *
 * 判据（`--check` 的 `ok`）四条同时成立：
 *   ① 权威目录里 14 个模块**全都在**（缺一个 ⇒ 生成器自己不可信）；
 *   ② 镜像目录里 14 份**全都在**；
 *   ③ 每一份与权威**逐字节相同**（长度 + sha256 + Buffer.equals 三重）；
 *   ④ 镜像目录里**没有多出来的件**（含 `migration.cjs`、`.tmp-*`、任何非清单文件）。
 *   `--check` 与 `--write` 共用同一份 `plan()`，所以"写进去的"和"查出来的"永远是同一套判据。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 缺省仓根：本文件在 `<仓>/tools/` 下 */
export const DEFAULT_REPO_ROOT = path.resolve(HERE, '..')

/** 权威源码目录（仓内相对路径，POSIX） */
export const AUTHORITY_REL = 'lib/unify'
/** 随包副本目录（仓内相对路径，POSIX） */
export const MIRROR_REL = 'lib/pack-template/tools/unify'

/**
 * **运行态内核**清单（十四份，顺序即卡的登记顺序）。
 *
 * 为什么是这十四份、且**不含** `migration.cjs`：U-SPEC §5 —— 「migration.cjs 是迁移专用，
 * 不能进运行态内核或日常读取」。它由显式迁移 CLI（`tools/migrate-pack.mjs`）按需 require，
 * 一旦混进随包内核，运行态就等于带着一份历史解码器（卡面明令禁止的"隐式双读"温床）。
 */
export const CORE_MODULES = Object.freeze([
  'identity',
  'errors',
  'ledger-read',
  'commit',
  'text',
  'plan',
  'fingerprint',
  'render',
  'pack',
  'stage',
  'glossary',
  'records',
  'content',
  'evidence',
])

/** 迁移专用件（**不**随包；只用于把"多出来的件"点名成可读的原因） */
export const MIGRATION_MODULE = 'migration'

/** `sha256(buf)` → 小写十六进制 */
export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 稳定排序（同名不同大小写也不靠 locale —— 判据要可复算） */
function byName(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 列一个目录里的**普通文件名**（不递归；目录自己单列，不静默忽略）。
 * @returns {{files:string[], dirs:string[], exists:boolean}}
 */
function listDir(abs) {
  if (!fs.existsSync(abs)) return { files: [], dirs: [], exists: false }
  const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name))
  const files = []
  const dirs = []
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(e.name)
    else if (e.isFile()) files.push(e.name)
    else dirs.push(`${e.name}（非普通文件：软链/设备）`)
  }
  return { files, dirs, exists: true }
}

/** 读一份文件；读不动返回 `{ok:false, why}`（不抛 —— 失败要变成判据，不是崩溃） */
function readOr(abs) {
  try {
    return { ok: true, buf: fs.readFileSync(abs) }
  } catch (e) {
    return { ok: false, why: `读不动（${e && e.code ? e.code : e}）` }
  }
}

/**
 * 算一份同步计划（**只算不写**）。
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {{
 *   ok: boolean,
 *   repoRoot: string,
 *   authorityDir: string,
 *   mirrorDir: string,
 *   mirrorExists: boolean,
 *   modules: string[],
 *   authority: {name:string, rel:string, bytes:number, sha256:string}[],
 *   missing: string[],          // 镜像里缺的
 *   changed: {name:string, expected:string, actual:string, bytes:number, expectedBytes:number}[],
 *   same: string[],             // 已经逐字节相同的
 *   extra: string[],            // 镜像里多出来的（含 migration.cjs）
 *   extraDirs: string[],        // 镜像里出现的子目录/非常规件
 *   authorityMissing: string[], // 权威目录里缺的模块（生成器自己不可信）
 *   authorityExtra: string[],   // 权威目录里的其它 .cjs（仅提示；不影响 ok —— 权限内的其它交付件）
 *   byteTotal: number,
 *   problems: string[],
 * }}
 */
export function plan(opts = {}) {
  const repoRoot = path.resolve(String(opts.repoRoot ?? DEFAULT_REPO_ROOT))
  const authorityDir = path.join(repoRoot, ...AUTHORITY_REL.split('/'))
  const mirrorDir = path.join(repoRoot, ...MIRROR_REL.split('/'))

  const authorityListing = listDir(authorityDir)
  const mirrorListing = listDir(mirrorDir)

  const authority = []
  const authorityMissing = []
  const problems = []
  for (const name of CORE_MODULES) {
    const abs = path.join(authorityDir, `${name}.cjs`)
    if (!fs.existsSync(abs)) {
      authorityMissing.push(name)
      problems.push(`权威源码缺件：${AUTHORITY_REL}/${name}.cjs`)
      continue
    }
    const r = readOr(abs)
    if (!r.ok) {
      authorityMissing.push(name)
      problems.push(`权威源码读不动：${AUTHORITY_REL}/${name}.cjs（${r.why}）`)
      continue
    }
    authority.push({ name, rel: `${AUTHORITY_REL}/${name}.cjs`, bytes: r.buf.length, sha256: sha256(r.buf) })
  }
  const authorityExtra = authorityListing.files
    .filter((f) => f.endsWith('.cjs') && f !== `${MIGRATION_MODULE}.cjs` && !CORE_MODULES.includes(f.slice(0, -4)))
    .map((f) => `${AUTHORITY_REL}/${f}`)

  const missing = []
  const changed = []
  const same = []
  let byteTotal = 0
  if (!mirrorListing.exists) {
    for (const name of CORE_MODULES) missing.push(name)
  } else {
    for (const name of CORE_MODULES) {
      const want = authority.find((a) => a.name === name)
      const abs = path.join(mirrorDir, `${name}.cjs`)
      if (!fs.existsSync(abs)) {
        missing.push(name)
        continue
      }
      const r = readOr(abs)
      if (!r.ok) {
        missing.push(name)
        continue
      }
      if (!want) continue // 权威缺件已在上面登记
      const got = sha256(r.buf)
      if (r.buf.length === want.bytes && got === want.sha256 && r.buf.equals(fs.readFileSync(path.join(authorityDir, `${name}.cjs`)))) {
        same.push(name)
        byteTotal += r.buf.length
      } else {
        changed.push({ name, expected: want.sha256, actual: got, bytes: r.buf.length, expectedBytes: want.bytes })
      }
    }
  }

  const wantFiles = new Set(CORE_MODULES.map((n) => `${n}.cjs`))
  const extra = mirrorListing.files.filter((f) => !wantFiles.has(f))
  const extraDirs = mirrorListing.dirs.slice()

  if (missing.length) problems.push(`镜像缺 ${missing.length} 件：${missing.map((n) => `${n}.cjs`).join('、')}`)
  if (changed.length) {
    problems.push(`镜像字节不一致 ${changed.length} 件：${changed.map((c) => `${c.name}.cjs（期望 ${c.expected.slice(0, 12)}… / 实得 ${c.actual.slice(0, 12)}…）`).join('、')}`)
  }
  if (extra.length) problems.push(`镜像多出 ${extra.length} 件（清单外的件一律不许留在生成目录）：${extra.join('、')}`)
  if (extraDirs.length) problems.push(`镜像目录里出现了子目录/非常规件：${extraDirs.join('、')}`)
  if (authorityMissing.length) problems.push(`权威源码缺 ${authorityMissing.length} 件：${authorityMissing.map((n) => `${n}.cjs`).join('、')}`)

  return {
    ok: problems.length === 0,
    repoRoot,
    authorityDir,
    mirrorDir,
    mirrorExists: mirrorListing.exists,
    modules: CORE_MODULES.slice(),
    authority,
    missing,
    changed,
    same,
    extra,
    extraDirs,
    authorityMissing,
    authorityExtra,
    byteTotal,
    problems,
  }
}

/**
 * 真写：把权威字节逐字节复制进镜像目录。
 *
 * · 已相同的不重写（保住 mtime 也没意义，但少一次无谓写盘）；
 * · **多余的件会被删掉并点名** —— 生成目录是"生成器的输出"，不是"可以随手放东西的地方"；
 *   出现子目录则**整次拒绝**（不递归删别人的东西）。
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {{ok:boolean, written:string[], removed:string[], unchanged:string[], bytes:number,
 *            mirrorDir:string, problems:string[], plan:object}}
 */
export function write(opts = {}) {
  const p = plan(opts)
  const problems = []
  if (p.authorityMissing.length) {
    return { ok: false, written: [], removed: [], unchanged: [], bytes: 0, mirrorDir: p.mirrorDir, problems: p.problems, plan: p }
  }
  if (p.extraDirs.length) {
    problems.push(`镜像目录里有子目录/非常规件，拒绝写入（不递归删别人的东西）：${p.extraDirs.join('、')}`)
    return { ok: false, written: [], removed: [], unchanged: [], bytes: 0, mirrorDir: p.mirrorDir, problems, plan: p }
  }

  fs.mkdirSync(p.mirrorDir, { recursive: true })
  const written = []
  const unchanged = []
  let bytes = 0
  for (const a of p.authority) {
    const dest = path.join(p.mirrorDir, `${a.name}.cjs`)
    const src = path.join(p.authorityDir, `${a.name}.cjs`)
    if (p.same.includes(a.name) && fs.existsSync(dest)) {
      unchanged.push(`${a.name}.cjs`)
      bytes += a.bytes
      continue
    }
    fs.copyFileSync(src, dest)
    written.push(`${a.name}.cjs`)
    bytes += a.bytes
  }
  const removed = []
  for (const f of p.extra) {
    try {
      fs.unlinkSync(path.join(p.mirrorDir, f))
      removed.push(f)
    } catch (e) {
      problems.push(`删不掉镜像里多出来的件：${f}（${e && e.code ? e.code : e}）`)
    }
  }
  return { ok: problems.length === 0, written, removed, unchanged, bytes, mirrorDir: p.mirrorDir, problems, plan: p }
}

/** 人读一行（判词格式固定，便于对拍） */
export function formatPlanLine(p, mode = 'check') {
  const head = `UNIFY-CORE ok=${p.ok} mode=${mode} files=${CORE_MODULES.length} ` +
    `same=${p.same.length} missing=${p.missing.length} changed=${p.changed.length} extra=${p.extra.length} ` +
    `bytes=${p.byteTotal} mirror=${MIRROR_REL}`
  return p.ok ? head : `${head} :: ${p.problems.slice(0, 3).join(' | ')}`
}

/** 人读一行（write 模式） */
export function formatWriteLine(r) {
  const head = `UNIFY-CORE ok=${r.ok} mode=write files=${CORE_MODULES.length} ` +
    `written=${r.written.length} unchanged=${r.unchanged.length} removed=${r.removed.length} ` +
    `bytes=${r.bytes} mirror=${MIRROR_REL}`
  return r.ok ? head : `${head} :: ${r.problems.slice(0, 3).join(' | ')}`
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

function isMain() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

function main(argv) {
  const json = argv.includes('--json')
  const doWrite = argv.includes('--write')
  const twoModes = doWrite && argv.includes('--check')
  const rootArg = argv.find((a) => a.startsWith('--root='))
  const repoRoot = rootArg ? path.resolve(rootArg.slice('--root='.length)) : DEFAULT_REPO_ROOT

  if (twoModes) {
    process.stdout.write('UNIFY-CORE ok=false :: --write 与 --check 互斥（一次只做一件事）\n')
    return 1
  }

  if (doWrite) {
    const r = write({ repoRoot })
    const payload = { mode: 'write', ok: r.ok, written: r.written, removed: r.removed, unchanged: r.unchanged, bytes: r.bytes, mirrorDir: r.mirrorDir, problems: r.problems }
    process.stdout.write(json ? `${JSON.stringify(payload)}\n` : `${formatWriteLine(r)}\n`)
    return r.ok ? 0 : 1
  }

  const p = plan({ repoRoot })
  process.stdout.write(json ? `${JSON.stringify({ mode: 'check', ...p })}\n` : `${formatPlanLine(p, 'check')}\n`)
  return p.ok ? 0 : 1
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2))
}
