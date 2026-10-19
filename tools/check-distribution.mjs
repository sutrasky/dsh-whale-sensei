#!/usr/bin/env node
/**
 * tools/check-distribution.mjs — 「这份分发材料核过了吗」的唯一命令行入口
 * ------------------------------------------------------------------
 * 用法：
 *   node tools/check-distribution.mjs [--mode=private|public] [--manifest=<path>]
 *                                     [--node=<path>] [--payload=<dir>] [--json]
 *
 * 三种结局（**都不许把 private 记成 ok**）：
 *   · `--mode=private`（默认）：`PRIVATE MODE — 未做再分发合规核验`，exit **2**
 *   · `--mode=public`：必须有 `--manifest` 与 `--node`，真跑
 *       `distribution-license.cjs#verifyDistributionMaterials`；
 *       ok → `PASS distribution-materials files=<n>` exit 0
 *       否则逐条 `FAIL distribution-materials :: <problem>` exit 1
 *   · `--no-node`：`DEV ARTIFACT — 开发产物，不得发布`，exit **2**
 *
 * 为什么私模式也非零（T28 / 用户 2026-10-19 裁定）：T29 已被用户弃权（`audit-evidence/waivers.json`），
 * 真实 Node/Three/字体的许可材料**没有接入**。这时候"绿"就是把"没核验"说成"合规"——
 * 发布纪律要求**非零阻断**：内部专项测试全绿 ≠ 可分发给别人。
 *
 * 模式优先级：`--mode` > `package.json#dsh.distribution.mode` > `'private'`。
 * 这里**不联网、不猜发行版许可、不凭字体名判侵权**；它只回答"材料对得上吗"。
 */
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const require_ = createRequire(import.meta.url)

const SCHEMA = 'whale-distribution-check/1'
const USAGE = [
  '用法：node tools/check-distribution.mjs [--mode=private|public] [--manifest=<path>] [--node=<path>] [--payload=<dir>] [--json]',
  '  --mode=public 必须同时给 --manifest 与 --node（真核 sha256 / 版本 / 许可件）',
  '  --mode=private（默认）如实打印「未做再分发合规核验」并 exit 2',
  '  --no-node 是开发产物（不得发布）—— exit 2',
].join('\n')

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const valueOf = (name) => {
  const p = `--${name}=`
  const hit = argv.find((a) => a.startsWith(p))
  return hit === undefined ? null : hit.slice(p.length)
}
const json = has('json')

/** @param {number} code */
function finish(code, lines) {
  if (lines && lines.length) process.stdout.write(lines.join('\n') + '\n')
  process.exit(code)
}

function usageError(why) {
  const line = `✗ ${why}`
  if (json) finish(2, [JSON.stringify({ schema: SCHEMA, error: why, mode: 'invalid', verified: false, ok: false })])
  finish(2, [line, USAGE])
}

// ── ① 参数 ────────────────────────────────────────────────────────────────
const KNOWN = ['mode', 'manifest', 'node', 'payload', 'json', 'no-node']
for (const a of argv) {
  const name = a.replace(/^--/, '').split('=')[0]
  if (!KNOWN.includes(name)) usageError(`不认识的参数：${a}`)
}
if (has('no-node')) {
  // 显式开发产物：**不是**"小一点的正式包"，发布判定一律非零（T28 §3.2）
  if (json) finish(2, [JSON.stringify({ schema: SCHEMA, mode: 'dev', verified: false, devArtifact: true, ok: false })])
  finish(2, ['DEV ARTIFACT — 开发产物，不得发布', '依据：--no-node 只产出引擎 + 骨架，未接入任何运行期许可材料'])
}

// ── ② 模式（--mode > package.json#dsh.distribution.mode > private）─────────
const DL = require_(path.join(REPO, 'lib', 'pack-template', 'tools', 'distribution-license.cjs'))
let mode
const modeArg = valueOf('mode')
if (modeArg !== null) {
  if (modeArg !== 'private' && modeArg !== 'public') usageError(`--mode 只能是 private|public（实得 ${JSON.stringify(modeArg)}）`)
  mode = modeArg
} else {
  try {
    mode = DL.modeOf(path.join(REPO, 'package.json'))
  } catch (e) {
    usageError(`读不出分发模式：${e && e.message ? e.message : String(e)}`)
  }
}

// ── ③ 私模式：永远"未做再分发合规核验" + 非零 ─────────────────────────────
if (mode === 'private') {
  const payload = {
    schema: SCHEMA,
    mode: 'private',
    verified: false,
    waiver: 'T29',
    waiverFile: 'audit-evidence/waivers.json',
    ok: false,
  }
  if (json) finish(2, [JSON.stringify(payload)])
  finish(2, [
    'PRIVATE MODE — 未做再分发合规核验',
    '依据：audit-evidence/waivers.json（T29=WAIVED，G03=waived）',
    '这不等于合规；发布判定非零。',
  ])
}

// ── ④ 公模式：真核材料 ────────────────────────────────────────────────────
const manifestPath = valueOf('manifest')
const nodePath = valueOf('node')
const payloadDir = valueOf('payload')
if (!manifestPath) usageError('--mode=public 必须给 --manifest=<manifest.json>')
if (!nodePath) usageError('--mode=public 必须给 --node=<node 可执行文件>')

const r = DL.verifyDistributionMaterials({ manifestPath, nodePath, payloadDir: payloadDir || null })
if (r.ok) {
  if (json) finish(0, [JSON.stringify({ schema: SCHEMA, mode: 'public', verified: true, files: r.files, problems: [], ok: true })])
  finish(0, [`PASS distribution-materials files=${r.files.length}`])
}
if (json) {
  finish(1, [JSON.stringify({ schema: SCHEMA, mode: 'public', verified: false, files: r.files, problems: r.problems, ok: false })])
}
finish(1, [
  ...r.problems.map((p) => `FAIL distribution-materials :: ${p}`),
  `FAIL distribution-materials problems=${r.problems.length} —— 材料对不上，不许发`,
])
