/**
 * 发布检查器退出码回归：在自有临时目录运行原样 release.mjs。
 * 全部台账和分发返回值均为 SYNTHETIC 控制夹具，不代表真实验收或许可证据。
 * 独立运行：node --test test/audit/release-exit-code.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const source = fileURLToPath(new URL('./release.mjs', import.meta.url))

function runFixture(t, { card = {}, omitCode = false, mode = 'public', checkExit = 0, waived = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-release-exit-'))
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('whale-release-exit-'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const write = (name, text) => {
    const dest = path.join(dir, name)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, text, 'utf8')
  }
  const json = (name, value) => write(name, JSON.stringify(value))
  write('test/audit/release.mjs', fs.readFileSync(source, 'utf8'))
  // 仅模拟依赖的模式和返回值；不触碰主仓台账或真实分发材料。
  write('lib/pack-template/tools/distribution-license.cjs', `exports.modeOf = () => ${JSON.stringify(mode)};`)
  write('tools/check-distribution.mjs', `console.log(JSON.stringify({verified:true})); process.exit(${checkExit});`)
  const row = { id: 'T26', verdict: 'PASS', code: 0, line: 'PASS T26 checks=20 failed=0 skipped=0', ...card }
  if (omitCode) delete row.code
  json('audit-evidence/planner-acceptance-summary.json', { results: [row] })
  json('audit-evidence/findings-map.json', {
    findings: Array.from({ length: 24 }, (_, i) => ({ id: `SYNTHETIC-${i}`, cards: ['T26'] })),
  })
  json('audit-evidence/waivers.json', { waivers: waived ? [{ card: 'T26', state: 'WAIVED', scope: 'SYNTHETIC-' + Array.from({ length: 24 }, (_, i) => i).join(' SYNTHETIC-') }] : [] })
  const child = spawnSync(process.execPath, [path.join(dir, 'test/audit/release.mjs'), '--json'], { encoding: 'utf8', timeout: 10000 })
  assert.ifError(child.error)
  assert.equal(child.signal, null)
  assert.equal(child.stderr, '')
  return { exit: child.status, report: JSON.parse(child.stdout) }
}

test('数字 exit0 + 整卡 PASS 可闭合，避免恒拒绝假修复', (t) => {
  const { exit, report } = runFixture(t)
  assert.equal(exit, 0)
  assert.equal(report.ok, true)
  assert.equal(report.tally.closed, 24)
})

for (const [name, opts] of [
  ['失败 exit1', { card: { code: 1 } }],
  ['非零 exit2', { card: { code: 2 } }],
  ['中断无退出码', { card: { code: null } }],
  ['缺少退出码', { omitCode: true }],
  ['字符串零', { card: { code: '0' } }],
]) {
  test(`自报 PASS + ${name} 必须保持 open 并阻断`, (t) => {
    const { exit, report } = runFixture(t, opts)
    assert.equal(exit, 2)
    assert.equal(report.ok, false)
    assert.equal(report.tally.closed, 0)
    assert.equal(report.tally.open, 24)
    assert.match(report.results[0].why, /退出码/)
  })
}

test('exit0 也不能把自动层当整卡通过', (t) => {
  const { exit, report } = runFixture(t, { card: { line: 'PASS T26-AUTO checks=20 failed=0 skipped=0' } })
  assert.equal(exit, 2)
  assert.equal(report.tally.open, 24)
  assert.match(report.results[0].why, /自动层/)
})

test('默认 BLOCKED exit2 仍记 blocked', (t) => {
  const { exit, report } = runFixture(t, { card: { verdict: 'BLOCKED', code: 2, line: 'BLOCKED T26 missing-real-evidence' } })
  assert.equal(exit, 2)
  assert.equal(report.tally.blocked, 24)
})

test('显式弃权仍记 waived，不记 closed', (t) => {
  const { report } = runFixture(t, { waived: true })
  assert.equal(report.tally.waived, 24)
  assert.equal(report.tally.closed, 0)
})

test('分发子进程 exit1 时 verified:true 不能放行', (t) => {
  const { exit, report } = runFixture(t, { checkExit: 1 })
  assert.equal(exit, 2)
  assert.equal(report.distribution.verified, false)
  assert.equal(report.distribution.check.exit, 1)
})

test('私模式仍阻断并保留弃权引用', (t) => {
  const { exit, report } = runFixture(t, { mode: 'private' })
  assert.equal(exit, 2)
  assert.equal(report.distribution.verified, false)
  assert.equal(report.distribution.waiverFile, 'audit-evidence/waivers.json')
})
