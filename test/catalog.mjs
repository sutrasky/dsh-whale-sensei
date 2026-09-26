#!/usr/bin/env node
/**
 * test/catalog.mjs — 数据面判据
 * ------------------------------------------------------------------
 * 断言：
 *   [1] catalog 的圆圈/知识点/课程数量与真目录一致
 *   [2] id 唯一且可解析
 *   [3] nextNumber(pack,'programming','spring-boot') === 3
 *   [4] 反空转：不存在的知识点 → null
 *   [5] 空空知识点 → nextNumber == fileBase+1
 *   [6] suggestCircle 三种情况
 *   [7] 路由存在且声明了 requestBody
 */

import fs from 'node:fs'
import path from 'node:path'
import { packRoot } from './_pack.mjs'
import { readPack, nextNumber, pointKey, lessonKey } from '../lib/pack-model.js'
import { suggestCircle } from '../lib/circle-seeds.js'

const ROOT = packRoot()
let pass = 0
const fails = []
function ok(c, m) {
  if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) }
}

const pack = readPack(ROOT)

// ── [1] 圆圈/知识点/课程数量与真目录一致 ──
// 不写死"圆圈数 = 1"：用户从设置页新建圆圈（本插件的功能）就会变 2，
// 那不是回归（2026-09-22 实测的假红）。判据改成"id 都合法 + 该有的那几条事实都在"。
ok(pack.circles.length >= 1, `[1] 圆圈数量：${pack.circles.length}（≥1）`)
ok(pack.circles.every((c) => /^[a-z][a-z0-9-]*$/.test(c.id)), `[1] 每个圆圈 id 都合法（${pack.circles.map((c) => c.id).join(', ')}）`)
const programming = pack.circles.find((c) => c.id === 'programming')
ok(programming != null, '[1] 找到 programming 圆圈')
ok(pack.points.filter((p) => p.circle === 'programming').length === 2, `[1] programming 下知识点：${pack.points.filter((p) => p.circle === 'programming').length}（期望 2）`)
const sbLessons = pack.lessons.filter((l) => l.point === 'spring-boot')
ok(sbLessons.length === 3, `[1] spring-boot 课程数：${sbLessons.length}（期望 3 —— 课程包已建到第3课；建课/删课后要同步这里）`)

// ── [2] id 唯一且可解析 ──
{
  const ids = []
  for (const c of pack.circles) {
    ids.push(c.id)
    for (const pt of c.points) {
      ids.push(`${c.id}/${pt.id}`)
      for (const l of pack.lessons.filter((le) => le.circle === c.id && le.point === pt.id)) {
        ids.push(`${c.id}/${l.point}/${String(l.number).padStart(4, '0')}`)
      }
    }
  }
  const unique = new Set(ids).size === ids.length
  ok(unique, `[2] id 唯一（${ids.length} 个 id，${new Set(ids).size} 个唯一）`)

  // 课程 id 去掉 / 后能在磁盘上找到对应文件
  const lessonIds = ids.filter((id) => /^\w+\/[\w-]+\/\d{4}$/.test(id))
  let found = 0
  for (const id of lessonIds) {
    const parts = id.split('/')
    const number = parts[2]
    // 在 src 目录下找 NNNN-*.html
    const srcDir = path.join(ROOT, 'lessons', 'src', ...parts.slice(0, 2))
    if (fs.existsSync(srcDir)) {
      const files = fs.readdirSync(srcDir).filter((f) => f.startsWith(number + '-'))
      if (files.length > 0) found++
    }
  }
  ok(found === lessonIds.length, `[2] 课程 id 可解析（${found}/${lessonIds.length} 在磁盘上找到对应文件）`)
}

// ── [3] nextNumber(pack,'programming','spring-boot') === 3 ──
const nn = nextNumber(pack, 'programming', 'spring-boot')
ok(nn === 4, `[3] nextNumber(programming,spring-boot) = ${nn}（期望 4 —— 同上）`)

// ── [4] 反空转：不存在的知识点 ──
const nnNull = nextNumber(pack, 'programming', '不存在的知识点')
ok(nnNull === null, `[4] nextNumber(不存在的知识点) = ${nnNull}（期望 null）`)

// ── [5] 空知识点（临时构造的 pack 对象）：没课 → fileBase + 1 ──
{
  const fakePack = {
    points: [{ id: 'empty-point', circle: 'fake-circle', fileBase: 100 }],
    lessons: [],
  }
  const emptyNn = nextNumber(fakePack, 'fake-circle', 'empty-point')
  ok(emptyNn === 101, `[5] 空知识点 nextNumber = ${emptyNn}（期望 fileBase+1 = 101）`)
}

