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
import { subjectsHit } from '../lib/teaching-io.js'

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
	// ⚠️ 锁死集**必须学科中立**（主人 2026-09-25 裁定）：鲸师面向全方面知识目标，不是编程专用。
	//    判法见 lib/teaching-io.js 的 subjectsHit()：命中恰好 1 个学科 = 特化（红）；≥2 = 跨学科举例（放行）。
	for (const d of ['先看学生的产出', '先查资料给出处', '不拿口头确认判过']) {
		ok(prefix.includes(d), `三条教学纪律在：${d}`)
	}
	ok(/锁死|说改也不改/.test(prefix), '写明这三条是**锁死**的（学生说改也不改）')
	{
		// 只扫**纪律那一段**（人设别处拿编程举例是可以的 —— 举例不是把特化写进纪律）
		const at = prefix.indexOf('三条教学纪律')
		const stop = prefix.indexOf('不在可调集里', at)
		const seg = at >= 0 ? prefix.slice(at, stop > 0 ? stop : at + 600) : ''
		const specialized = subjectsHit(seg).length === 1
		ok(!specialized, `纪律那一段是**学科中立**的（不是只对一个学科成立）${specialized ? ' —— 实得：' + subjectsHit(seg).join(',') : ''}`)
	}
	ok(/学科中立|不写在这里|圆圈/.test(prefix), '人设写明"学科特化挂在圆圈上、不写在全范围"（防止下次又长回来）')
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

// ── ⑨ 禁词表：**全范围层**不许只对一个学科成立（主人 2026-09-25 裁定）──
//    扫四处「全范围」面：
//      ① 预设人设（纪律段）
//      ② 插件的全局可调项表 + 锁死集
//      ③ 课程包的**全部 5 个技能**（2026-09-25 P2 扩的 —— 原先只扫总控 whale-system，
//         于是 `whale-lesson §1` 那套"编程圈怎么看产出"一直躺在一个全范围技能里没人管）
//      ④ 给 agent 读的两处插件话术（工具描述 / 开课协议）—— 见 `test/settings-teaching.mjs` ⑦
//    判法同一份（`subjectsHit`）：命中**恰好 1 个**学科 = 特化（红）；≥2 = 跨学科举例（放行）。
{
	const { TEACHING_PARAMS, TEACHING_DISCIPLINE } = await import('../lib/teaching-io.js')
	const surfaces = [
		['插件 · 全局可调项表', JSON.stringify(TEACHING_PARAMS)],
		['插件 · 锁死集', TEACHING_DISCIPLINE.map((d) => d.label + d.why).join('；')],
	]
	// 课程包的技能层：**五个都扫**（它们全是全范围面 —— 跟所有学科打交道）。
	// ⚠️ 学科特化**有它该去的地方**：圆圈的 `kind=guide`（固定做法）与 `kind=spec`（可调项），
	//    由 `injectionBlock` 带进生成该圆圈的课时 —— 判据见 `test/teaching-apply.mjs` ⑤。
	const skillsDir = path.resolve(HERE, '..', '..', 'study', 'skills')
	if (fs.existsSync(skillsDir)) {
		const names = fs.readdirSync(skillsDir).filter((d) => {
			try { return fs.statSync(path.join(skillsDir, d)).isDirectory() } catch { return false }
		}).sort()
		ok(names.length === 5, `课程包技能层是 5 个（${names.join(' / ')}）`)
		for (const n of names) {
			const f = path.join(skillsDir, n, 'SKILL.md')
			if (fs.existsSync(f)) surfaces.push([`课程包 · 技能 ${n}`, fs.readFileSync(f, 'utf8')])
		}
	} else {
		console.log(`   ⚠️ 跳过「课程包 · 技能层」（${skillsDir} 不在 —— 开发布局才有）`)
	}
	for (const [name, text] of surfaces) {
		const hit = subjectsHit(text)
		ok(hit.length !== 1, `禁词表 · ${name}：不是只对一个学科成立（命中 ${hit.length} 个：${hit.join('/') || '无'}）`)
	}
	ok(typeof subjectsHit === 'function', '禁词表判据与实现同一份（`lib/teaching-io.js` 的 subjectsHit）')

	// 反空转：这一面必须真的扫到了内容（不然上面全绿只是因为没读到文件）
	ok(surfaces.length >= 7, `扫到的面数 ≥ 7（实得 ${surfaces.length}：2 处插件 + 5 个技能）`)
	ok(surfaces.every(([, t]) => String(t).length > 80), '每一面都真的读到了内容（不是空串蒙混；最短的那面是锁死集，91 字）')
}

