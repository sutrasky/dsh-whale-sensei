#!/usr/bin/env node
/**
 * test/pack-scaffold.mjs — 判据：选目录 →（空目录）就地建好课程包 → 设为 packRoot
 * ------------------------------------------------------------------
 * 跑：node test/pack-scaffold.mjs [课程包根]
 *
 * 这一套盯四件事（每一件都能单独证伪）：
 *   ① **模板完整且内容-free**：模板里的引擎件都在、与课程包侧 skill-draft 逐字节一致、
 *      里面没有任何机器专属路径（和 alien-env 同一条静态守卫）。
 *   ② **只往空目录里建**：非空 / 不存在 / 已经是课程包 —— 三种都必须拒绝，且说清为什么。
 *   ③ **建出来的包真能用**：`composeTheme` 不抛、`themeDrift.same`（随包发的 theme.css
 *      与现场合成结果一致 = 模板内部自洽）、`readPack` 读得动、空台账是**空**的。
 *   ④ **生效两条腿**：`hctx.paths.packRoot` 当场就变；profile 层 cordis.patch.yml
 *      被就地更新且**其它字段一个不丢**（这条最容易写坏 —— 补丁行会整体替换 config）。
 *
 * ⚠️ 全程不弹真对话框：`pickFolder` 走 `WHALE_PICK_FOLDER_FAKE` 测试钩子。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { TEMPLATE_DIR, TEMPLATE_FILES, looksLikePack, isEmptyDir, planScaffold, writeScaffold } from '../lib/pack-scaffold.js'
import { FROM_PACK, FROM_SKILL, FROM_PACK_BINARY, DERIVED, SANITIZE, sanitizeText, templatePaths } from './pack-template-rules.mjs'
import { patchPackRootYml, findProfileDir, writeProfilePackRoot } from '../lib/profile-packroot.js'
import { pickFolder } from '../lib/pick-folder.js'
import { choosePack, plugin as packPlugin } from '../lib/mods/pack.js'
import { moduleTableDrift } from '../lib/mods/status.js'
import { composeTheme, themeDrift } from '../lib/style.js'
import { readPack } from '../lib/pack.js'
import { packRoot } from './_pack.mjs'

const PACK = packRoot()
const require_ = createRequire(import.meta.url)

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`) } else { fails.push(m); console.log(` FAIL ${m}`) } }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-scaffold-'))
const emptyDir = () => fs.mkdtempSync(path.join(tmpRoot, 'empty-'))
const walk = (dir, root = dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, root, out)
    else out.push(path.relative(root, p).split(path.sep).join('/'))
  }
  return out
}

console.log(`\n[pack-scaffold] 课程包：${PACK}\n  临时目录：${tmpRoot}`)

try {
  // ── ① 模板完整 + 内容-free + 与课程包侧逐字节一致 ────────────────────────
  console.log('\n① 模板')
  const missingTpl = TEMPLATE_FILES.filter((f) => !fs.existsSync(path.join(TEMPLATE_DIR, f)))
  ok(missingTpl.length === 0, `模板 ${TEMPLATE_FILES.length} 个文件都在${missingTpl.length ? '（缺：' + missingTpl.join('、') + '）' : ''}`)

  // 两份清单（运行时那份在 lib/pack-scaffold.js、规则那份在 test/pack-template-rules.mjs）不许漂
  const a = [...TEMPLATE_FILES].sort().join('\n')
  const b = [...templatePaths()].sort().join('\n')
  ok(a === b, `运行时清单与规则清单一致（各 ${TEMPLATE_FILES.length} 项）`)

  const FORBID = [/workplace/i, /dsh-raw-html-v2/i]
  const DRIVE = /(?<![A-Za-z])[A-Za-z]:[\\/][^\s'"`)]*/g
  const SYSTEM_OK = /^[A-Za-z]:\\{1,2}(Program|Windows)\b/i
  const offenders = []
  for (const rel of walk(TEMPLATE_DIR)) {
    if (!/\.(js|mjs|cjs|json|ya?ml|md|txt)$/i.test(rel)) continue
    const text = fs.readFileSync(path.join(TEMPLATE_DIR, rel), 'utf8')
    const hits = []
    for (const r of FORBID) { const m = text.match(r); if (m) hits.push(m[0]) }
    for (const m of text.match(DRIVE) || []) if (!SYSTEM_OK.test(m)) hits.push(m)
    if (hits.length) offenders.push(`${rel}（${[...new Set(hits)].slice(0, 2).join('、')}）`)
  }
  ok(offenders.length === 0, `模板里 0 处机器专属路径${offenders.length ? '（' + offenders.join('；') + '）' : ''}`)

  const SKILL = path.join(PACK, 'skill-draft')
  // —— 模板 = 原件经 pack-template-rules 的中性化替换；每条规则都必须真的命中 ——
  const missedRules = []
  const tplDrift = []
  for (const rel of FROM_PACK) {
    if (DERIVED.includes(rel)) continue
    const src = path.join(PACK, rel)
    if (!fs.existsSync(src)) { tplDrift.push(`${rel}（课程包里没有原件）`); continue }
    const s = sanitizeText(rel, fs.readFileSync(src, 'utf8'))
    missedRules.push(...s.missed)
    const tpl = path.join(TEMPLATE_DIR, rel)
    const got = fs.existsSync(tpl) ? fs.readFileSync(tpl, 'utf8') : null
    if (got !== s.text) tplDrift.push(`${rel}（模板 ${got == null ? '缺' : Buffer.byteLength(got)} vs 期望 ${Buffer.byteLength(s.text)}）`)
  }
  ok(missedRules.length === 0, `中性化规则全部命中（${SANITIZE.length} 条）${missedRules.length ? '：' + missedRules.join('；') : ''}`)
  ok(tplDrift.length === 0, `模板 == 课程包原件经中性化（${FROM_PACK.length - DERIVED.length} 个）${tplDrift.length ? '：' + tplDrift.join('、') : ''}`)

  // —— 二进制件（字体 / favicon）：不走 utf8 文本管线，判据 = Buffer **逐字节**相等 ——
  const binDrift = []
  for (const rel of FROM_PACK_BINARY) {
    const src = path.join(PACK, rel)
    const tpl = path.join(TEMPLATE_DIR, rel)
    if (!fs.existsSync(src)) { binDrift.push(`${rel}（课程包里没有原件）`); continue }
    const got = fs.existsSync(tpl) ? fs.readFileSync(tpl) : null
    if (!got || !got.equals(fs.readFileSync(src))) binDrift.push(`${rel}（不是逐字节一致）`)
  }
  ok(binDrift.length === 0, `二进制件与课程包原件**逐字节**一致（${FROM_PACK_BINARY.length} 个）${binDrift.length ? '：' + binDrift.join('、') : ''}`)

  // 派生件：模板里的 theme.css 必须**就是**对模板目录现场合成的结果
  const tplTheme = fs.readFileSync(path.join(TEMPLATE_DIR, 'assets', 'theme.css'), 'utf8')
  const composed = composeTheme(TEMPLATE_DIR).css
  ok(tplTheme === composed, `派生件 assets/theme.css == 现场合成结果（${Buffer.byteLength(tplTheme)} 字节）`)

  if (fs.existsSync(SKILL)) {
    const skillDrift = FROM_SKILL.filter((rel) => {
      const a = path.join(TEMPLATE_DIR, rel)
      const b = path.join(SKILL, rel)
      return !fs.existsSync(a) || !fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b))
    })
    ok(skillDrift.length === 0, `空台账骨架与 skill-draft 逐字节一致（${FROM_SKILL.length} 个）${skillDrift.length ? '：' + skillDrift.join('、') : ''}`)
  } else {
    console.log('  skip 课程包侧没有 skill-draft，跳过骨架对拍')
  }

  // ── ② 只往空目录里建 ────────────────────────────────────────────────────
  console.log('\n② 拒绝面')
  const notExist = path.join(tmpRoot, 'no-such-dir')
  ok(planScaffold(notExist).ok === false, `不存在的目录 → 拒绝（${planScaffold(notExist).error}）`)

  const dirty = emptyDir()
  fs.writeFileSync(path.join(dirty, '别删我.txt'), 'x', 'utf8')
  const pd = planScaffold(dirty)
  ok(pd.ok === false && /不是空/.test(pd.error), `非空目录 → 拒绝（${pd.error}）`)
  ok(fs.readdirSync(dirty).length === 1 && fs.existsSync(path.join(dirty, '别删我.txt')), '被拒绝时**一个字节都没动**')

  const asPack = planScaffold(PACK)
  ok(asPack.ok === false && /已经是一个课程包/.test(asPack.error), `已经是课程包 → 拒绝（${asPack.error}）`)
  ok(looksLikePack(PACK) && !looksLikePack(emptyDir()), 'looksLikePack：课程包 true / 空目录 false')
  ok(isEmptyDir(emptyDir()).empty === true, 'isEmptyDir：空目录 true')

  // ── ③ 建出来的包真能用 ──────────────────────────────────────────────────
  console.log('\n③ 建包')
  const target = emptyDir()
  const built = writeScaffold(target)
  ok(built.ok === true, `空目录建包成功（${built.created?.length} 个文件 / ${built.bytes} 字节）`)
  const expectCount = TEMPLATE_FILES.length + 11 // 11 = 骨架文件（台账 / 配置 / 空星图数据 / **空实践区数据** / README / .git* 等；页面壳已改从模板拷）
  ok(built.created?.length === expectCount, `文件数 = 模板 ${TEMPLATE_FILES.length} + 骨架 11 = ${expectCount}（实得 ${built.created?.length}）`)
  ok(fs.existsSync(path.join(target, 'assets', 'questions-data.js')) && fs.existsSync(path.join(target, 'lesson.config.json')), '骨架文件落地（questions-data.js / lesson.config.json）')
  // 2026-09-25 实测的真缺陷：`assets/_frame.html:142` 引用 practice-data.js，但它不在模板清单里
  // ⇒ 新包首课那个脚本 404、实践区不渲染（要跑过一次 whale_practice write=true 才有）。
  // 照「空星图」先例：建包就生成 0 项空骨架，契约与 whale_practice 的产出**同形**（复用真生成器序列化）。
  const pdata = require_(path.join(target, 'assets', 'practice-data.js'))
  ok(
    pdata.version === 2 && pdata.keyScheme === 'lesson-id' && Object.keys(pdata.lessons || {}).length === 0 && Object.keys(pdata.byFile || {}).length === 0,
    `骨架文件落地（practice-data.js：0 项空骨架，version=${pdata.version} keyScheme=${pdata.keyScheme}）`
  )
  ok(fs.existsSync(path.join(target, 'lessons', 'src')) && fs.existsSync(path.join(target, 'code')) && fs.existsSync(path.join(target, 'questions')), '目录树落地（lessons/src、code、questions）')

  // 页面壳引用的本地脚本必须**件件都在**（上面那条 404 的通用判据：清单漏一件，学生页就静默少一块）
  const frameHtml = fs.readFileSync(path.join(target, 'assets', '_frame.html'), 'utf8')
  const frameSrcs = [...frameHtml.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map((m) => m[1].replace(/\{\{PAGE_UP\}\}/g, '').replace(/^\.\//, ''))
    .filter((s) => !/^https?:/.test(s))
  const frameMissing = frameSrcs.filter((s) => !fs.existsSync(path.join(target, s)) && !fs.existsSync(path.join(target, 'assets', s)))
  ok(
    frameMissing.length === 0,
    `_frame.html 引用的本地脚本件件都在（${frameSrcs.length} 件）${frameMissing.length ? '（缺：' + frameMissing.join('、') + '）' : ''}`
  )

  // —— star 工具齐全 + 空星图已生成 + **交互版**三件随包（2026-09-24「交互版星图随包」）——
  const STAR_FILES = ['tools/build-starmap.js', 'tools/build-starmap-svg.js', 'tools/galaxy-shapes.cjs', 'tools/lesson-map.js', 'tools/plan-map.js',
    'starmap/data-layer.js', 'starmap/main.js', 'starmap/vendor/three/three.module.js', 'starmap/vendor/three/three.core.js',
    'starmap/fonts/Lanxi-JingHei.woff2', 'starmap/fonts/Lanxi-HeiTiLight.woff2']
  const starMissing = STAR_FILES.filter((rel) => !fs.existsSync(path.join(target, rel)))
  ok(starMissing.length === 0, `star 工具齐全（${STAR_FILES.length} 件，含交互版 main.js / vendor / 字体）${starMissing.length ? '（缺：' + starMissing.join('、') + '）' : ''}`)

  ok(fs.existsSync(path.join(target, 'starmap', 'content.js')) && fs.existsSync(path.join(target, 'starmap', 'index.html')), '空星图已生成（starmap/content.js + index.html，**不等第一次建圈**）')
  const starWin = {}
  new Function('window', fs.readFileSync(path.join(target, 'starmap', 'content.js'), 'utf8'))(starWin)
  const star = starWin.STARMAP_REAL || {}
  ok(Array.isArray(star.halos) && star.halos.length === 0 && (star.lessons || []).length === 0, '空星图**纯空**（0 圈 / 0 课）—— 不许塞默认圈当地基（假进度比没有进度更伤）')
  ok(Object.keys(star).join(',') === 'termTotal,halos,lessons,edges', `空载荷键序 = tools/build-starmap.js 的载荷（${Object.keys(star).join(',')}）`)
  const starHtml = fs.readFileSync(path.join(target, 'starmap', 'index.html'), 'utf8')
  ok(starHtml.includes('<!--@static-map-->') && starHtml.includes('<!--/@static-map-->'), '空星图页留了 <!--@static-map--> 标记区（build-starmap-svg.js 只认这一对）')
  ok(/<svg\b/.test(starHtml) && /fill="#05070e"/.test(starHtml), '页面有**底图**（SVG + 深空底色）—— 打开不是白屏')
  ok(starHtml.includes('建第一个圈'), '页面给了明确的「建第一个圈」引导')
  ok(starHtml.includes('./main.js') && starHtml.includes('./content.js'),
    '页面壳是**交互版**（探针按需加载 main.js + 读 content.js）—— 新包不再只有静态 SVG')

  const theme = composeTheme(target)
  ok(!!theme.css && theme.css.length > 1000, `whale_style 的合成不抛且出 css（${theme.css.length} 字符，slug=${theme.slug}）`)
  const drift = themeDrift(target)
  ok(drift.same === true, `随包发的 assets/theme.css 与现场合成**逐字节一致**${drift.same ? '' : '（漂移：磁盘 ' + (drift.actual?.length ?? 0) + ' vs 合成 ' + drift.expected.length + '）'}`)

  const rp = readPack(target)
  ok(rp && Array.isArray(rp.circles) && rp.lessons.length === 0, `readPack 读得动空包（${rp.circles.length} 圆圈 / ${rp.lessons.length} 门课）`)

  const g = require_(path.join(target, 'assets', 'glossary-data.js'))
  const q = require_(path.join(target, 'assets', 'questions-data.js'))
  ok(typeof g === 'object' && Object.keys(g).length === 0, 'glossary-data.js 是**空骨架**（0 个名词 —— 不含任何人的课程内容）')
  ok(typeof q === 'object' && Object.keys(q).length === 0, 'questions-data.js 是空台账（0 条答疑）')

  // ── ④ profile 层配置：就地改一行，其它字段一个不丢 ──────────────────────
  console.log('\n④ profile 配置')
  const yml = [
    'top: 1',
    '- id: whale-sensei',
    '  config:',
    "    packRoot: 'D:/old/pack'",
    '    announceOnBoot: true',
    '- id: baode',
    "  config: { dataDir: 'D:/baode' }",
    '',
  ].join('\r\n')
  const rep = patchPackRootYml(yml, 'D:/new/pack')
  ok(rep.changed === 'replace', `已有 packRoot → 就地替换（${rep.changed}）`)
  ok(rep.text.includes("packRoot: 'D:/new/pack'") && !rep.text.includes('D:/old/pack'), '新值写进去了、旧值没了')
  ok(rep.text.includes('announceOnBoot: true'), '**其它字段（announceOnBoot）保留** —— 补丁行整体替换 config，这条最容易写坏')
  ok(rep.text.includes("dataDir: 'D:/baode'"), '别的 id（baode）一个字节没动')
  ok(rep.text.includes('\r\n'), '换行风格保留（CRLF）')

  const ins = patchPackRootYml('- id: whale-sensei\r\n  config:\r\n    announceOnBoot: true\r\n', 'D:/x')
  ok(ins.changed === 'insert' && /config:\r\n\s+packRoot: 'D:\/x'/.test(ins.text), '有 config 无 packRoot → 插在 config 下')
  const app = patchPackRootYml('top: 1\r\n', 'D:/y')
  ok(app.changed === 'append' && app.text.includes('- id: whale-sensei') && app.text.includes("packRoot: 'D:/y'"), '没有这一段 → 追加整段')

  const fakeHome = path.join(tmpRoot, 'dsh-home')
  fs.mkdirSync(path.join(fakeHome, 'profiles', 'web'), { recursive: true })
  fs.writeFileSync(path.join(fakeHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'web-profile', dependencies: { 'dsh-whale-sensei': 'link:.' } }), 'utf8')
  fs.writeFileSync(path.join(fakeHome, 'profiles', 'web', 'cordis.patch.yml'), yml, 'utf8')
  fs.mkdirSync(path.join(fakeHome, 'profiles', 'other'), { recursive: true })

  const found = findProfileDir({ dshHome: fakeHome })
  ok(found.ok === true && found.name === 'web', `按 package.json 找到装载鲸师的 profile（${found.ok ? found.name : found.error}）`)

  const w = writeProfilePackRoot('D:/brand/new', { dshHome: fakeHome })
  const after = fs.readFileSync(path.join(fakeHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  ok(w.ok === true && after.includes("packRoot: 'D:/brand/new'"), '写盘 + 回读校验通过（判据是磁盘上的字节）')
  ok(!!w.backup && fs.existsSync(w.backup), `改前留了备份（${w.backup ? path.basename(w.backup) : '没有'}）`)
  ok(after.includes('announceOnBoot: true') && after.includes('baode'), '落盘后其它字段仍在')

  // ── ⑤ choosePack 三态 + 路由形状 ────────────────────────────────────────
  console.log('\n⑤ choosePack')
  const hctx = { paths: { packRoot: undefined }, log: { info() {}, warn() {}, error() {} } }

  const t2 = emptyDir()
  const created = await choosePack({ dir: t2, dshHome: fakeHome }, hctx)
  ok(created.ok === true && created.mode === 'created', `空目录 → created（${created.mode}）`)
  ok(hctx.paths.packRoot === path.resolve(t2), 'hctx.paths.packRoot **当场就变**（本次会话立即生效）')
  ok(created.config?.file?.endsWith('cordis.patch.yml') === true, `profile 配置也写了（${created.config?.file}）`)

  const beforeBytes = walk(PACK).length
  const hctx2 = { paths: { packRoot: undefined }, log: { info() {}, warn() {}, error() {} } }
  const reused = await choosePack({ dir: PACK, dshHome: fakeHome }, hctx2)
  ok(reused.ok === true && reused.mode === 'reused' && reused.created.length === 0, `已经是课程包 → reused 且不建包（${reused.mode}）`)
  ok(walk(PACK).length === beforeBytes, `复用课程包时真包零改动（${beforeBytes} 个文件）`)
  ok(hctx2.paths.packRoot === path.resolve(PACK), '复用时也把 packRoot 设成了它')

  const hctx3 = { paths: { packRoot: undefined }, log: { info() {}, warn() {}, error() {} } }
  const refused = await choosePack({ dir: dirty, dshHome: fakeHome }, hctx3)
  ok(refused.ok === false && /不是空/.test(refused.error), `非空非课程包 → 拒绝（${refused.error}）`)
  ok(hctx3.paths.packRoot === undefined, '被拒绝时**没有**把 packRoot 设过去（不静默改状态）')

  process.env.WHALE_PICK_FOLDER_FAKE = t2
  const fakePick = pickFolder()
  delete process.env.WHALE_PICK_FOLDER_FAKE
  ok(fakePick.ok === true && fakePick.path === path.resolve(t2) && fakePick.dialog === 'fake', '测试钩子 WHALE_PICK_FOLDER_FAKE 生效（不弹真对话框）')

  console.log('\n⑥ 路由形状')
  const routes = []
  packPlugin.install({
    paths: { packRoot: undefined },
    log: { info() {}, warn() {}, error() {} },
    inject: (_n, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
  })
  const route = routes[0]
  ok(routes.length === 2 && route.path === '/api/whale/pack/choose', `挂了两条路由 ${routes.map((r) => r.path).join('、')}`)
  const openRoute = routes.find((r) => r.path === '/api/whale/pack/open')
  ok(!!openRoute && openRoute.methods.join() === 'POST' && openRoute.requestBody === 'buffered',
    '第二条是 POST /api/whale/pack/open（侧栏「进入课程包」靠它）且**显式声明 requestBody**')
  ok(route.methods.join() === 'POST' && route.requestBody === 'buffered', 'methods=POST 且**显式声明 requestBody**（省略会被基座当 streaming ⇒ 400 空体）')
  const req = (method, body) => new Request('http://127.0.0.1:3090/api/whale/pack/choose', {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }),
  })
  const r405 = await route.fetch(req('GET'))
  ok(r405.status === 405, `非 POST → 405（${r405.status}）`)
  const r400 = await route.fetch(req('POST', '{不是 JSON'))
  ok(r400.status === 400, `坏 JSON → 400（${r400.status}）`)

  // 反空转：把"已经是课程包"的判据放宽一点点，拒绝面必须红
  const hctx4 = { paths: {}, log: { info() {}, warn() {}, error() {} } }
  const loose = await choosePack({ dir: dirty, dshHome: fakeHome, dryRun: true }, hctx4)
  ok(loose.ok === false, '反空转：非空目录即使 dryRun 也必须拒绝（不许"先看看"就放行）')

  // ── ⑦ 「宿主过期」探测（2026-09-23 现场踩过的那一下）────────────────────
  // 现场：客户端刷新拿到了新按钮，但宿主是改之前启动的 ⇒ 新路由没注册 ⇒ 宿主回纯文本
  // "not found" ⇒ 前端 JSON.parse 炸 ⇒ 看着像功能坏了。两处都要能说清这件事。
  console.log('\n⑦ 宿主过期探测')
  const sameList = path.join(tmpRoot, 'mods-same.js')
  fs.writeFileSync(sameList, "export const manifest = {\n\tmods: {\n\t\tenabled: ['a', 'b'],\n\t},\n}\n", 'utf8')
  const otherList = path.join(tmpRoot, 'mods-other.js')
  fs.writeFileSync(otherList, "export const manifest = {\n\tmods: {\n\t\tenabled: ['a', 'b', 'pack'],\n\t},\n}\n", 'utf8')

  ok(moduleTableDrift(['a', 'b'], sameList) === null, '磁盘模块表 == 内存 → 不报（不制造噪音）')
  const dr = moduleTableDrift(['a', 'b'], otherList)
  ok(dr && dr.disk.length === 3 && dr.mem.length === 2, `磁盘 3 个 / 内存 2 个 → 判出"宿主是改之前启动的"（${dr ? dr.disk.join(',') : '—'}）`)
  ok(moduleTableDrift(['a', 'b'], path.join(tmpRoot, '不存在.js')) === null, '读不动 → 返回 null（不因为一个提示项把卡弄红）')

  const clientSrc = fs.readFileSync(path.join(TEMPLATE_DIR, '..', 'client.js'), 'utf8')
  ok(/not\\s\*found/.test(clientSrc) && clientSrc.includes('必须重启宿主'), '客户端把纯文本 "not found" 说成人话（"宿主那半边改了必须重启宿主"）')
  ok(clientSrc.includes('宿主里还没有这条路由'), '客户端的这句话是给人看的，不是把 JSON 报错原样甩出来')

  // ── ⑧ 设置卡观感：两个操作挂在「课程包」那块里；样式照原生选择器 ──────────
  console.log('\n⑧ 观感（照 DSH 原生设置页）')
  const headAt = clientSrc.indexOf('var head = react.createElement')
  const headEnd = clientSrc.indexOf('function actionBtn(', headAt)
  const headBlock = headAt >= 0 && headEnd > headAt ? clientSrc.slice(headAt, headEnd) : ''
  ok(headBlock.length > 0 && !/选择课程包目录|重新读取/.test(headBlock), '卡头里不再有按钮（两个操作都搬到「课程包」那一块里）')
  ok(/var packActions = react\.createElement[\s\S]{0,400}选择课程包目录/.test(clientSrc), '「选择课程包目录…」在 packActions 里')
  ok(/var packActions = react\.createElement[\s\S]{0,500}重新读取/.test(clientSrc), '「重新读取」也在 packActions 里（同一组）')
  ok(/s\.title === '课程包'[\s\S]{0,200}packActions/.test(clientSrc), 'packActions 挂在「课程包」那一块下面（不是飘在别处）')
  ok(clientSrc.includes('if (!packActionsPlaced) body.push(packActions)'), '兜底：服务端改标题也不能让入口静默消失')
  ok(/function actionBtn\(label, onClick, disabled\)/.test(clientSrc), '两个操作走一份配方（actionBtn）')
  ok(/background: 'var\(--dsw-alias-bg-module-platform\)'/.test(clientSrc), '按钮底色照原生选择器：bg-module-platform 灰胶囊（深色主题下深色实心反而更不显眼）')
  ok(/height: '36px', borderRadius: '18px', padding: '0 14px'/.test(clientSrc), '尺寸照原生：36px / 圆角 18px / padding 0 14px')
  ok(clientSrc.includes("borderBottom: '.5px solid var(--dsw-alias-border-l2)'"), '行分隔线照原生：.5px solid border-l2')
  ok(/fontSize: '16px', fontWeight: 500/.test(clientSrc), '分区标题照原生：16px / 500')
  ok(/function btn\(kind, size\)/.test(clientSrc) && /BTN_SIZE/.test(clientSrc), '行内按钮走一份配方（36/18 与 28/14 两档，照原生 primaryButton/secondaryButton）')

  // ── ⑨ 产物闸门：0 圈的包不许报「缺 starmap/static.svg」（板 A–H 的 D 条）────────
  // 红窗口 = 「建包之后、建第一个圈之前」：static.svg 的唯一产出链（tools/build-starmap.js →
  // build-starmap-svg.js）对 0 个圆圈**刻意拒绝产出**（反空转），所以 verify.js ⑤ 必须
  // 有条件：有圆圈才要求它。下面三条正好把这个条件的**两侧**都钉死（不是把检查废掉）：
  //   判据 1        0 圈 / 无 svg → 不是 bad，且 checks/drift 里没有那句话
  //   判据 2（反空转 A）1 圈 / 无 svg → **必须 bad**（忘了重建照样抓）
  //   判据 3（反空转 B）0 圈 / 有 svg → ok（有文件就过，不论圆圈数）
  // 全程只在 os.tmpdir() 影副本上动手；真包只读，并在本节前后逐文件对拍（判据 5）。
  console.log('\n⑨ 产物闸门（0 圈不许报缺 starmap/static.svg）')
  const { execFileSync } = require_('node:child_process')
  const { verifyPack } = await import('../lib/verify.js')
  const BAD_LINE = '缺 starmap/static.svg'
  const snapPack = (dir) => walk(dir).sort().map((rel) => {
    const st = fs.statSync(path.join(dir, rel))
    return `${rel}\t${st.size}\t${Math.round(st.mtimeMs)}`
  }).join('\n')
  const realBefore = snapPack(PACK)
  const fresh = () => {
    const d = emptyDir()
    const r = writeScaffold(d)
    if (!r.ok) throw new Error('⑨ 建包失败：' + r.error)
    return d
  }
  const check5 = (d) => verifyPack(d, readPack(d)).checks.find((c) => c.name.startsWith('静态版 SVG'))

  // 判据 1：真建一个空包（writeScaffold → os.tmpdir()）→ ⑤ 不许是 bad
  const p0 = fresh()
  const v0 = verifyPack(p0, readPack(p0))
  const c0 = check5(p0)
  ok(!!c0 && c0.ok === true, `判据1：0 圈空包的 ⑤ 不是 bad（${c0 ? c0.name : '没有这一条'}）`)
  ok(!v0.checks.some((c) => String(c.detail || '').includes(BAD_LINE)) && !v0.drift.some((s) => s.includes(BAD_LINE)),
    `判据1：整包 checks/drift 里没有「${BAD_LINE}」（drift 实得 ${v0.drift.length} 条）`)

  // 判据 2（反空转 A）：往空包里加一个圆圈（lessons/<圈>/halo.json）但**不建** static.svg → ⑤ 必须 bad
  const p1 = fresh()
  fs.mkdirSync(path.join(p1, 'lessons', 'math'), { recursive: true })
  fs.writeFileSync(path.join(p1, 'lessons', 'math', 'halo.json'), JSON.stringify({ name: '数学', color: '#5b8ff9' }), 'utf8')
  const v1 = verifyPack(p1, readPack(p1))
  const c1 = check5(p1)
  ok(!!c1 && c1.ok === false && c1.detail === BAD_LINE, `判据2（反空转A）：有圆圈没 svg → bad「${c1 ? c1.detail : '没有这一条'}」`)
  ok(v1.drift.some((s) => s.includes(BAD_LINE)), '判据2：drift 里指名「缺 starmap/static.svg」（不是把检查废掉了）')

  // 判据 3（反空转 B）：空包里**手写**一个 starmap/static.svg → ⑤ 必须 ok（有文件就过，不论圆圈数）
  const p2 = fresh()
  fs.writeFileSync(path.join(p2, 'starmap', 'static.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8')
  const c2 = check5(p2)
  ok(!!c2 && c2.ok === true && c2.name === '静态版 SVG（M3）', `判据3（反空转B）：0 圈有 svg → ok（${c2 ? c2.name : '没有这一条'}）`)
  fs.writeFileSync(path.join(p1, 'starmap', 'static.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8')
  const c1b = check5(p1)
  ok(!!c1b && c1b.ok === true, `判据3b：有圆圈也有 svg → ok（${c1b ? c1b.name : '没有这一条'}）`)

  // 判据 4：端到端跑包闸门 tools/gate.mjs → **红清单**里不许有「缺 starmap/static.svg」。
  // ⚠️ 新包骨架**本身不含 tools/gate.mjs**（lib/pack-scaffold.js 的 README 明说）——
  // 所以先如实跑一次「空包原样」，再把真包的 gate.mjs **只读拷贝**进影副本跑一次（真包零改动）。
  const runGate = (cwd) => {
    try {
      return execFileSync(process.execPath, ['tools/gate.mjs'], { cwd, encoding: 'utf8', timeout: 180_000 })
    } catch (e) {
      return `${e.stdout || ''}\n${e.stderr || ''}`
    }
  }
  const gateShipped = runGate(p0)
  ok(!gateShipped.includes(BAD_LINE), `判据4a：空包原样跑 tools/gate.mjs → 没有「${BAD_LINE}」`)
  fs.copyFileSync(path.join(PACK, 'tools', 'gate.mjs'), path.join(p0, 'tools', 'gate.mjs'))
  const gateOut = runGate(p0)
  const redList = gateOut.split('\n').filter((l) => /^\s*✗ /.test(l))
  ok(!gateOut.includes(BAD_LINE), `判据4b：拷进真包 gate.mjs 再跑 → ${redList.length} 条红里没有「${BAD_LINE}」`)
  ok(!fs.existsSync(path.join(p0, 'starmap', 'static.svg')), '判据4：闸门跑完也没写出 static.svg（--check 只读，空包形态保持不变）')

  // 判据 5：全程只动 os.tmpdir() 影副本 —— 真包逐文件 path+size+mtime 对拍，一个字节都不许动
  ok(snapPack(PACK) === realBefore, `判据5：真包零改动（${realBefore.split('\n').length} 个文件 path+size+mtime 全同）`)
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 选目录 / 建包 / 配置三条链都可用，且拒绝面真的会拒绝')