// ── [5b] 跨圆圈不许串号：两个圆圈各有同名知识点 vue，号段互不可见 ──
{
  const two = {
    points: [
      { id: 'vue', circle: 'programming', fileBase: 1000 },
      { id: 'vue', circle: 'design', fileBase: 2000 },
    ],
    lessons: [
      { circle: 'programming', point: 'vue', number: 1001 },
      { circle: 'programming', point: 'vue', number: 1002 },
      { circle: 'design', point: 'vue', number: 2001 },
    ],
  }
  const a = nextNumber(two, 'programming', 'vue')
  const b = nextNumber(two, 'design', 'vue')
  ok(a === 1003 && b === 2002, `[5b] 同名知识点跨圆圈不串号：programming=${a}（期望 1003）· design=${b}（期望 2002）`)
}

// ── [6] suggestCircle：命中已有 / 命中未建 / 真没认出（不许猜）──
{
  const existing = pack.circles.map((c) => ({ id: c.id, name: c.name }))
  // isNew 的两条分支都拿**显式传进去的 existing 列表**判，不看真包今天建了哪些圆圈：
  // 真包上有 math 时 '微积分' 的 isNew 自然是 false —— 那是用户用设置页建出来的正常状态，
  // 不是回归（2026-09-22 实测的假红）。这里把同一个词的两条分支都钉住，覆盖反而更全。
  const withoutMath = existing.filter((c) => c.id !== 'math')

  const r1 = suggestCircle('Vue 3 组合式 API', existing)
  ok(r1.id === 'programming' && r1.isNew === false, `[6] 'Vue 3 组合式 API' → id=${r1.id}, isNew=${r1.isNew}`)

  const r2 = suggestCircle('微积分', withoutMath)
  ok(r2.id === 'math' && r2.isNew === true, `[6] '微积分' 在"还没有 math"的列表上 → id=${r2.id}, isNew=${r2.isNew}`)

  const r2b = suggestCircle('微积分', [{ id: 'math', name: '数学' }])
  ok(r2b.id === 'math' && r2b.isNew === false, `[6] '微积分' 在"已有 math"的列表上 → id=${r2b.id}, isNew=${r2b.isNew}（同一个词两条分支都钉住）`)

  // '量子' 在 physics 的 keywords 里 → 命中 physics 是**正确语义**，不是"没认出"
  const r3 = suggestCircle('量子纠缠与猫', [{ id: 'programming', name: '编程' }])
  ok(r3.id === 'physics' && r3.isNew === true, `[6] '量子纠缠与猫' → id=${r3.id}（'量子'命中 physics）`)

  // 真正一个关键词都不命中的 → **必须留空**，不许猜
  const r4 = suggestCircle('怎么养多肉', existing)
  ok(r4.id === '' && r4.isNew === true, `[6] '怎么养多肉' → id='${r4.id}'（没认出 → 留空让你自己填）`)
}

// ── [7] 路由存在且声明了 requestBody ──
{
  const routes = []
  const routeCtx = {
    paths: { packRoot: ROOT, dataDir: ROOT },
    log: () => {},
    registerTool: () => {},
    inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
  }
  const { plugin } = await import('../lib/mods/catalog.js')
  plugin.install(routeCtx)

  ok(routes.length > 0, `[7] catalog 注册了 ${routes.length} 条路由`)
  const catalogRoute = routes.find((r) => r.path === '/api/whale/catalog')
  ok(catalogRoute != null, '[7] /api/whale/catalog 路由存在')
  ok(catalogRoute?.requestBody === 'buffered', `[7] requestBody = ${catalogRoute?.requestBody}（期望 buffered）`)
  ok(catalogRoute?.path?.startsWith('/api/'), `[7] path 在 /api/ 前缀下`)
  ok(Array.isArray(catalogRoute?.methods) && catalogRoute.methods.includes('GET'), '[7] methods 包含 GET')
}

// ── 纯函数验证 ──
ok(pointKey('programming', 'spring-boot') === 'programming/spring-boot', 'pointKey 正确')
ok(lessonKey('programming', 'spring-boot', 1) === 'programming/spring-boot/0001', 'lessonKey 正确')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 数据面：圆圈/知识点/课程的规范 id + 下一课号 + 圆圈建议')
