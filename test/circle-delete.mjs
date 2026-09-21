#!/usr/bin/env node
/**
 * test/circle-delete.mjs — 圆圈删除判据（POST /api/whale/circle/delete）
 * ------------------------------------------------------------------
 * 铁律：全程只对 os.tmpdir() 下自己造的临时课程包副本操作，一次都不许写 E:\workplace\study。
 *
 * 断言：
 *   [1] 路由契约：四条路由都在，delete 是 POST + requestBody=buffered
 *   [2] dryRun 只回清单、**一个字节都不写**（整棵树哈希前后相同），且清单数字来自真目录
 *   [3] 不 confirm → 拒绝，带 plan 但目录原封不动
 *   [4] confirm 不是 true（false/'yes'）→ 拒绝（不给默认值）
 *   [5] 找不到的 id → 拒绝，什么都没动
 *   [6] 真删：目录 + lessons/src/<dir> 一起没了，响应列出两条 deleted + 4 条重建命令
 *   [7] 删后 readPack 里没有它；再删一次 → 拒绝
 *   [8] 进度清理：learned 里属于它的课次被清掉，别的圆圈那条**不许动**
 *   [9] 学生代码 code/ 只报不删（清单列出它，删完目录还在）
 *   [10] 歧义：两个目录都声明同名 halo → 拒绝（宁可不动手）
 *   [11] 真包零改动：跑前跑后 git status --porcelain 逐字节相同（**相对基线**，不是"必须为空"）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { packRoot } from './_pack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')
const PACK = packRoot()

let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}

function gitStatus(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
  } catch (e) {
    return 'ERR:' + ((e.stdout || '') + (e.stderr || '')).trim()
  }
}

/**
 * 真包基线。**相对基线**比对，不是"必须为空" ——
 * 用户从设置页建一个圆圈（这正是本插件的功能）就会让真包多一行 `?? lessons/xxx/`，
 * 那跟"本套件有没有写真包"毫无关系。旧写法把功能本身的正常副作用判成了失败（2026-09-22 实测）。
 */
const realBefore = gitStatus(PACK)

/** 整棵树的内容哈希（路径 + 字节），用于"一个字节都没写"这类断言 */
function treeHash(dir) {
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else files.push(p)
    }
  }
  walk(dir)
  files.sort()
  const h = crypto.createHash('sha256')
  for (const f of files) {
    h.update(path.relative(dir, f).split(path.sep).join('/'))
    h.update('\u0000')
    h.update(fs.readFileSync(f))
  }
  return h.digest('hex')
}

// ── 造临时课程包副本（与 circle-create.mjs 同一条排除清单） ──
const EXCLUDE = ['_starmap-proto', 'demo', 'code', '.git', '.backup', '.tmp-cov', 'node_modules', 'skill-draft', '_chrome-profile']
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-delete-'))
const tmpPack = path.join(tmpRoot, 'pack')

function fakeRequest(method, body, url = 'http://localhost/api/whale/circle/delete') {
  return { method, url, json: async () => body }
}

function makeRouteCtx(packDir) {
  const routes = []
  return {
    ctx: {
      paths: { packRoot: packDir, dataDir: packDir },
      log: { info() {}, warn() {}, error() {} },
      registerTool: () => {},
      inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
    },
    routes,
  }
}

