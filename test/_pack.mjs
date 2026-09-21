/**
 * _pack.mjs —— **课程包根的唯一算法**（所有套件共用）
 * ------------------------------------------------------------------
 * 顺序：命令行参数 → 环境变量 `DSH_WHALE_PACK` → 插件旁边的 `<插件仓>/../study`（开发布局的便利，**不是必需**）。
 * 都要不到就**大声报错**并打印试过的路径 —— 绝安安静静地跑到别处去。
 *
 * 为什么要有这一层：以前 17 个套件各自写了一份 `process.argv[2] || resolve(HERE,'..','..','study')`，
 * 换台机器（npm 装进 node_modules）就全部指向不存在的路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN = path.resolve(HERE, '..')

/** 一个目录像不像课程包：有 `presets/whale-sensei.css` 才算。 */
export function looksLikePack(dir) {
	return !!dir && fs.existsSync(path.join(dir, 'presets', 'whale-sensei.css'))
}

/**
 * @param {string} [cliArg] 默认取 `process.argv[2]`
 * @returns {string} 课程包根（绝对路径）
 */
export function packRoot(cliArg = process.argv[2]) {
	const tried = [cliArg, process.env.DSH_WHALE_PACK, path.join(PLUGIN, '..', 'study')]
	for (const c of tried) {
		const v = String(c ?? '').trim()
		if (!v) continue
		const abs = path.resolve(v)
		if (looksLikePack(abs)) return abs
	}
	throw new Error(
		'找不到课程包（判据：目录下有 presets/whale-sensei.css）。\n'
		+ '  试过：' + tried.map((c) => String(c ?? '')).filter(Boolean).join('；') + '\n'
		+ '  用法：node test/<套件>.mjs <课程包根>   或   DSH_WHALE_PACK=<课程包根> node test/<套件>.mjs'
	)
}
