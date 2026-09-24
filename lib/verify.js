/**
 * verify.js — 产物校验（**只读、只判定，不写任何东西**）
 * ------------------------------------------------------------------
 * 判的是什么：**课程包自身** 与 **已经落盘的产物** 是否一致。
 * 每个检查都用**稳定信号**（不靠"看起来对不对" ✗）：
 *   · 产物文件存在
 *   · 产物 `<title>` 以课程 label 开头（模板就是 `<title>{{LESSON_LABEL}}：…</title>`）
 *   · 产物里有指向自己的星图深链 `#<id>`（证明"课"和"星图"两边用的是同一个 id）
 *   · `starmap/content.js` 里有每门课的 id
 *   · 静态版 SVG、笔记页存在
 *
 * 差异一律**列清每一处**：`drift[]` 里每项都带 id/文件/期望 vs 实际 —— 不许只回"失败"。
 */

import fs from 'node:fs'
import path from 'node:path'

function readIf(p) {
	try { return fs.readFileSync(p, 'utf8') } catch { return null }
}

/**
 * @param {string} root 课程包根
 * @param {object} pack readPack() 的结果
 */
export function verifyPack(root, pack) {
	const checks = []
	const drift = []
	const ok = (name) => checks.push({ name, ok: true })
	const bad = (name, detail) => {
		checks.push({ name, ok: false, detail })
		drift.push(`${name}：${detail}`)
	}

	// ① 产物存在 + ② 标题 + ③ 深链 —— 逐课
	let missing = 0, titleBad = 0, linkBad = 0
	for (const l of pack.lessons) {
		const file = path.join(root, l.href)
		const html = readIf(file)
		if (html == null) { bad(`产物 ${l.id}`, `缺 ${l.href}`); missing++; continue }
		const m = html.match(/<title>([^<]*)<\/title>/)
		if (!m) { bad(`标题 ${l.id}`, '产物里没有 <title>'); titleBad++ }
		else if (!m[1].startsWith(l.label)) {
			bad(`标题 ${l.id}`, `产物="${m[1]}"，包里的 label="${l.label}"`); titleBad++
		}
		if (!html.includes(`#${l.id}`)) { bad(`深链 ${l.id}`, `产物里找不到 #${l.id}`); linkBad++ }
	}
	if (pack.lessons.length && !missing && !titleBad && !linkBad) {
		ok(`产物 / 标题 / 深链一致（${pack.lessons.length} 门课）`)
	}

	// ④ 星图数据里有每门课的 id
	const contentSrc = readIf(path.join(root, 'starmap', 'content.js'))
	if (contentSrc == null) {
		bad('星图数据', '缺 starmap/content.js')
	} else {
		const gone = pack.lessons.filter((l) => !contentSrc.includes(`"${l.id}"`)).map((l) => l.id)
		if (gone.length) bad('星图数据', `content.js 里没有：${gone.join(', ')}`)
		else ok(`星图数据含全部课程 id（${pack.lessons.length}）`)
	}

	// ⑤ 静态版（M3）与笔记页
	//    **有条件**：有圆圈才要求 starmap/static.svg；0 个圆圈时如实说明、判"不是问题"。
	//    依据：static.svg 的唯一产出者是 tools/build-starmap-svg.js（由 tools/build-starmap.js spawn），
	//    而 build-starmap.js 对 0 个圆圈是**刻意拒绝产出**的（没有 lessons/<halo>/halo.json → exit 1，
	//    反空转：不许画假图）。生成器按规矩不产出的东西，不该反过来判使用者"缺产物"——
	//    否则「建包之后、建第一个圈之前」这个窗口（= 用户对新包的第一印象）永远是红的。
	//    为什么不"补一个空白 static.svg 骨架"了事：建包时 starmap/index.html 的标记区是
	//    「建第一个圈」**引导文字**（不是 SVG），补一个空白 SVG 会造出"文件是空图、页面是引导"
	//    的**两份事实** —— 与 starmap/content.js 的情形**本质不同**：content.js 有合法的
	//    "0 圈形态"（空载荷 window.STARMAP_REAL），static.svg **没有**（生成器刻意拒绝空图）。
	//    ok() 只收 name（见上），所以"为什么不算问题"写进 name 里。
	const svg = path.join(root, 'starmap', 'static.svg')
	const circleCount = Array.isArray(pack.circles) ? pack.circles.length : (Number.isFinite(pack.circles) ? pack.circles : 0)
	if (fs.existsSync(svg)) ok('静态版 SVG（M3）')
	else if (!circleCount) ok('静态版 SVG（M3）：0 个圆圈时生成器反空转不出图 —— 不算问题')
	else bad('静态版 SVG（M3）', '缺 starmap/static.svg')
	const notes = path.join(root, 'reference', 'NOTES.html')
	if (fs.existsSync(notes)) ok('笔记页') ; else bad('笔记页', '缺 reference/NOTES.html')

	return { consistent: drift.length === 0, checks, drift, warnings: pack.warnings }
}
