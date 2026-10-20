#!/usr/bin/env node
/**
 * tools/migrate-pack.mjs —— **一次性身份迁移**的 CLI（U05 新建）
 * ==================================================================
 * 唯一职责：把 `lib/unify/migration.cjs` 的三个入口包成可预演、可确认、
 * 可拒绝过期计划、可回滚的命令行。**全部历史解码都在 migration.cjs**，
 * 本文件不解析任何台账、不猜任何身份、不碰任何数据字节。
 *
 * 三种模式（U-SPEC §4）：
 *
 *   node tools/migrate-pack.mjs --root=<课程包> --plan
 *   node tools/migrate-pack.mjs --root=<课程包> --apply --confirm --plan-digest=<摘要>
 *   node tools/migrate-pack.mjs --root=<课程包> --rollback --confirm --plan-digest=<摘要> --backup=<该次备份目录>
 *
 * stdout 契约（**一行**；`--json` 时改成一行机器可读 JSON）：
 *   PLAN   ok=true digest=<hex> files=<n> changes=<n> blocks=<n>
 *   APPLY  ok=true digest=<hex> replaced=<n> backup=<dir>
 *   ROLLBACK ok=true digest=<hex> restored=<n> backup=<dir>
 *   失败一律 `FAIL <一句话>`（stderr 同内容）
 *
 * 退出码：0 成功 / 1 拒绝或失败（含计划里有阻断）/ 2 用法错或材料缺失。
 *
 * 参数一律走**数组**（不依赖 shell 续行、不拼字符串）；参数不认识就用法错，
 * 不静默忽略 —— 静默忽略 "--confirm" 这类拼写错误等于绕过确认闸。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const requireCJS = createRequire(import.meta.url)
const migration = requireCJS(path.join(REPO, 'lib', 'unify', 'migration.cjs'))

const USAGE = [
	'用法（三种模式，参数数组调用）：',
	'  node tools/migrate-pack.mjs --root=<课程包> --plan',
	'  node tools/migrate-pack.mjs --root=<课程包> --apply --confirm --plan-digest=<摘要>',
	'  node tools/migrate-pack.mjs --root=<课程包> --rollback --confirm --plan-digest=<摘要> --backup=<该次备份目录>',
	'可选：--json（一行 JSON 输出）',
].join('\n')

const KNOWN_FLAGS = new Set(['plan', 'apply', 'rollback', 'confirm', 'json'])
const KNOWN_VALUES = new Set(['root', 'plan-digest', 'backup'])

function parseArgv(argv) {
	const flags = new Set()
	const values = new Map()
	const unknown = []
	for (const raw of argv) {
		const arg = String(raw)
		if (!arg.startsWith('--')) { unknown.push(arg); continue }
		const eq = arg.indexOf('=')
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
		if (KNOWN_FLAGS.has(name)) {
			if (eq !== -1) { unknown.push(`${arg}（这个参数不带值）`); continue }
			flags.add(name)
			continue
		}
		if (KNOWN_VALUES.has(name)) {
			if (eq === -1) { unknown.push(`${arg}（必须写成 --${name}=<值>）`); continue }
			if (values.has(name)) { unknown.push(`${arg}（--${name} 给了两次）`); continue }
			values.set(name, arg.slice(eq + 1))
			continue
		}
		unknown.push(arg)
	}
	return { flags, values, unknown }
}

function say(line) {
	process.stdout.write(`${line}\n`)
}

function fail(line, code) {
	process.stdout.write(`FAIL ${line}\n`)
	process.stderr.write(`FAIL ${line}\n`)
	return code
}

function main(argv) {
	const { flags, values, unknown } = parseArgv(argv)
	if (flags.has('json') && unknown.length) return fail(`用法错：不认识的参数 ${unknown.join(' ')}`, 2)
	if (unknown.length) return fail(`用法错：不认识的参数 ${unknown.join(' ')}\n${USAGE}`, 2)

	const modes = ['plan', 'apply', 'rollback'].filter((m) => flags.has(m))
	if (modes.length !== 1) return fail(`用法错：必须且只能给 --plan / --apply / --rollback 之一（实得 ${modes.length} 个）\n${USAGE}`, 2)
	const mode = modes[0]

	const rootRaw = values.get('root')
	if (!rootRaw) return fail(`用法错：缺 --root=<课程包>（本 CLI 只对**自建夹具/课程包**生效，不认活包默认值）\n${USAGE}`, 2)
	const rootAbs = path.resolve(rootRaw)
	let st = null
	try {
		st = fs.lstatSync(rootAbs)
	} catch (e) {
		return fail(`材料缺失：--root 不存在或读不动（${e && e.code ? e.code : 'IO_ERROR'}）：${rootAbs}`, 2)
	}
	// 拒绝软链根与链接目标：迁移会改写包里的台账，顺着链接改到别处是事故
	if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) return fail(`拒绝软链根：${rootAbs}`, 2)
	if (!st.isDirectory()) return fail(`--root 不是目录：${rootAbs}`, 2)

	const json = flags.has('json')
	const out = (obj) => {
		if (json) say(JSON.stringify(obj))
	}

	if (mode === 'plan') {
		const r = migration.planIdentityMigration(rootAbs, { fs })
		if (!r.ok) return fail(`计划失败：${r.error}`, 2)
		const plan = r.plan
		const ok = plan.blocks.length === 0
		if (json) {
			out({ mode: 'plan', ok, code: ok ? null : 'PLAN_BLOCKED', plan })
		} else {
			say(`PLAN ok=${ok} digest=${plan.planDigest} files=${plan.outputs.length} changes=${plan.changes.length} blocks=${plan.blocks.length}`)
		}
		if (!ok) {
			// 计划本身算出来了，但有阻断：不是"能执行"的计划
			for (const b of plan.blocks.slice(0, 5)) process.stderr.write(`  BLOCK ${b.file} ${b.location} ${b.error}\n`)
			return 1
		}
		return 0
	}

	if (mode === 'apply') {
		if (!flags.has('confirm')) return fail('拒绝：--apply 必须同时给 --confirm（显式迁移不改写，除非你明确确认）', 2)
		const digest = values.get('plan-digest')
		if (!digest) return fail('用法错：--apply 必须回引 --plan-digest=<摘要>（先用 --plan 拿摘要）', 2)
		const r = migration.applyIdentityMigration(rootAbs, { confirm: true, planDigest: digest, fs })
		if (json) { out({ mode: 'apply', ...r }); return r.ok ? 0 : 1 }
		if (!r.ok) return fail(`apply 被拒（${r.state} / ${r.code || 'UNKNOWN'}）：${r.error || '未给原因'}`, r.code === 'CONFIRM_REQUIRED' || r.code === 'PLAN_REQUIRED' ? 2 : 1)
		const v = r.value || {}
		say(`APPLY ok=true digest=${v.planDigest} replaced=${v.changes} backup=${v.backupDir}`)
		return 0
	}

	// rollback
	if (!flags.has('confirm')) return fail('拒绝：--rollback 必须同时给 --confirm', 2)
	const digest = values.get('plan-digest')
	if (!digest) return fail('用法错：--rollback 必须回引 --plan-digest=<摘要>', 2)
	const backup = values.get('backup')
	if (!backup) return fail('用法错：--rollback 必须给 --backup=<该次迁移的专属备份目录>', 2)
	const r = migration.rollbackIdentityMigration(rootAbs, { confirm: true, planDigest: digest, backupDir: backup, fs })
	if (json) { out({ mode: 'rollback', ...r }); return r.ok ? 0 : 1 }
	if (!r.ok) return fail(`rollback 被拒（${r.state} / ${r.code || 'UNKNOWN'}）：${r.error || '未给原因'}`, r.code === 'CONFIRM_REQUIRED' || r.code === 'PLAN_REQUIRED' ? 2 : 1)
	const v = r.value || {}
	say(`ROLLBACK ok=true digest=${v.planDigest} restored=${v.restored} backup=${v.backupDir}`)
	return 0
}

process.exitCode = main(process.argv.slice(2))