// ── ⑩ **预设随包走**（2026-09-27 事故的判据：别人装完预设不见了）──
//    事故本身：预设只由安装脚本的 1c 步落盘，而 npm 包的 `files` 里**没有** `preset/`
//    ⇒ 普通使用者那条路（`dsh plugin add dsh-whale-sensei`）连模板都拿不到，
//    1c 从来没机会跑；连那个 .ps1 也没发出去。判据就钉在这两件事上。
{
	const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'))
	const files = pkg.files ?? []
	// npm 的规则：`files` 里的一项覆盖它自己 + 它下面的整棵子树
	const shipped = (rel) => files.some((f) => {
		const d = String(f).replace(/\/+$/, '')
		return rel === d || rel.startsWith(d + '/')
	})
	for (const rel of ['preset/whale-mode/agent.cordis.yml', 'preset/whale-mode/preset.yml', 'preset/whale-mode/persona.md']) {
		ok(shipped(rel), `npm 包会带上 ${rel}（不带 ⇒ 别人的机器上根本没有预设模板）`)
	}
	ok(shipped('install-whale-sensei.ps1'), 'npm 包会带上安装脚本（README 让它去装，却发不出去）')
	ok(shipped('lib/preset-install.js'), 'npm 包会带上预设安装器（插件启动时靠它落盘）')
}

