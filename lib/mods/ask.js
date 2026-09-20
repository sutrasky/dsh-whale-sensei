/**
 * lib/mods/ask.js — 能力模块：课程疑问（提交 + 拉取）
 * ------------------------------------------------------------------
 * 做两件事：
 *   ① 工具 `whale_ask`：agent 侧读待答队列（也能提交，便于自检）
 *   ② 在宿主 API 路由下挂一条精确路由 `/api/whale/ask`：
 *      （⚠️ 注释里别写星号紧跟斜杠的加粗写法 —— 那会**提前闭合块注释**，本文件就踩过 ✗）
 *        POST → 提交疑问（写 questions/pending.jsonl）
 *        GET  → 拉待答队列
 *
 * ⚠️ **跨站栅栏与浏览器认证是"继承"来的，不是我们手搓的**：
 *    基座把 `/api` 挂成 prefix 路由，处理器**先**调 `connection.requestRejection(req)`
 *    （不可信 Host/Origin → 403；未认证 → 401），**然后**才过桥到共享 Fetch 通道，
 *    我们的精确路由就插在那个通道里。
 *    依据：node_modules/@deepseek-ai/dsh-client-connection/lib/index.js
 *      · 768-781  `/api` prefix 路由 + requestRejection + bridge
 *      · 587-601  registerFetchRoute（精确 pathname 注册，重复注册会抛）
 *      · 696-700  assertFetchRoute（path 必须在 /api 下、methods 非空且不重复）
 *    所以本模块**不许**自己写 CORS/Origin 判断，也不许放行 `*`（旧 ask-server.js 就是那样 ✗）。
 *
 * 判定逻辑在 `lib/ask.js`（纯）、IO 在 `lib/ask-io.js`。模块之间不许互相 import。
 */

import { handleAsk, readQueue, handleAnswer, queueHighWater } from '../ask-io.js'

const ROUTE_PATH = '/api/whale/ask'
const ANSWER_PATH = '/api/whale/answer'

/**
 * 每个 owner 只盯一个监听（job 有并发上限，重复 watch 必须**复用**而不是另起 ✗）。
 * key = exec.agent（被唤醒的那个人），value = { jobId, timer, root, highWater, cancel }
 */
const watchers = new Map()

const json = (status, body) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json; charset=utf-8' },
})

