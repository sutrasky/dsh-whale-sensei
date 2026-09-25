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
 *   [10] 色带用尽：把圈色吃到尽 → 再建圈 → 拒绝 + 文案含修法（到哪加色/怎么加/哪条对拍），
 *        不是"建出一个没 color 的圈"，被拒的不落盘
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

/**
 * 真包基线：本套件一个字节都不许写真包。
 * **相对基线**比，不是"必须为空" —— 用户从设置页建圆圈（本插件的功能）就会让真包
 * 多出未提交的改动，那跟"本套件有没有写真包"毫无关系（2026-09-22 实测的假红）。
 */
function gitStatus(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
  } catch (e) {
    return 'ERR:' + ((e.stdout || '') + (e.stderr || '')).trim()
  }
}
const realBefore = gitStatus(PACK)

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

/**
 * fixture 卫生：把真包里**用户自己建的圆圈**从副本里剔掉，只留 programming。
 * 为什么必须剔：本套件会在副本上建 `math`，而用户完全可能已经用设置页建过 `math` ——
 * 那时副本里已经有它，建同名会被"拒覆盖"打回，套件就报一堆与插件无关的假红（2026-09-22 实测）。
 * fixture 必须是**已知的**，不能是"用户今天的课程包长什么样"。
 */
function pruneCircles(packDir) {
  const lessons = path.join(packDir, 'lessons')
  for (const n of fs.readdirSync(lessons)) {
    if (n === 'programming' || n === 'src') continue
    fs.rmSync(path.join(lessons, n), { recursive: true, force: true })
  }
}
pruneCircles(tmpPack)

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

    // 四条写入口（POST）+ 一条重建查询口（GET，2026-09-24 加：入口建完自己起重建，前端轮询进度）
    const postPaths = ['/api/whale/circle', '/api/whale/point', '/api/whale/circle/rename', '/api/whale/circle/delete']
    const getPaths = ['/api/whale/rebuild']
    const expectedPaths = [...postPaths, ...getPaths]
    const actualPaths = routes.map((r) => r.path).sort()
    ok(actualPaths.length === expectedPaths.length, `[9] create 注册了 ${expectedPaths.length} 条路由（实得 ${actualPaths.length}：${actualPaths.join(', ')})`)
    ok(expectedPaths.every((p) => routes.some((r) => r.path === p)), `[9] 路由集合包含 ${expectedPaths.join(', ')}`)
    ok(expectedPaths.length === actualPaths.length && expectedPaths.sort().join(',') === actualPaths.join(','), `[9] 路由集合精确匹配（无多余/遗漏）`)
    ok(routes.find((r) => r.path === '/api/whale/rebuild')?.methods?.includes('GET'), '[9] /api/whale/rebuild methods 包含 GET')
    for (const ep of postPaths) {
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
    // §11（2026-09-22）：建圈必须**自动写身份色** —— 没色的圆圈会让闸门第 19 条（circle-bands）红。
    ok(/^#[0-9a-f]{6}$/.test(halo.color || ''), `[1] 新圆圈自动写了身份色（${halo.color}）`)
    ok(body.color === halo.color, `[1] 响应回的就是写进 halo.json 的那个色（${body.color}）`)

    ok(Array.isArray(body.needsRebuild) && body.needsRebuild.length === 5, `[1] needsRebuild 含 5 条（实得 ${body.needsRebuild?.length}）`)
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
    pruneCircles(gatePack)
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
      ok(true, `[8] A. 对照基线：${base.size} 条红（${base.size}/19 失败，排除清单造成的已知缺件）`)

      // ⚠️ **基线闸门里有的检查会往包里写产物**：`tools/shape-pipeline.test.mjs` 走的是
      //    真构建器（`node tools/build-lessons.js`，全量），于是刚剪掉的 `lessons/<圈>/<点>/`
      //    又被重新长出来。动作段必须在**干净前提**下建圈，否则撞"圆圈 math 已存在（目录 …）"——
      //    那是测试自己造出来的状态，不是产品缺陷（2026-09-25 定位：这条一直是本套件的预存在红）。
      pruneCircles(gatePack)

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
        'node tools/circle-bands.js',
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
      // ⚠️ **逐字比**，不用 `includes('build-starmap')` —— 那会把 `build-starmap-svg.js --check`
      //    一起算进来（同族命令名互相污染判据，C3 原来就栽在这上面）。
      const starmapFail = [...after].some((x) => x === 'node tools/build-starmap.js --check')
      ok(!starmapFail, `[8] C2. build-starmap.js --check 在 after 里 ${starmapFail ? '仍红' : 'PASS'}`)

      // C3. build-lessons.js --check 在 after 里是 PASS
      // 原来是 `includes('build-lessons')` —— 把 `build-lessons-extract.test.mjs` 也算进来，
      // 而那条在剪过的包里本来就红（缺 fixture）⇒ **C3 永远不可能绿**（2026-09-25 定位）。
      const lessonsFail = [...after].some((x) => x === 'node tools/build-lessons.js --check')
      ok(!lessonsFail, `[8] C3. build-lessons.js --check 在 after 里 ${lessonsFail ? '仍红' : 'PASS'}`)

      // ── D. 反空转：故意在 after 里加一条假红，断言集合差会捕获 ──
      const afterWithFake = new Set(after)
      afterWithFake.add('node tools/fake-red-check.js（exit 1）')
      const fakeNewRed = [...afterWithFake].filter((x) => !base.has(x))
      ok(fakeNewRed.length === 1 && fakeNewRed[0].includes('fake-red-check'),
        `[8] D. 反空转：故意加一条假红 → 集合差捕获 ${fakeNewRed.length} 条（期望 1 条 fake-red-check）`)

      // ── E. 真包零改动（**相对基线**，不是"必须为空"）──
      const afterGate = gitStatus(PACK)
      ok(afterGate === realBefore, `[8] E. 真包 git status 与跑之前相同（相对基线；基线=${realBefore || '空'}，实得=${afterGate || '空'}）`)

    } finally {
      try { fs.rmSync(gateRoot, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  // ── [10] 色带用尽：吃到尽 → 再建圈 → 拒绝 + 文案含修法（不留静默）──
  // 全程只动 os.tmpdir() 的影副本（tmpPack），一次都不写真包。
  {
    const { ctx, routes } = makeRouteCtx(tmpPack)
    plugin.install(ctx)
    const circleR = routes.find((r) => r.path === '/api/whale/circle')

    // 把色带**吃到尽**：一直建圈，直到第一次被拒（上限 64 防死循环）
    const created = []
    let rejected = null
    for (let i = 0; i < 64; i++) {
      const id = `band${i}`
      const res = await circleR.fetch(fakeRequest('POST', { name: `吃色${i}`, id }))
      const body = await res.json()
      if (!body.ok) { rejected = { id, body }; break }
      const halo = JSON.parse(fs.readFileSync(path.join(tmpPack, 'lessons', id, 'halo.json'), 'utf8'))
      created.push({ id, color: halo.color })
    }

    ok(created.length > 0, `[10] 吃色阶段建了 ${created.length} 个圈（期望 > 0）`)
    ok(created.every((c) => /^#[0-9a-f]{6}$/.test(c.color || '')),
      `[10] 吃到尽为止每个圈都写了身份色（${created.length} 个）——没有"建出一个没 color 的圈"`)
    ok(new Set(created.map((c) => c.color)).size === created.length, '[10] 每个圈的身份色互不重复')
    ok(rejected != null, '[10] 色带吃到尽后，下一个圈被拒绝（不是无限建下去）')

    const err = rejected?.body?.error || ''
    ok(rejected?.body?.ok === false, `[10] 用尽后建 "${rejected?.id}" 被拒绝（ok=false，走现有拒绝面）`)
    ok(/圈色用尽/.test(err), `[10] 文案说清原因（${err.slice(0, 30)}…）`)
    ok(/修法/.test(err), '[10] 文案含"修法"')
    ok(/_title-bands/.test(err) && /freeze\.mjs/.test(err) && /--check/.test(err),
      '[10] 修法可执行：到哪加色（_title-bands）/ 怎么加（freeze.mjs 重新冻结）/ 连带更新哪条对拍（--check）')
    ok(!fs.existsSync(path.join(tmpPack, 'lessons', rejected?.id ?? '~none~')),
      '[10] 被拒的圆圈没有落盘（磁盘上什么都没多出来）')
  }

  // ── [7] 真包零改动（**相对基线**，不是"必须为空"）──
  {
    const afterStatus = gitStatus(PACK)
    ok(afterStatus === realBefore, `[7] 真包 git status 与跑之前相同（相对基线；基线=${realBefore || '空'}，实得=${afterStatus || '空'}）`)
  }

} finally {
  // 清理临时目录
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 写入口：新建圆圈/知识点（原子、拒覆盖、坏 id 拒绝、绝不碰真包）')
