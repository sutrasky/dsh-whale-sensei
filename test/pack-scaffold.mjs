#!/usr/bin/env node
/**
 * test/pack-scaffold.mjs — 判据：选目录 →（空目录）就地建好课程包 → 设为 packRoot
 * ------------------------------------------------------------------
 * 跑：node test/pack-scaffold.mjs [课程包根]
 *
 * 这一套盯四件事（每一件都能单独证伪）：
 *   ① **模板完整且内容-free**：28 个引擎件都在、与课程包侧 skill-draft 逐字节一致、
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
import { FROM_PACK, FROM_SKILL, DERIVED, SANITIZE, sanitizeText, templatePaths } from './pack-template-rules.mjs'
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
  const expectCount = TEMPLATE_FILES.length + 9 // 9 = 骨架文件（台账 / 配置 / README / .git* 等）
  ok(built.created?.length === expectCount, `文件数 = 模板 ${TEMPLATE_FILES.length} + 骨架 9 = ${expectCount}（实得 ${built.created?.length}）`)
  ok(fs.existsSync(path.join(target, 'assets', 'questions-data.js')) && fs.existsSync(path.join(target, 'lesson.config.json')), '骨架文件落地（questions-data.js / lesson.config.json）')
  ok(fs.existsSync(path.join(target, 'lessons', 'src')) && fs.existsSync(path.join(target, 'code')) && fs.existsSync(path.join(target, 'questions')), '目录树落地（lessons/src、code、questions）')

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
  ok(routes.length === 1 && route.path === '/api/whale/pack/choose', `挂了一条路由 ${route?.path}`)
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
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 选目录 / 建包 / 配置三条链都可用，且拒绝面真的会拒绝')