// ── ⑪ 安装器：真的装得出来，而且**幂等 / 不盖手写 / 缺模板要报错** ──
//    全部在临时目录里跑，**不碰真机**的 .agent-presets。
{
	const { installPreset, presetStatus, renderComposition, resolveDshHome, presetDirFor, PRESET_ID, SKILLS_PLACEHOLDER, MARKER } =
		await import('../lib/preset-install.js')
	const os = await import('node:os')
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-preset-test-'))
	const dshHome = path.join(tmp, 'dsh-home')
	const skillsA = path.join(tmp, 'packA', 'skills')
	const skillsB = path.join(tmp, 'packB', 'skills')
	fs.mkdirSync(skillsA, { recursive: true })
	fs.mkdirSync(skillsB, { recursive: true })
	const dir = presetDirFor(dshHome)

	// ① 目标目录名必须是**宿主认的** id（大小写/下划线/点都不行）
	ok(/^[a-z0-9][a-z0-9-]*$/.test(PRESET_ID), `预设 id ${PRESET_ID} 符合宿主的目录名规则`)

	// ② 第一次：装
	const r1 = installPreset({ dshHome, skillsDir: skillsA })
	ok(r1.action === 'created', `空机器上装得出预设（实得 ${r1.action}${r1.reason ? '：' + r1.reason : ''}）`)
	const text = fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8')
	ok(text.includes(MARKER), '落盘的组合带生成标记（下次才允许刷新它）')
	ok(!text.includes(SKILLS_PLACEHOLDER), '占位符被替换干净了（没留 __WHALE_SKILLS__）')
	ok(text.includes(skillsA.replace(/\\/g, '/')), `技能目录指到了课程包（${skillsA.replace(/\\/g, '/')}）`)

	// ③ 幂等：内容一样就一个字节都不写
	const r2 = installPreset({ dshHome, skillsDir: skillsA })
	ok(r2.action === 'unchanged', `再装一次是 unchanged（实得 ${r2.action}）`)

	// ④ 换了课程包 ⇒ 刷新（不重启也要换得掉）
	const r3 = installPreset({ dshHome, skillsDir: skillsB })
	ok(r3.action === 'refreshed', `技能目录变了会刷新（实得 ${r3.action}）`)
	ok(fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8').includes(skillsB.replace(/\\/g, '/')), '刷新后指向新的技能目录')

	// ⑤ 主人手写的那份：**一个字都不动**
	const hand = '# 我自己写的\n- id: x\n  name: cordis:group\n'
	fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), hand, 'utf8')
	const r4 = installPreset({ dshHome, skillsDir: skillsB })
	ok(r4.action === 'kept-hand-edited', `没有生成标记的判定为手写（实得 ${r4.action}）`)
	ok(fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8') === hand, '手写那份逐字节没被改')

	// ⑥ 没配 packRoot（skillsDir 不给）⇒ 留空列表，而不是留着占位符
	const dir2 = presetDirFor(dshHome, 'whale-mode-nopack')
	const r5 = installPreset({ dshHome, dir: dir2 })
	ok(r5.action === 'created' && /customSkillDirs: \[\]/.test(fs.readFileSync(path.join(dir2, 'agent.cordis.yml'), 'utf8')),
		'没有课程包时技能目录留空（不是留着占位符去指一个不存在的目录）')

	// ⑥b **认领旧格式**：老安装脚本 Copy+Replace 出来的那份（没有标记）要刷得动，
	//     否则老机器上的预设永远冻结在旧版 —— 而手写的**不能**被认领（见 ⑤）。
	{
		const dir3 = presetDirFor(dshHome, 'whale-mode-legacy')
		const legacy = renderComposition(fs.readFileSync(ymlPath, 'utf8'), skillsB).split('\n').slice(1).join('\n')
		fs.mkdirSync(dir3, { recursive: true })
		fs.writeFileSync(path.join(dir3, 'agent.cordis.yml'), legacy, 'utf8')
		const r = installPreset({ dshHome, dir: dir3, skillsDir: skillsB })
		ok(r.action === 'refreshed', `老格式（无标记但逐字节等于渲染结果）会被认领并刷新（实得 ${r.action}）`)
		ok(fs.readFileSync(path.join(dir3, 'agent.cordis.yml'), 'utf8').includes(MARKER), '认领后带上了生成标记')
	}

	// ⑦ 模板不在（npm 包里漏了 preset/ 的那种包）⇒ **明确报 no-template**，不静默装个空壳
	const r6 = installPreset({ dshHome, srcDir: path.join(tmp, 'not-a-template') })
	ok(r6.action === 'no-template', `模板不在时如实报 no-template（实得 ${r6.action}）`)
	ok(!!r6.reason && /preset/.test(r6.reason), 'no-template 的 reason 说清了缺什么')

	// ⑧ 写不进去 ⇒ failed（不假装成功）
	const blocked = path.join(tmp, 'blocked')
	fs.mkdirSync(path.join(blocked, '.agent-presets'), { recursive: true })
	fs.writeFileSync(path.join(blocked, '.agent-presets', 'whale-mode'), 'x', 'utf8') // 拿文件占住目录名
	const r7 = installPreset({ dshHome: blocked, skillsDir: skillsA })
	ok(r7.action === 'failed', `目录被占住时如实报 failed（实得 ${r7.action}${r7.reason ? '：' + r7.reason : ''}）`)

	// ⑨ 只看不写：presetStatus 读回来的东西与落盘的一致
	const stHand = presetStatus({ dir })
	ok(stHand.installed === true && stHand.generated === false, 'presetStatus 分得出"装着的"与"我们生成的"')
	const st2 = presetStatus({ dir: dir2 })
	ok(st2.installed === true && st2.generated === true, 'presetStatus 认得自己生成的那份')
	ok(st2.skillsDir === undefined, '没课程包时 presetStatus 的技能目录是空的（不是占位符）')
	ok(st2.name === '鲸师模式', `presetStatus 读得到显示名（实得 ${JSON.stringify(st2.name)}）`)

	// ⑩ 渲染规则只有一份：安装脚本与插件共用（这里直接判"脚本不再自己抄一份替换"）
	const ps1 = fs.readFileSync(path.resolve(HERE, '..', 'install-whale-sensei.ps1'), 'utf8')
	ok(/lib\\preset-install\.js/.test(ps1), '安装脚本 1c 调用 lib/preset-install.js（不再自己抄一份占位符替换）')
	ok(!/__WHALE_SKILLS__/.test(ps1), '安装脚本里没有第二份 __WHALE_SKILLS__ 替换逻辑')

	// ⑪ 渲染出的文本是**宿主认的形状**：顶层是列表，每行都有 name（宿主的 health 就查这个）
	{
		const rendered = renderComposition(fs.readFileSync(ymlPath, 'utf8'), skillsA)
		const body = rendered.split('\n').filter((l) => !/^\s*#/.test(l) && l.trim() !== '')
		const rows = body.filter((l) => /^-\s/.test(l))
		ok(rows.length >= 10, `渲染后顶层还是列表（${rows.length} 行顶层条目）`)
		const names = body.map((l) => (/^\s*name:\s*(.+)$/.exec(l) || [])[1]).filter(Boolean)
		ok(names.length >= rows.length, `每个条目都有 name（${names.length} 个 name / ${rows.length} 个顶层条目）—— 缺了会被宿主标 broken、选择器直接丢掉`)
		ok(names.every((n) => /^'?(@deepseek-ai\/|cordis:)/.test(n)), '行名全是宿主自带的包或 cordis: 内置（没有本机才有的第三方包）')
	}

	// ⑫ DSH_HOME 的算法必须与宿主同一套（$DSH_HOME → ~/.dsh），否则预设写去了别人不扫的目录
	ok(resolveDshHome({ DSH_HOME: 'E:\\x' }) === path.resolve('E:\\x'), '$DSH_HOME 给了就用它')
	ok(resolveDshHome({ DSH_HOME: '   ' }) === resolveDshHome({}), '空白 DSH_HOME 当没给（与宿主一致）')
	ok(resolveDshHome({}) === path.join(os.homedir(), '.dsh'), '没给就退 ~/.dsh（不是 cwd）')

	// ⑬ **选/建课程包之后要能当场刷新**（不然新用户第一次看到的预设是 0 个技能）
	{
		const { ensurePresetForPack } = await import('../lib/preset-install.js')
		const dshHome3 = path.join(tmp, 'dsh-home-3')
		const newPack = path.join(tmp, 'newpack')
		fs.mkdirSync(path.join(newPack, 'skills'), { recursive: true })
		const rA = ensurePresetForPack({ dshHome: dshHome3, packRoot: newPack })
		ok(rA.action === 'created' && rA.skillsDir === path.join(newPack, 'skills'),
			`按 packRoot 装：技能目录指到 <包>/skills（实得 ${JSON.stringify(rA.skillsDir)}）`)
		const rB = ensurePresetForPack({ dshHome: dshHome3, packRoot: path.join(tmp, 'pack-without-skills') })
		ok(rB.action === 'refreshed' && rB.skillsDir === undefined, `换成没有 skills/ 的包：技能目录留空（实得 ${rB.action}）`)
		ok(presetStatus({ dshHome: dshHome3 }).skillsDir === undefined, '磁盘上确实留空了（不指一个不存在的目录）')
	}

	fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 预设名对 · 三行组合齐 · 老师人设含纪律与教学方式与 5 技能 · 双权威没被抄 · 技能目录是占位符 · 不藏其他技能')