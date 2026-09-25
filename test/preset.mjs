/**
 * preset.mjs —— 「鲸师模式」这个 agent 预设的判据（丙1b）
 * ==================================================================
 * 为什么单开一套：预设是**换一种开会话的方式**，它写错了不会当场红 ——
 * 症状是"选了鲸师模式，但老师什么都不知道"（人设没挂上）或"技能列表里啥都没有"
 * （技能目录指错），两种都很难往预设上想。
 *
 * 覆盖面：
 *   ① `preset.yml`：名字是「鲸师模式」、description 非空、order 是数；
 *   ② 组合里 persona / skill-filesystem / tool-skill 三行都在；
 *   ③ **老师人设**：persona.prefix 里必须有老师身份 + 三条教学纪律 + 教学方式可调项 + 5 个技能名；
 *   ④ **双权威**：persona 里不许出现三段协议的步骤顺序（只许指路）；
 *   ⑤ `customSkillDirs` 必须是**占位符** `__WHALE_SKILLS__`（写死本机路径换台机器就断）；
 *   ⑥ **不藏其他技能**：不许写 `includeDefaultRoots: false`（主人 2026-09-25 定：并存，不替换）；
 *   ⑦ `persona.md` 与合成出来的 `prefix` **逐字一致**（防"只改了一个"）。
 *
 * 零依赖：预设是 YAML，但本仓不引 YAML 库（项目纪律），所以这里只按行读需要的那几处。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.resolve(HERE, '..', 'preset', 'whale-mode')

let pass = 0
const fails = []
function ok(cond, msg) {
	if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}

const ymlPath = path.join(DIR, 'agent.cordis.yml')
const presetPath = path.join(DIR, 'preset.yml')
const personaPath = path.join(DIR, 'persona.md')

if (!fs.existsSync(ymlPath) || !fs.existsSync(presetPath)) {
	console.log('=== 跳过：preset/whale-mode 还没合成（先跑 node preset/whale-mode/build-preset.mjs）===')
	process.exit(0)
}

const yml = fs.readFileSync(ymlPath, 'utf8')
const preset = fs.readFileSync(presetPath, 'utf8')
const persona = fs.readFileSync(personaPath, 'utf8').replace(/\r\n/g, '\n').trimEnd()

// ── ① preset.yml ──
{
	const name = (/^name:\s*(.+)$/m.exec(preset) || [])[1]
	const desc = (/^description:\s*(.+)$/m.exec(preset) || [])[1]
	const order = (/^order:\s*(\d+)$/m.exec(preset) || [])[1]
	ok(name === '鲸师模式', `预设名是「鲸师模式」（实得 ${JSON.stringify(name)}）`)
	ok(!!desc && desc.length >= 20, 'description 说清了它是什么（选预设时看的就是这句）')
	ok(Number.isInteger(Number(order)), `order 是数字（${order}）`)
}

// ── ② 组合三行 ──
{
	const ids = [...yml.matchAll(/^-\s*id:\s*(\S+)/gm)].map((m) => m[1])
	ok(ids.includes('persona'), '组合里有 persona（人设才挂得上）')
	ok(ids.includes('skill-filesystem'), '组合里有 skill-filesystem（技能目录才被发现）')
	ok(ids.includes('tool-skill'), '组合里有 tool-skill（agent 才拿得到技能目录与加载器）')
	ok(ids.length >= 10, `组合条目数 ${ids.length}（不是空壳）`)
}

// ── ③ 老师人设：身份 + 三条纪律 + 教学方式 + 5 个技能 ──
let prefix = ''
{
	const lines = yml.split('\n')
	const start = lines.findIndex((l) => /^\s*prefix:\s*\|\s*$/.test(l))
	ok(start >= 0, 'persona.prefix 是 YAML 字面块')
	if (start >= 0) {
		const block = []
		for (let i = start + 1; i < lines.length; i++) {
			if (/^-\s/.test(lines[i])) break
			if (lines[i].trim() === '') { block.push(''); continue }
			if (!/^\s{6,}/.test(lines[i])) break
			block.push(lines[i].replace(/^\s{6}/, ''))
		}
		prefix = block.join('\n').trimEnd()
	}
	ok(prefix.length > 300, `prefix 是一段真的人设（${prefix.length} 字）`)
	ok(/老师/.test(prefix) && /学生/.test(prefix), 'prefix 里有老师身份与学生关系（不是通用助手口吻）')
	for (const d of ['先读学生代码', '先查资料给出处', '不拿口头确认判过']) {
		ok(prefix.includes(d), `三条教学纪律在：${d}`)
	}
	ok(/锁死|说改也不改/.test(prefix), '写明这三条是**锁死**的（学生说改也不改）')
	ok(/可调项/.test(prefix) && /注释密度/.test(prefix) && /tier/.test(prefix), '教学方式的可调项与"默认随档位变"都写进了人设')
	ok(/whale_teaching/.test(prefix) && /预览/.test(prefix) && /点头/.test(prefix), '「翻译 → 预览 → 点头才写」三步写进了人设')
	for (const s of ['whale-system', 'whale-lesson', 'whale-practice', 'whale-qa', 'whale-record']) {
		ok(prefix.includes(s), `5 个技能名在：${s}`)
	}
}

// ── ④ 双权威：人设里不许抄步骤顺序 ──
{
	const marks = ['① 查资料', '② 看挑战', '③ 生成课程']
	const hit = marks.filter((m) => prefix.includes(m))
	ok(hit.length === 0, `人设里**没有**三段协议的步骤顺序（只许指路）${hit.length ? ' —— 抄了：' + hit.join(' / ') : ''}`)
	ok(/starter\.js|protocolLines/.test(prefix), '人设**真的指了路**（不是"没抄"因为什么都没写）')
}

// ── ⑤ 技能目录是占位符 ──
{
	// 按行读到"不再是这一块的列表项"为止 —— 用一条跨行正则会把下一个条目（`- id: tool-skill`）也吞进来
	const lines = yml.split('\n')
	const at = lines.findIndex((l) => /^\s*customSkillDirs:\s*$/.test(l))
	const items = []
	if (at >= 0) {
		for (let j = at + 1; j < lines.length; j++) {
			const m = /^\s{6,}-\s*'?"?([^'"\n]+?)'?"?\s*$/.exec(lines[j])
			if (!m) break
			items.push(m[1].trim())
		}
	}
	ok(items.length === 1 && items[0] === '__WHALE_SKILLS__',
		`customSkillDirs 只有一个**占位符** ${JSON.stringify(items)}（安装器替换成 <packRoot>/skills；写死本机路径换台机器就断）`)
}

// ── ⑥ 不藏其他技能 ──
{
	ok(!/includeDefaultRoots:\s*false/.test(yml),
		'**没有** includeDefaultRoots: false —— 课程包的 5 个技能是**加进来**的，不替换掉主人已有的技能')
}

// ── ⑦ persona.md 与合成结果逐字一致 ──
{
	ok(prefix === persona, `persona.md 与 agent.cordis.yml 的 prefix **逐字一致**（${prefix.length} 字）—— 改人设只改 persona.md 再重跑合成`)
}

// ── ⑧ 没有写死本机路径 ──
{
	const bad = ['E:\\', 'E:/', 'C:\\', 'C:/']
	const hit = bad.filter((b) => yml.includes(b))
	ok(hit.length === 0, `预设里没有写死的本机盘符路径${hit.length ? ' —— 实得：' + hit.join(' / ') : ''}`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 预设名对 · 三行组合齐 · 老师人设含纪律与教学方式与 5 技能 · 双权威没被抄 · 技能目录是占位符 · 不藏其他技能')