export const plugin = {
	id: 'ask',
	version: '0.1.0',
	tools: ['whale_ask'],

	install(hctx) {
		// ── jobs 服务：软依赖现取 ──
		// 唤醒走宿主**原生**链路：job settle → onJobDone → dsh-tool-jobs → owner.followup()/inject()
		// （依据：dsh-jobs-local/lib/index.js:131 start(spec) / :279 servesOwner；dsh-tool-jobs/lib/index.js:200-226）
		// 插件**不能**直接调用 agent.followup()（不公开），只能通过起一个属于该 agent 的 job 间接唤醒。
		let jobsSvc = null
		if (typeof hctx.inject === 'function') {
			hctx.inject(['jobs'], (c) => {
				jobsSvc = c?.jobs ?? (typeof c?.get === 'function' ? c.get('jobs') : null)
			})
		}

		// ── ① HTTP 路由（两条，都在 /api 下：栅栏与认证由基座继承）──
		const readRaw = async (request) => {
			try {
				return await request.text()
			} catch {
				return null
			}
		}
		const packRootOr503 = () => {
			const root = hctx.paths.packRoot
			return root ? { root } : { res: json(503, { ok: false, error: '插件没有配置 packRoot，定位不到课程包（不猜 cwd）' }) }
		}

		const routes = [
			{
				path: ROUTE_PATH,
				methods: ['POST', 'GET'], // 精确、不重复（assertFetchRoute 会校验）
				requestBody: 'buffered', // 必须显式写：基座按 route.requestBody 决定要不要缓冲请求体
				fetch: async (request) => {
					const g = packRootOr503()
					if (!g.root) return g.res
					if (request.method === 'GET') {
						const r = readQueue(g.root)
						return json(r.status, r.body)
					}
					if (request.method !== 'POST') return json(405, { ok: false, error: '只接受 GET / POST' })
					const raw = await readRaw(request)
					if (raw === null) return json(400, { ok: false, error: '请求体读取失败' })
					const r = await handleAsk(g.root, { raw })
					return json(r.status, r.body)
				},
			},
			{
				path: ANSWER_PATH,
				methods: ['POST'],
				requestBody: 'buffered',
				fetch: async (request) => {
					const g = packRootOr503()
					if (!g.root) return g.res
					if (request.method !== 'POST') return json(405, { ok: false, error: '只接受 POST' })
					const raw = await readRaw(request)
					if (raw === null) return json(400, { ok: false, error: '请求体读取失败' })
					const r = await handleAnswer(g.root, { raw })
					return json(r.status, r.body)
				},
			},
		]

		if (typeof hctx.inject === 'function') {
			hctx.inject(['connection'], (c) => {
				const conn = c.get('connection')
				if (!conn?.fetch?.register) {
					hctx.log?.warn?.(`connection 服务没有 fetch.register —— ${routes.map((r) => r.path).join('、')} 没挂上（工具面仍可用）`)
					return
				}
				for (const r of routes) {
					try {
						conn.fetch.register(r)
						hctx.log?.info?.(`答疑路由已挂 ${r.path}（跨站栅栏 + 认证由基座继承）`)
					} catch (e) {
						hctx.log?.error?.(`挂 ${r.path} 失败：${e?.message ?? e}`)
					}
				}
			})
		} else {
			hctx.log?.warn?.('宿主没有注入能力：whale_ask 只提供工具面，HTTP 路由未注册')
		}

		// ── ② 工具 ──
		hctx.registerTool({
			name: 'whale_ask',
			description:
				'课程疑问：读学生提的问题（action=list，默认）、替学生记一条（action=submit）、写回解答（action=answer）、'
				+ '或挂一个原生监听等新提问（action=watch / unwatch）。'
				+ `页面侧走 HTTP 路由 ${ROUTE_PATH}（POST 提交 / GET 拉取）；写回答走 ${ANSWER_PATH}。`
				+ '队列是 questions/pending.jsonl（append-only），序号在 questions/seq.txt。'
				+ 'action=answer 只动已答台账 assets/questions-data.js（**只追加不覆盖**，写完 require 自检，失败回滚），'
				+ '然后跑课程包现成的工具 tools/drain-questions.js 归档，'
				+ 'tools/build-notes.js 重建 reference/NOTES.html、tools/build-lessons.js 重建课程页'
				+ '（课程页里嵌了「DSH 笔记」卡片的答疑计数，不重建它就陈旧）。'
				+ 'action=watch 是**宿主侧能力**的替代品：它起一个属于**调用者自己**的后台 job，'
				+ '只在出现"编号比高水位更大的新提问"时结束 —— 宿主原生机制随即叫醒该 agent（不需要再跑 tools/ask-watch.js 那个子进程）。'
				+ '跨站栅栏与浏览器认证由宿主基座继承（路径挂在 /api 下），本工具不自己做 CORS。'
				+ 'action=list 只读；submit / answer / watch 会写盘或占资源。',
			parameters: {
				type: 'object',
				properties: {
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					action: {
						type: 'string',
						enum: ['list', 'submit', 'answer', 'watch', 'unwatch'],
						description: 'list=读队列（默认）；submit=写入一条；answer=写回解答；watch=挂监听等新提问；unwatch=撤掉监听',
					},
					intervalMs: { type: 'number', description: 'action=watch 时的看一眼间隔（毫秒，默认 2000，最小 250）' },
					question: { type: 'string', description: 'action=submit 时的疑问内容' },
					lesson: { type: 'string', description: 'action=submit 时的课次标签' },
					page: { type: 'string', description: 'action=submit 时的页面路径' },
					title: { type: 'string', description: 'action=submit 时的页面标题' },
					id: { type: 'string', description: 'action=answer 时的四位编号（如 0004）' },
					answer: { type: 'string', description: 'action=answer 时的解答正文（纯文本）' },
					answerHtml: { type: 'string', description: 'action=answer 时的解答 HTML（必填：学生看到的就是它）' },
					section: { type: 'string', description: 'action=answer 时的章节名（默认「<课次> 答疑」）' },
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
					for (const w of (v.warnings || []).slice(0, 6)) lines.push(`⚠️ ${w}`)
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			// ⚠️ 第二个参数是宿主的 exec（`execute(args, exec)`，见 dsh-tool-todo:170）。
			//    exec.agent 是**每个模型驱动的调用都会带上**的（dsh-tool-workflow 的注释原话），
			//    watch 就靠它决定"叫醒谁"。
			async execute(args = {}, exec) {
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
				const action = args.action || 'list'
				if (action === 'list') {
					const r = readQueue(root)
					const entries = r.body.pending || []
					const lines = entries.slice(-5).map((e) => `#${e.id} ${e.lesson || ''} · ${String(e.question || '').slice(0, 60)}`)
					return {
						ok: true,
						summary: `待答 ${r.body.count} 条（其中坏行 ${(r.body.errors || []).length}）`,
						lines,
						warnings: (r.body.errors || []).map((e) => `第 ${e.line} 行不是合法 JSON：${e.error}`),
						queue: entries,
					}
				}
				if (action === 'answer') {
					const raw = JSON.stringify({
						id: args.id || '',
						answer: args.answer || '',
						answerHtml: args.answerHtml || '',
						lesson: args.lesson || '',
						section: args.section || '',
					})
					const r = await handleAnswer(root, { raw })
					if (!r.body.ok) return { ok: false, error: `${r.status} ${r.body.error}` }
					const lines = [`台账已记 ${r.body.id}（自检：${r.body.selfCheck}）`]
					for (const s of r.body.steps || []) {
						lines.push(`${s.code === 0 ? '✓' : '✗'} ${s.script}（退出码 ${s.code}）${s.tail ? ' · ' + s.tail : ''}`)
					}
					// ⚠️ 旧版这里**无条件**说"产物已重建" —— 重建脚本挂了也一样（2026-09-24 查出来的静默）✗
					// 现在按 rebuild.ok 说实话，并把 warnings 交给上面那层渲染成 ⚠️
					const rb = r.body.rebuild
					const rebuilt = !rb || rb.ok === true
					return {
						ok: true,
						summary: rebuilt
							? `解答已写回台账 ${r.body.ledger}，产物已重建`
							: `解答已写回台账 ${r.body.ledger}，但**产物重建失败**（${(rb.failed || []).join('、')}）—— 台账没丢，产物可能是旧的，请手动重跑`,
						lines,
						warnings: r.body.warnings || [],
					}
				}
				if (action === 'watch' || action === 'unwatch') {
					const owner = exec?.agent
					if (!owner) {
						return { ok: false, error: 'watch / unwatch 必须在会话里由 agent 调用 —— 叫醒谁靠的就是 exec.agent（拿不到就没有 owner）' }
					}
					if (action === 'unwatch') {
						const w = watchers.get(owner)
						if (!w) return { ok: true, summary: '当前没有在盯的监听', lines: [] }
						w.cancel()
						watchers.delete(owner)
						return { ok: true, summary: `已撤掉监听（job ${w.jobId}）`, lines: [`原来盯的是 ${w.root}`] }
					}
					if (!jobsSvc?.start) {
						return {
							ok: false,
							error: '宿主没有 jobs 服务（或没有 job 控制器）：起不了原生监听。可以让 agent 直接读队列（whale_ask action=list），或稍后重试 —— 课程包里那个 ask-watch.js 子进程做法**已退役**',
						}
					}
					const exist = watchers.get(owner)
					if (exist && exist.root === root) {
						return { ok: true, summary: `已经在盯着（job ${exist.jobId}）`, lines: [`高水位 #${exist.highWater} · 有新提问时会叫醒你`] }
					}
					if (exist) { exist.cancel(); watchers.delete(owner) } // 换目录：旧的先撤

					const interval = Math.max(250, Number(args.intervalMs) || 2000)
					let resolveDone
					const done = new Promise((r) => { resolveDone = r })
					const st = { root, highWater: queueHighWater(root), timer: null, jobId: null, stopped: false, cancel: null }
					// ⚠️ "停表" 与 "撤销" 必须分开：结算路径里若顺手调 cancel()，
					//    done 会以 cancelled 收尾，宿主就会收到"被撤销"而不是"有新提问" ✗（实测踩过）
					const stopTimer = () => {
						if (st.timer) clearInterval(st.timer)
						st.timer = null
						st.stopped = true
					}
					const forget = () => { if (watchers.get(owner) === st) watchers.delete(owner) }
					st.cancel = () => {
						if (st.stopped) return
						stopTimer()
						forget()
						resolveDone({ status: 'cancelled', detail: '监听被撤销' })
					}
					const tick = () => {
						if (st.stopped) return
						let r
						try { r = readQueue(root) } catch { return }
						const fresh = (r.body.pending || []).filter((e) => Number(e.id) > st.highWater)
						if (!fresh.length) return
						st.highWater = Math.max(...fresh.map((e) => Number(e.id)))
						stopTimer()
						forget() // 结算过的监听不占位置，下次 watch 能起新的
						const head = fresh.map((e) => `#${e.id} ${e.lesson || ''} · ${String(e.question || '').slice(0, 60)}`)
						resolveDone({ status: 'completed', detail: `收到 ${fresh.length} 条新提问：${head.join(' ／ ')}` })
					}
					st.timer = setInterval(tick, interval)
					if (typeof st.timer.unref === 'function') st.timer.unref()
					st.jobId = jobsSvc.start({
						owner,
						kind: 'whale-ask',
						label: `在等 ${root} 的新提问`,
						run: () => ({ done, cancel: st.cancel }),
					})
					watchers.set(owner, st)
					return {
						ok: true,
						summary: `已挂上监听（job ${st.jobId}）`,
						lines: [
							`盯 ${root}，每 ${interval}ms 看一眼；起点高水位 #${st.highWater}`,
							'只有**编号比高水位更大**的新提问才会结束这个 job —— 我们自己 drain 重写队列不会误触发',
							'job 结束 → 宿主原生机制叫醒你（空闲开新回合 / 忙碌注入下一步）',
						],
					}
				}
				if (action !== 'submit') return { ok: false, error: `不认识的 action：${action}（可用 list / submit / answer / watch / unwatch）` }
				const raw = JSON.stringify({
					question: args.question || '',
					lesson: args.lesson || '',
					page: args.page || '',
					title: args.title || '',
				})
				const r = await handleAsk(root, { raw })
				if (!r.body.ok) return { ok: false, error: `${r.status} ${r.body.error}` }
				return { ok: true, summary: `已记入队列 #${r.body.id}`, lines: [`问题：${String(args.question || '').slice(0, 60)}`] }
			},
		})
	},
}
