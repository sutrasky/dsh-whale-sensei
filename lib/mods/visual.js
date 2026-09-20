/**
 * lib/mods/visual.js — 能力模块：视觉检查（`whale_visual`）
 * ------------------------------------------------------------------
 * 补的是课程包这边**一直没人管**的那一步：「星图/课程页在真实浏览器里到底渲染出来了吗」。
 * 以前只有人眼（`a11y-print.test.mjs` 自己写着"本机没有浏览器工具可用"）。
 *
 * 做法（侦察报告 `_plugin-prep/visual-侦察.md` 的推荐路子，零外部依赖）：
 *   1. 用本机 Edge/Chrome 的 headless 模式截 4 种桌面尺寸
 *      —— 2026-09-24（B2）：截图改走 `lib/cdp.js` 的 `capturePng`（真 CDP），
 *         `fullPage=true` 拿**整页**、`clip="x,y,w,h"` 拿**局部**；都不给 = 视口。
 *         旧法子 `--screenshot` **只截首屏**，长课程页等于没看 ✗
 *   2. 用 `--dump-dom` 取**渲染后的 DOM** 做结构化断言（比"看一眼截图"硬）
 *   3. 断言：PNG 尺寸（整页判"高 > 视口高"）、字节数不像白屏、DOM 里关键标记在
 *
 * ⚠️ 边界：它判的是"有没有渲染出来 / 是不是我要的那张"，**不判好看不好看**（那是人眼的事）。
 * 它**不启动**服务 —— 服务没在跑就明确报错并告诉你怎么起。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPack } from '../pack.js'
import { checkShot, checkFullShot, checkDom } from '../visual.js'
import { findBrowser, makeProfileDir, shoot, dumpDom, probeBase } from '../visual-io.js'

const DEFAULT_SIZES = [[560, 800], [900, 700], [1280, 820], [1440, 900]]
const DEFAULT_BASE = 'http://127.0.0.1:3091'

export const plugin = {
	id: 'visual',
	version: '0.1.0',
	tools: ['whale_visual'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_visual',
			description:
				'视觉检查（真浏览器）：用本机 Edge/Chrome 的 headless 模式在 4 种桌面尺寸下加载页面、截图，'
				+ '并断言「PNG 尺寸对、字节数不像白屏、渲染后的 DOM 里关键标记在」。'
				+ 'fullPage=true 截**整页**（长课程页必需；判据是"高 > 视口高"），'
				+ 'clip="x,y,w,h" 截**局部**；都不给 = 视口首屏。两者互斥。'
				+ '默认查星图（/starmap/）；kind=lesson 查课程页（不传 path 就用课程包里的第一课）；'
				+ 'kind=notes 查笔记文档页（reference/NOTES.html，判据含"笔记表单在不在"）。'
				+ '它**不启动服务**：服务没在跑会明确报错并告诉你怎么起（node tools/app-server.js，默认 3091）。'
				+ '它判的是"渲染出来了没有"，不判"好不好看"。截图落在临时目录（可用 outDir 指定）。',
			parameters: {
				type: 'object',
				properties: {
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot；kind=lesson 时用来找第一课）' },
					base: { type: 'string', description: `服务地址（默认 ${DEFAULT_BASE}）` },
					kind: { type: 'string', enum: ['starmap', 'lesson', 'notes'], description: '查哪一类页面（默认 starmap；notes = reference/NOTES.html）' },
					path: { type: 'string', description: '要查的路径（默认：星图 /starmap/；课程页取课程包里第一课）' },
					sizes: { type: 'string', description: '尺寸列表，形如 "560x800,1280x820"（默认 4 种桌面尺寸）' },
					outDir: { type: 'string', description: '截图落哪（默认临时目录；给了就写在那儿）' },
					budgetMs: { type: 'number', description: '等待渲染的虚拟时间预算（毫秒，默认 5000）' },
					fullPage: { type: 'boolean', description: '截整页（高度按内容实际高度，会长于视口）。与 clip 互斥' },
					clip: { type: 'string', description: '局部截图的裁剪框，形如 "x,y,w,h"（像素）。与 fullPage 互斥' },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					// ⚠️ 一个 text 项 + 内部换行：宿主把多个项直接拼接、不插换行 ✗
					const lines = [v.summary]
					for (const l of v.lines || []) lines.push(l)
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			async execute(args = {}) {
				const kind = args.kind || 'starmap'
				const base = String(args.base || DEFAULT_BASE).replace(/\/+$/, '')

				// 截图模式：整页 / 局部 / 视口。**先校验参数再去做 IO** ——
				// 坏参数（clip 形状不对、两者都给了）该立刻拒，不该先探服务、起浏览器才发现。
				// 两种都给了就明确拒绝，不静默取一个（那会让人以为截的是另一种）
				const fullPage = args.fullPage === true
				let clip = null
				if (args.clip !== undefined && args.clip !== null && String(args.clip).trim() !== '') {
					const n = String(args.clip).split(',').map((s) => Number(String(s).trim()))
					if (n.length !== 4 || !n.every(Number.isFinite)) {
						return { ok: false, error: `clip 要形如 "x,y,w,h"（四个数），实得 "${args.clip}"` }
					}
					clip = { x: n[0], y: n[1], width: n[2], height: n[3] }
				}
				if (fullPage && clip) return { ok: false, error: 'fullPage 与 clip 只能给一个（整页 / 局部，语义冲突）' }
				const mode = fullPage ? 'full' : (clip ? 'clip' : 'viewport')

				// 目标路径：星图有默认；课程页不传 path 就从课程包里取第一课（数据驱动，不猜）
				let target = args.path
				if (!target && kind === 'starmap') target = '/starmap/'
				if (!target && kind === 'notes') target = '/reference/NOTES.html'
				if (!target && kind === 'lesson') {
					const root = args.root || hctx.paths.packRoot
					if (!root) return { ok: false, error: 'kind=lesson 且没给 path，需要 root 才能从课程包里取第一课' }
					const pack = readPack(path.resolve(root))
					const first = pack.lessons?.[0]
					if (!first) return { ok: false, error: '课程包里没有课程页' }
					target = '/' + String(first.href || '').replace(/^\/+/, '')
				}

				const exe = findBrowser()
				if (!exe) return { ok: false, error: '找不到本机浏览器（Edge/Chrome）—— 视觉检查需要它，且不替你装' }

				const probe = await probeBase(base, target)
				if (!probe.ok) {
					return {
						ok: false,
						error: `服务没在跑（${base}${target} 连不上：${probe.why}）。先起课程包自己的服务：node tools/app-server.js（默认 3091）`,
					}
				}

				const sizes = args.sizes
					? String(args.sizes).split(',').map((s) => s.trim().split(/[x×]/).map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite))
					: DEFAULT_SIZES
				const budgetMs = Math.max(1000, Number(args.budgetMs) || 5000)

				const outDir = args.outDir ? path.resolve(args.outDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'whale-visual-shots-'))
				fs.mkdirSync(outDir, { recursive: true })
				const profileDir = makeProfileDir()

				const modeTag = mode === 'full' ? ' 整页' : (mode === 'clip' ? ' 局部' : '')
				const lines = [`浏览器 ${path.basename(exe)} · 目标 ${base}${target} · 尺寸 ${sizes.length} 种 · 模式 ${mode} · 截图落 ${outDir}`]
				const results = []
				try {
					for (const [w, h] of sizes) {
						const outPng = path.join(outDir, `${kind}-${w}x${h}${mode === 'viewport' ? '' : '-' + mode}.png`)
						const r = await shoot({ exe, url: `${base}${target}`, w, h, outPng, profileDir, budgetMs, fullPage, clip })
						let buf = null
						try {
							buf = fs.readFileSync(outPng)
						} catch {
							/* 没截出来 */
						}
						// 判据按模式分开：整页要看"高 > 视口高"，局部看裁剪框，视口看原尺寸
						const chk = mode === 'full'
							? checkFullShot({ buf, w, viewportH: h })
							: checkShot({ buf, w: clip ? clip.width : w, h: clip ? clip.height : h })
						results.push({ size: `${w}x${h}`, mode, ok: chk.ok, why: chk.why, bytes: chk.bytes, out: outPng })
						const why = chk.ok ? '' : ` （${r.stderr || `浏览器退出码 ${r.code}`}）`
						lines.push(`${chk.ok ? '✓' : '✗'} ${w}×${h}${modeTag} · ${chk.why}${why}`)
					}

					// DOM 断言：一次就够（渲染后的 DOM 与尺寸无关）
					const dom = dumpDom({ exe, url: `${base}${target}`, profileDir, budgetMs })
					const domChk = checkDom(dom.html, kind)
					lines.push(`${domChk.ok ? '✓' : '✗'} DOM：${domChk.why}`)
					results.push({ size: 'dom', ok: domChk.ok, why: domChk.why })

					const bad = results.filter((r) => !r.ok)
					return {
						ok: bad.length === 0,
						root: args.root || hctx.paths.packRoot || null,
						summary: `${kind} · ${sizes.length} 尺寸（${mode}）+ DOM · ${bad.length === 0 ? '全部通过 ✓' : `${bad.length} 项没过`}`,
						lines,
						results,
						outDir,
					}
				} finally {
					fs.rmSync(profileDir, { recursive: true, force: true }) // profile 是垃圾，截图留着给人看
				}
			},
		})
	},
}