try {
  fs.cpSync(PACK, tmpPack, {
    recursive: true,
    filter: (src) => {
      if (path.resolve(src) === path.resolve(PACK)) return true
      return !EXCLUDE.includes(path.relative(PACK, src).split(path.sep)[0])
    },
  })

  // ── 自造"待删"圆圈 victim：1 个知识点 + 1 门课 + 学生代码目录 + 一条进度 ──
  const victim = path.join(tmpPack, 'lessons', 'victim')
  fs.mkdirSync(path.join(victim, 'algebra'), { recursive: true })
  fs.writeFileSync(path.join(victim, 'halo.json'), JSON.stringify({ _: '…待补…', halo: 'victim', name: '待删圈' }, null, 2) + '\n')
  fs.writeFileSync(path.join(victim, 'algebra', 'point.json'), JSON.stringify({
    _: '…待补…', point: 'algebra', name: '代数', fileBase: 0,
    practice: { dirs: ['code/victim/algebra'] },
  }, null, 2) + '\n')

  const lessonHtml = '<!doctype html><html><head>'
    + '<script type="application/json" data-lesson-meta>{"point":"algebra","number":1,"title":"一元二次"}</script>'
    + '</head><body>x</body></html>\n'
  const srcDir = path.join(tmpPack, 'lessons', 'src', 'victim', 'algebra')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(path.join(srcDir, '0001-quadratic.html'), lessonHtml)
  fs.writeFileSync(path.join(victim, 'algebra', '0001-quadratic.html'), lessonHtml)

  const codeDir = path.join(tmpPack, 'code', 'victim', 'algebra')
  fs.mkdirSync(codeDir, { recursive: true })
  fs.writeFileSync(path.join(codeDir, 'pom.xml'), '<project/>\n')

  const progPath = path.join(tmpPack, 'progress.json')
  const prog0 = JSON.parse(fs.readFileSync(progPath, 'utf8'))
  const learnedBefore = Array.isArray(prog0.learned) ? prog0.learned.slice() : []
  prog0.learned = learnedBefore.concat(['algebra/0001'])
  fs.writeFileSync(progPath, JSON.stringify(prog0, null, 2) + '\n')

  // 歧义用例：两个目录都声明 halo: "twin"
  for (const n of ['twin-a', 'twin-b']) {
    const d = path.join(tmpPack, 'lessons', n)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'halo.json'), JSON.stringify({ halo: 'twin', name: n }, null, 2) + '\n')
  }

  const { plugin } = await import(pathToFileURL(path.join(SRC, 'lib', 'mods', 'create.js')).href)
  const { ctx, routes } = makeRouteCtx(tmpPack)
  plugin.install(ctx)
  const deleteRoute = routes.find((r) => r.path === '/api/whale/circle/delete')

  // ── [1] 路由契约 ──
  {
    const expected = ['/api/whale/circle', '/api/whale/point', '/api/whale/circle/rename', '/api/whale/circle/delete']
    const actual = routes.map((r) => r.path).sort()
    ok(expected.slice().sort().join(',') === actual.join(','),
      `[1] create 注册的路径集合精确匹配 4 条（实得 ${actual.length}：${actual.join(', ')}）`)
    ok(deleteRoute != null, '[1] /api/whale/circle/delete 已注册')
    ok(deleteRoute?.methods?.includes('POST'), '[1] delete methods 包含 POST')
    ok(deleteRoute?.requestBody === 'buffered', `[1] delete requestBody = ${deleteRoute?.requestBody}（期望 buffered）`)

    const r405 = await deleteRoute.fetch(fakeRequest('GET', null))
    ok(r405.status === 405, `[1] GET → 405（实得 ${r405.status}）`)
  }

  // ── [2] dryRun 只回清单，一个字节都不写 ──
  {
    const hashBefore = treeHash(tmpPack)
    const res = await deleteRoute.fetch(fakeRequest('POST', { id: 'victim', dryRun: true }))
    const d = await res.json()
    ok(d.ok === true && d.dryRun === true, `[2] dryRun 返回 ok（实得 ok=${d.ok}, dryRun=${d.dryRun}${d.error ? '，error=' + d.error : ''}）`)
    ok(treeHash(tmpPack) === hashBefore, '[2] dryRun 后整棵树哈希与之前相同（没写盘）')
    const plan = d.plan
    ok(plan?.id === 'victim' && plan?.name === '待删圈', `[2] 清单里 id/显示名正确（${plan?.id} / ${plan?.name}）`)
    ok(plan?.lessons === 1 && plan.lessonIds?.[0] === 'algebra/0001', `[2] 清单说 1 门课：${JSON.stringify(plan?.lessonIds)}`)
    const main = plan?.dirs?.find((x) => x.path === 'lessons/victim')
    const srcEntry = plan?.dirs?.find((x) => x.path === 'lessons/src/victim')
    ok(main?.files === 3, `[2] 目录 lessons/victim 实有 3 个文件（halo.json + point.json + 课页；实得 ${main?.files}）`)
    ok(srcEntry?.files === 1, `[2] 目录 lessons/src/victim 实有 1 个文件（实得 ${srcEntry?.files}）`)
    ok(plan.files === 4, `[2] 清单合计文件数 = 目录实有数之和（实得 ${plan.files}，期望 3+1）`)
    ok(plan.progressIds.length === 1 && plan.progressIds[0] === 'algebra/0001', `[2] 清单列出要清的进度条目：${JSON.stringify(plan.progressIds)}`)
    ok(plan.codeDirs.includes('code/victim/algebra'), `[2] 清单列出学生代码目录（只报不删）：${JSON.stringify(plan.codeDirs)}`)
  }

  // ── [3] 不 confirm → 拒绝，但目录原封不动 ──
  {
    const hashBefore = treeHash(tmpPack)
    const res = await deleteRoute.fetch(fakeRequest('POST', { id: 'victim' }))
    const d = await res.json()
    ok(d.ok === false && /confirm/.test(d.error || ''), `[3] 不带 confirm → ok=false 且错误里点名 confirm（实得：${d.error}）`)
    ok(d.plan?.id === 'victim', '[3] 被拒时仍把清单回给调用方（前端才能弹窗）')
    ok(fs.existsSync(victim), '[3] 目录还在（没删）')
    ok(treeHash(tmpPack) === hashBefore, '[3] 被拒后整棵树哈希不变')
  }

  // ── [4] confirm 不是 true → 拒绝 ──
  {
    for (const bad of [false, 'yes', 1]) {
      const res = await deleteRoute.fetch(fakeRequest('POST', { id: 'victim', confirm: bad }))
      const d = await res.json()
      ok(d.ok === false && /confirm/.test(d.error || ''), `[4] confirm=${JSON.stringify(bad)} → 拒绝（${d.error}）`)
    }
    ok(fs.existsSync(victim), '[4] 三次非法 confirm 之后目录仍在')
  }

  // ── [5] 找不到的 id → 拒绝，什么都没动 ──
  {
    const hashBefore = treeHash(tmpPack)
    const res = await deleteRoute.fetch(fakeRequest('POST', { id: 'nope', confirm: true }))
    const d = await res.json()
    ok(d.ok === false && /找不到圆圈/.test(d.error || ''), `[5] 不存在的 id → 拒绝（${d.error}）`)
    ok(treeHash(tmpPack) === hashBefore, '[5] 整棵树哈希不变')

    const badId = await deleteRoute.fetch(fakeRequest('POST', { id: '../etc', confirm: true }))
    const bd = await badId.json()
    ok(bd.ok === false && /id 不合法/.test(bd.error || ''), `[5] 路径穿越式 id 被 id 闸拦掉（${bd.error}）`)
  }

  // ── [6][7][8][9] 真删 ──
  {
    const res = await deleteRoute.fetch(fakeRequest('POST', { id: 'victim', confirm: true }))
    const d = await res.json()
    ok(d.ok === true, `[6] confirm:true → 删除成功（${d.error || ''}）`)
    ok(!fs.existsSync(victim), '[6] lessons/victim 已消失')
    ok(!fs.existsSync(path.join(tmpPack, 'lessons', 'src', 'victim')), '[6] lessons/src/victim 也一起消失')
    ok(JSON.stringify(d.deleted) === JSON.stringify(['lessons/victim', 'lessons/src/victim']),
      `[6] 响应列出删掉的两个目录：${JSON.stringify(d.deleted)}`)
    ok(Array.isArray(d.needsRebuild) && d.needsRebuild.length === 4 && d.needsRebuild.every((c) => c.startsWith('node ')),
      `[6] 回了 4 条重建命令：${JSON.stringify(d.needsRebuild)}`)

    const { readPack } = await import(pathToFileURL(path.join(SRC, 'lib', 'pack-model.js')).href)
    const pack = readPack(tmpPack)
    ok(!pack.circles.some((c) => c.id === 'victim'), '[7] 重新 readPack：victim 圆圈不在了')
    ok(!pack.lessons.some((l) => l.circle === 'victim'), '[7] 重新 readPack：victim 名下的课也不在了')

    const again = await deleteRoute.fetch(fakeRequest('POST', { id: 'victim', confirm: true }))
    const ad = await again.json()
    ok(ad.ok === false && /找不到圆圈/.test(ad.error || ''), `[7] 再删一次 → 拒绝（${ad.error}）`)

    const prog = JSON.parse(fs.readFileSync(progPath, 'utf8'))
    ok(!prog.learned.includes('algebra/0001'), `[8] progress.json 里清掉了 algebra/0001（learned=${JSON.stringify(prog.learned)}）`)
    ok(learnedBefore.every((x) => prog.learned.includes(x)),
      `[8] 别的圆圈的进度**一条都没动**（原 ${JSON.stringify(learnedBefore)}）`)
    ok(d.progressCleaned === 1, `[8] 响应说清了 1 条（实得 ${d.progressCleaned}）`)
    ok(prog.note !== undefined && prog._ !== undefined, '[8] progress.json 的其它字段（_ / note）保留')

    ok(fs.existsSync(path.join(codeDir, 'pom.xml')), '[9] 学生代码目录仍在（只报不删）')
    ok(d.codeDirs.includes('code/victim/algebra'), `[9] 响应对学生代码做了显式交代：${JSON.stringify(d.codeDirs)}`)
  }

  // ── [10] 歧义拒绝 ──
  {
    const res = await deleteRoute.fetch(fakeRequest('POST', { id: 'twin', confirm: true }))
    const d = await res.json()
    ok(d.ok === false && /歧义/.test(d.error || ''), `[10] 两个目录都声明 twin → 拒绝（${d.error}）`)
    ok(fs.existsSync(path.join(tmpPack, 'lessons', 'twin-a')) && fs.existsSync(path.join(tmpPack, 'lessons', 'twin-b')),
      '[10] 两个目录都还在（宁可不动手）')
  }

  // ── [11] 真包零改动（相对基线） ──
  {
    const realAfter = gitStatus(PACK)
    ok(realAfter === realBefore,
      `[11] 跑前跑后真包 git status 相同（相对基线；基线=${realBefore || '空'}，实得=${realAfter || '空'}）`)
  }
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 圆圈删除：dryRun 只报清单 / 必须 confirm / 目录+源+进度一并删 / 学生代码只报不删 / 歧义拒绝')
