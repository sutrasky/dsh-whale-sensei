#!/usr/bin/env node
/**
 * test/circle-create.mjs — 写入口判据（新建圆圈 / 知识点）
 * ------------------------------------------------------------------
 * 铁律：全程只对 os.tmpdir() 下自己造的临时课程包副本操作，一次都不许写 E:\workplace\study。
 *
 * 断言：
 *   [1] 建圆圈 math/「数学」→ halo.json 存在、JSON.parse 通过、字段正确；响应含 needsRebuild + warn
 *   [2] 拒覆盖：再建同名 → 拒绝，文件内容逐字节未变
 *   [3] 坏 id 三种（Math / _x / a/b）→ 全拒绝，磁盘上什么都没多出来
 *   [4] 原子性：成功与失败后都没有 *.tmp* 残留
 *   [5] 建知识点 math/algebra → fileBase:0；再建 math/geometry → fileBase:1000
 *   [6] fake circle：往不存在的圆圈里建知识点 → 拒绝
 *   [7] 真包零改动：git status --porcelain 必须为空
 *   [8] 闸门回归：对照基线 → 建圆圈+知识点 → 重建 → 闸门，新红=0 且 build-starmap/build-lessons 真绿 + 反空转 + 真包零改动
 *   [9] 路由契约：两条路由都存在、methods/POST/requestBody/path
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

// ── 造临时课程包副本 ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-create-'))
const tmpPack = path.join(tmpRoot, 'pack')

// 复制最小 fixture：presets/ + templates/ + lesson.config.json + lessons/
const EXCLUDE = ['_starmap-proto', 'demo', 'code', '.git', '.backup', '.tmp-cov', 'node_modules', 'skill-draft', '_chrome-profile']
fs.cpSync(PACK, tmpPack, {
  recursive: true,
  filter: (src) => {
    if (path.resolve(src) === path.resolve(PACK)) return true
    return !EXCLUDE.includes(path.relative(PACK, src).split(path.sep)[0])
  },
})

// ── helper：构建假 request ──
function fakeRequest(method, body) {
  return {
    method,
    url: 'http://localhost/api/whale/circle',
    json: async () => body,
  }
}

// ── helper：创建路由上下文 ──
function makeCtx(packDir) {
  return {
    paths: { packRoot: packDir, dataDir: packDir },
    log: { info() {}, warn() {}, error() {} },
    registerTool: () => {},
    inject: (names, cb) => cb({ get: () => ({ fetch: { register: () => {} } }) }),
  }
}

// ── helper：收集路由 ──
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
  // 动态导入模块
  const { plugin } = await import(pathToFileURL(path.join(SRC, 'lib', 'mods', 'create.js')).href)

  // ── [9] 路由契约（先测，因为它不写盘）──
  {
    const { ctx, routes } = makeRouteCtx(tmpPack)
    plugin.install(ctx)

    const expectedPaths = ['/api/whale/circle', '/api/whale/point', '/api/whale/circle/rename']
    const actualPaths = routes.map((r) => r.path).sort()
    ok(actualPaths.length === expectedPaths.length, `[9] create 注册了 ${expectedPaths.length} 条路由（实得 ${actualPaths.length}：${actualPaths.join(', ')})`)
    ok(expectedPaths.every((p) => routes.some((r) => r.path === p)), `[9] 路由集合包含 ${expectedPaths.join(', ')}`)
    ok(expectedPaths.length === actualPaths.length && expectedPaths.sort().join(',') === actualPaths.join(','), `[9] 路由集合精确匹配（无多余/遗漏）`)
    for (const ep of expectedPaths) {
      const r = routes.find((x) => x.path === ep)
      ok(r?.methods?.includes('POST'), `[9] ${ep} methods 包含 POST`)
      ok(r?.requestBody === 'buffered', `[9] ${ep} requestBody = ${r?.requestBody}（期望 buffered）`)
      ok(r?.path?.startsWith('/api/'), `[9] ${ep} 在 /api/ 前缀下`)
    }
  }

  // ── [1] 建圆圈 math/「数学」──
  {
    const { ctx, routes } = makeRouteCtx(tmpPack)
    plugin.install(ctx)
    const circleR = routes.find((r) => r.path === '/api/whale/circle')

    const res = await circleR.fetch(fakeRequest('POST', { name: '数学', id: 'math' }))
    const body = await res.json()

    ok(body.ok === true, '[1] 建圆圈 math 成功')
    ok(body.id === 'math', `[1] 响应 id = ${body.id}`)
    ok(body.path === 'lessons/math/halo.json', `[1] 响应 path = ${body.path}`)

    const haloPath = path.join(tmpPack, 'lessons', 'math', 'halo.json')
    ok(fs.existsSync(haloPath), '[1] halo.json 存在')
    const halo = JSON.parse(fs.readFileSync(haloPath, 'utf8'))
    ok(halo.halo === 'math', `[1] halo.halo = ${halo.halo}`)
    ok(halo.name === '数学', `[1] halo.name = ${halo.name}`)

    ok(Array.isArray(body.needsRebuild) && body.needsRebuild.length === 4, `[1] needsRebuild 含 4 条（实得 ${body.needsRebuild?.length}）`)
    ok(body.warn != null && body.warn.length > 0, `[1] warn 非空：${body.warn}`)
  }

  // ── [2] 拒覆盖：再建同名圆圈 ──
  {
    const { ctx, routes } = makeRouteCtx(tmpPack)
    plugin.install(ctx)
    const circleR = routes.find((r) => r.path === '/api/whale/circle')

    const before = fs.readFileSync(path.join(tmpPack, 'lessons', 'math', 'halo.json'), 'utf8')
    const res = await circleR.fetch(fakeRequest('POST', { name: '数学2', id: 'math' }))
    const body = await res.json()

    ok(body.ok === false, '[2] 再建同名圆圈被拒绝')
    const after = fs.readFileSync(path.join(tmpPack, 'lessons', 'math', 'halo.json'), 'utf8')
    ok(before === after, '[2] 文件内容逐字节未变')
  }

  // ── [3] 坏 id 三种：Math / _x / a/b ──
  {
    const { ctx, routes } = makeRouteCtx(tmpPack)
    plugin.install(ctx)
    const circleR = routes.find((r) => r.path === '/api/whale/circle')

    const beforeEntries = fs.readdirSync(path.join(tmpPack, 'lessons')).sort()

    for (const badId of ['Math', '_x', 'a/b']) {
      const res = await circleR.fetch(fakeRequest('POST', { name: '坏', id: badId }))
      const body = await res.json()
      ok(body.ok === false, `[3] 坏 id "${badId}" 被拒绝`)
    }

    const afterEntries = fs.readdirSync(path.join(tmpPack, 'lessons')).sort()
    ok(beforeEntries.join('|') === afterEntries.join('|'), '[3] 磁盘上什么都没多出来（lessons/ 目录前后一致）')
  }

  // ── [4] 原子性：没有 *.tmp* 残留 ──
  {
    // 扫整个 tmpPack 看有没有 .tmp 文件
    function findTmpFiles(dir, out = []) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) findTmpFiles(p, out)
        else if (e.name.includes('.tmp')) out.push(p)
      }
      return out
    }
    const tmpFiles = findTmpFiles(tmpPack)
    ok(tmpFiles.length === 0, `[4] 没有 *.tmp* 残留（实得 ${tmpFiles.length}）`)
  }

  // ── [5a] 建知识点 math/algebra → fileBase: 0 ──
  {
    const { ctx, routes } = makeRouteCtx(tmpPack)
    plugin.install(ctx)
    const pointR = routes.find((r) => r.path === '/api/whale/point')

    const res = await pointR.fetch(fakeRequest('POST', { circle: 'math', name: '代数', id: 'algebra' }))
    const body = await res.json()

    ok(body.ok === true, '[5a] 建知识点 math/algebra 成功')
    ok(body.id === 'math/algebra', `[5a] 响应 id = ${body.id}`)

    const pointPath = path.join(tmpPack, 'lessons', 'math', 'algebra', 'point.json')
    ok(fs.existsSync(pointPath), '[5a] point.json 存在')
    const pt = JSON.parse(fs.readFileSync(pointPath, 'utf8'))
    ok(pt.fileBase === 0, `[5a] fileBase = ${pt.fileBase}（期望 0，该圆圈还没有知识点）`)
    ok(pt.point === 'algebra', `[5a] point = ${pt.point}`)
    ok(pt.name === '代数', `[5a] name = ${pt.name}`)
    ok(body.warn === null, '[5a] warn 为 null')
  }

  // ── [5b] 再建 math/geometry → fileBase: 1000 ──
  {
    const { ctx, routes } = makeRouteCtx(tmpPack)
    plugin.install(ctx)
    const pointR = routes.find((r) => r.path === '/api/whale/point')

    const res = await pointR.fetch(fakeRequest('POST', { circle: 'math', name: '几何', id: 'geometry' }))
    const body = await res.json()

    ok(body.ok === true, '[5b] 建知识点 math/geometry 成功')
    const pt = JSON.parse(fs.readFileSync(path.join(tmpPack, 'lessons', 'math', 'geometry', 'point.json'), 'utf8'))
    ok(pt.fileBase === 1000, `[5b] fileBase = ${pt.fileBase}（期望 1000）`)
  }

  // ── [6] fake circle：往不存在的圆圈里建知识点 ──
  {
    const { ctx, routes } = makeRouteCtx(tmpPack)
    plugin.install(ctx)
    const pointR = routes.find((r) => r.path === '/api/whale/point')

    const res = await pointR.fetch(fakeRequest('POST', { circle: 'nonexistent', name: '幽灵', id: 'ghost' }))
    const body = await res.json()

    ok(body.ok === false, '[6] 往不存在的圆圈里建知识点被拒绝')
    // 确认没有顺手造出幽灵目录
    const ghostDir = path.join(tmpPack, 'lessons', 'nonexistent', 'ghost')
    ok(!fs.existsSync(ghostDir), '[6] 没有顺手造出幽灵目录（没有 halo.json 的那种）')
  }

  // ── [6b] 拒覆盖知识点 ──
  {
    const { ctx, routes } = makeRouteCtx(tmpPack)
    plugin.install(ctx)
    const pointR = routes.find((r) => r.path === '/api/whale/point')

    const before = fs.readFileSync(path.join(tmpPack, 'lessons', 'math', 'algebra', 'point.json'), 'utf8')
    const res = await pointR.fetch(fakeRequest('POST', { circle: 'math', name: '代数2', id: 'algebra' }))
    const body = await res.json()
    ok(body.ok === false, '[6b] 再建同名知识点被拒绝')
    const after = fs.readFileSync(path.join(tmpPack, 'lessons', 'math', 'algebra', 'point.json'), 'utf8')
    ok(before === after, '[6b] point.json 内容逐字节未变')
  }

  // ── [6c] packRoot 没配 → 明确报错 ──
  {
    const routes = []
    const ctx = {
      paths: { packRoot: undefined, dataDir: undefined },
      log: { info() {}, warn() {}, error() {} },
      registerTool: () => {},
      inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
    }
    plugin.install(ctx)
    const circleR = routes.find((r) => r.path === '/api/whale/circle')
    const pointR = routes.find((r) => r.path === '/api/whale/point')

    const res1 = await circleR.fetch(fakeRequest('POST', { name: 'x', id: 'x' }))
    const b1 = await res1.json()
    ok(b1.ok === false && /未配置 packRoot/.test(b1.error), '[6c] packRoot 没配时 circle 明确报错')

    const res2 = await pointR.fetch(fakeRequest('POST', { circle: 'x', name: 'x', id: 'x' }))
    const b2 = await res2.json()
    ok(b2.ok === false && /未配置 packRoot/.test(b2.error), '[6c] packRoot 没配时 point 明确报错')
  }

  // ── [6d] name 空 → 拒绝 ──
  {
    const { ctx, routes } = makeRouteCtx(tmpPack)
    plugin.install(ctx)
    const circleR = routes.find((r) => r.path === '/api/whale/circle')

    const res = await circleR.fetch(fakeRequest('POST', { name: '', id: 'empty' }))
    const body = await res.json()
    ok(body.ok === false && /name 不能为空/.test(body.error), '[6d] name 空被拒绝')
  }

  // ── [4b] 第二轮原子性检查 ──
  {
    function findTmpFiles(dir, out = []) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) findTmpFiles(p, out)
        else if (e.name.includes('.tmp')) out.push(p)
      }
      return out
    }
    const tmpFiles = findTmpFiles(tmpPack)
    ok(tmpFiles.length === 0, `[4b] 第二轮原子性检查：没有 *.tmp* 残留（实得 ${tmpFiles.length}）`)
  }

  // ── [8] 闸门回归：对照基线 → 建 → 重建 → 闸门，新红=0 ──
  {
    const gateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-gate-'))
    const gatePack = path.join(gateRoot, 'pack')
    const STYLES_DIR = path.join(gateRoot, 'dsh-raw-html-v2-master', 'styles')
    const EXCLUDE_GATE = ['_starmap-proto', 'demo', 'code', '.git', '.backup', '.tmp-cov', 'node_modules', 'skill-draft', '_chrome-profile']

    fs.cpSync(PACK, gatePack, {
      recursive: true,
      filter: (src) => {
        if (path.resolve(src) === path.resolve(PACK)) return true
        return !EXCLUDE_GATE.includes(path.relative(PACK, src).split(path.sep)[0])
      },
    })
    // 复制 styles 目录（style-adapter.js 退路链末段需要课程包旁边的 dsh-raw-html-v2-master/styles）
    fs.cpSync(path.join(path.dirname(PACK), 'dsh-raw-html-v2-master', 'styles'), STYLES_DIR, { recursive: true })

    // helper：跑一次 gate.mjs，返回失败检查名集合
    function runGate(cwd) {
      let out = ''
      try {
        out = execFileSync(process.execPath, ['tools/gate.mjs'], { cwd, encoding: 'utf8', timeout: 120_000 })
      } catch (e) {
        out = (e.stdout || '') + '\n' + (e.stderr || '')
      }
      const failed = new Set()
      // gate.mjs 输出格式：✗ node tools/xxx（exit N）
      for (const m of out.matchAll(/✗\s+(.+?)（exit \d+）/g)) {
        failed.add(m[1].trim())
      }
      return failed
    }

    try {
      // ── A. 对照段：复制完先跑一次闸门，收失败集合 base ──
      const base = runGate(gatePack)
      ok(true, `[8] A. 对照基线：${base.size} 条红（${base.size}/18 失败，排除清单造成的已知缺件）`)

      // ── B. 动作段：建 math 圆圈 + algebra 知识点 → 重建 → 闸门 ──
      const { ctx: gateCtx, routes: gateRoutes } = makeRouteCtx(gatePack)
      plugin.install(gateCtx)
      const circleR = gateRoutes.find((r) => r.path === '/api/whale/circle')
      const pointR = gateRoutes.find((r) => r.path === '/api/whale/point')

      const resCircle = await circleR.fetch(fakeRequest('POST', { name: '数学', id: 'math' }))
      const bCircle = await resCircle.json()
      ok(bCircle.ok === true, '[8] B. 建圆圈 math 成功')

      const resPoint = await pointR.fetch(fakeRequest('POST', { circle: 'math', name: '代数', id: 'algebra' }))
      const bPoint = await resPoint.json()
      ok(bPoint.ok === true, '[8] B. 建知识点 math/algebra 成功')

      // 依次真跑 4 条重建，每条要求 exit 0
      const rebuilds = [
        'node tools/build-lessons.js',
        'node tools/build-starmap.js',
        'node assets/build-glossary.js',
        'node tools/build-notes.js',
      ]
      for (const cmd of rebuilds) {
        let exit = 0, rebuildOut = ''
        try {
          rebuildOut = execFileSync(process.execPath, cmd.split(' ').slice(1), { cwd: gatePack, encoding: 'utf8', timeout: 120_000 })
        } catch (e) {
          exit = e.status ?? 1
          rebuildOut = (e.stdout || '') + '\n' + (e.stderr || '')
        }
        ok(exit === 0, `[8] B. 重建 ${cmd} 退出码 = ${exit}（期望 0）${exit !== 0 ? '——尾部：' + rebuildOut.slice(-300) : ''}`)
      }

      // 重建后再跑一次闸门
      const after = runGate(gatePack)

      // ── C. 断言 ──
      // C1. 新红 = 0：after 里不许出现 base 里没有的检查名
      const newRed = [...after].filter((x) => !base.has(x))
      ok(newRed.length === 0, `[8] C1. 新红 = 0（新出现的失败：${newRed.length ? newRed.join(', ') : '无'}）`)

      // C2. build-starmap.js --check 在 after 里是 PASS
      const starmapFail = [...after].some((x) => x.includes('build-starmap'))
      ok(!starmapFail, `[8] C2. build-starmap.js --check 在 after 里 ${starmapFail ? '仍红' : 'PASS'}`)

      // C3. build-lessons.js --check 在 after 里是 PASS
      const lessonsFail = [...after].some((x) => x.includes('build-lessons'))
      ok(!lessonsFail, `[8] C3. build-lessons.js --check 在 after 里 ${lessonsFail ? '仍红' : 'PASS'}`)

      // ── D. 反空转：故意在 after 里加一条假红，断言集合差会捕获 ──
      const afterWithFake = new Set(after)
      afterWithFake.add('node tools/fake-red-check.js（exit 1）')
      const fakeNewRed = [...afterWithFake].filter((x) => !base.has(x))
      ok(fakeNewRed.length === 1 && fakeNewRed[0].includes('fake-red-check'),
        `[8] D. 反空转：故意加一条假红 → 集合差捕获 ${fakeNewRed.length} 条（期望 1 条 fake-red-check）`)

      // ── E. 真包零改动 ──
      let gitOut = ''
      try {
        gitOut = execFileSync('git', ['-C', PACK, 'status', '--porcelain'], { encoding: 'utf8' })
      } catch (e) {
        gitOut = (e.stdout || '') + (e.stderr || '')
      }
      ok(gitOut.trim() === '', `[8] E. 真包 git status --porcelain 为空（实得：${gitOut.trim() || '空'}）`)

    } finally {
      try { fs.rmSync(gateRoot, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  // ── [7] 真包零改动 ──
  {
    let out = ''
    try {
      out = execFileSync('git', ['-C', PACK, 'status', '--porcelain'], { encoding: 'utf8' })
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '')
    }
    ok(out.trim() === '', `[7] 真包 git status --porcelain 为空（实得：${out.trim() || '空'}）`)
  }

} finally {
  // 清理临时目录
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 写入口：新建圆圈/知识点（原子、拒覆盖、坏 id 拒绝、绝不碰真包）')
