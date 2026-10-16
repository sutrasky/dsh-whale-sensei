#!/usr/bin/env node
/**
 * tools/upgrade-pack.mjs — **显式升级课程包的引擎**（T04 / 报告 D01）
 * ------------------------------------------------------------------
 * 为什么要有这个 CLI：宿主预览与构建链在**执行前**核验受信引擎闭包
 * （`lib/engine.js` / `lib/pack-template/tools/engine-policy.cjs`）——
 * 旧包（引擎件与插件模板不一致）会被**先拒绝**。拒绝之后人得有条**明确**的路把它升上来：
 *
 *     node tools/upgrade-pack.mjs --root=<包根> --plan
 *     node tools/upgrade-pack.mjs --root=<包根> --apply --confirm --plan-digest=<digest>
 *
 * 三条纪律（与 `lib/engine.js` 同一份口径，这里只做编排与打印）：
 *   ① **计划与提交是两步**：`--plan` 只读、把 digest 打出来；`--apply` 必须回同一个 digest。
 *      包在两步之间又变过 → 摘要对不上 → **拒绝**（不是"尽力而为地升一半"）。
 *   ② **升级源只取插件模板**：没有 `--from` 这种参数，也不接受任意来源路径。
 *   ③ **备份失败不得替换**；目标是软链 / 目录联接 → 拒绝。
 *
 * 退出码：0 = 成功；1 = 拒绝 / 失败（理由打出来）；2 = 用法错 / 材料缺失。
 * stdout 契约（给判据与脚本抓）：
 *     PLAN ok=true digest=<hex> files=<n>
 *     APPLY ok=true digest=<hex> replaced=<n> added=<n> backup=<path>
 *     任一步失败：`FAIL <一句话>`（stderr 同内容）
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const REPO = path.resolve(HERE, '..')

/** `--name=value` 取值；`--flag` 当布尔 */
function parseArgs(argv) {
  const out = { _: [] }
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/s.exec(a)
    if (m) { out[m[1]] = m[2]; continue }
    const f = /^--([^=]+)$/.exec(a)
    if (f) { out[f[1]] = true; continue }
    out._.push(a)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

function die(code, msg) {
  process.stderr.write(`FAIL ${msg}\n`)
  process.exit(code)
}

if (args.help || args.h) {
  process.stdout.write([
    '用法：',
    '  node tools/upgrade-pack.mjs --root=<包根> --plan',
    '  node tools/upgrade-pack.mjs --root=<包根> --apply --confirm --plan-digest=<digest>',
    '',
    '  --plan                  只算不写：列出要动的引擎件与计划摘要',
    '  --apply                 真的升级（必须同时给 --confirm 与 --plan-digest）',
    '  --confirm               显式确认（缺了它一律拒）',
    '  --plan-digest=<hex>     --plan 打出来的那一个',
    '  --json                  额外把机器可读结果打一行 JSON',
    '',
  ].join('\n'))
  process.exit(0)
}

const root = typeof args.root === 'string' ? args.root : ''
if (!root) die(2, '没给课程包根（--root=<包根>）')

const engine = await import(pathToFileURL(path.join(REPO, 'lib', 'engine.js')).href)

/** 像不像课程包（与全仓同一条判据：`lessons/` 或预设件） */
function looksLikePack(dir) {
  try {
    if (fs.existsSync(path.join(dir, 'presets', 'whale-sensei.css'))) return true
    return fs.existsSync(path.join(dir, 'lessons'))
  } catch {
    return false
  }
}

const abs = path.resolve(root)
if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) die(2, `课程包根不存在或不是目录：${abs}`)
if (!looksLikePack(abs)) {
  die(2, `这里不像课程包（既没有 presets/whale-sensei.css，也没有 lessons/）：${abs} —— 拒绝升级一个不知道是什么的目录`)
}

const wantApply = args.apply === true
const wantPlan = args.plan === true || !wantApply

if (wantApply) {
  if (args.confirm !== true) die(1, '--apply 必须同时给 --confirm（升级会覆盖包里的引擎件）')
  if (typeof args['plan-digest'] !== 'string' || !args['plan-digest']) {
    die(1, '--apply 必须给 --plan-digest=<digest>（先跑 --plan 拿它）—— 没有它判不了"这份计划还是不是当初那一份"')
  }
}

if (wantPlan) {
  const plan = engine.planEngineUpgrade(abs)
  if (!plan.ok) die(1, plan.error)
  process.stdout.write(`PLAN ok=true digest=${plan.planDigest} files=${plan.files.length}\n`)
  process.stdout.write(`  根：${plan.root}\n  来源（只取插件模板）：${plan.source}\n`)
  if (plan.upToDate) {
    process.stdout.write('  包里引擎件已经与插件受信版本一致 —— 没有要动的件\n')
  } else {
    for (const f of plan.files) {
      const mark = f.action === 'reject' ? '拒绝' : (f.action === 'add' ? '新增' : '替换')
      process.stdout.write(`  ${mark}  ${f.path}${f.action === 'reject' ? `（${f.why}）` : `  ${String(f.before ?? '（现在没有）').slice(0, 12)} → ${String(f.after.sha256).slice(0, 12)}`}\n`)
    }
    process.stdout.write(`  提交：node tools/upgrade-pack.mjs --root=${plan.root} --apply --confirm --plan-digest=${plan.planDigest}\n`)
  }
  if (args.json) process.stdout.write(`${JSON.stringify({ op: 'plan', ok: true, root: plan.root, source: plan.source, upToDate: plan.upToDate, planDigest: plan.planDigest, files: plan.files })}\n`)
  process.exit(0)
}

const out = engine.applyEngineUpgrade(abs, { confirm: true, planDigest: args['plan-digest'] })
if (!out.ok) die(1, out.error)
process.stdout.write(`APPLY ok=true digest=${out.planDigest} replaced=${out.replaced.length} added=${out.added.length} backup=${out.backupDir ?? '（无）'}\n`)
if (out.note) process.stdout.write(`  ${out.note}\n`)
if (out.replaced.length) process.stdout.write(`  替换：${out.replaced.join('、')}\n`)
if (out.added.length) process.stdout.write(`  新增：${out.added.join('、')}\n`)
if (args.json) process.stdout.write(`${JSON.stringify({ op: 'apply', ok: true, root: out.root, planDigest: out.planDigest, replaced: out.replaced, added: out.added, backupDir: out.backupDir })}\n`)
process.exit(0)
