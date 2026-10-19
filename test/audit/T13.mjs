import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createResourceScope } from '../../lib/resource-scope.js'
import { apply } from '../../lib/index.js'
import { selectMods } from '../../lib/mods/index.js'
import { ensurePackServer } from '../../lib/pack-server.js'

const IDS = ['S01','S02','S03','S04','S05','S06','S07','S08','S09','S10','S11','S12','H01','H02','H03','H04','H05','H06','H07','H08','H09','H10','H11','H12','H13','H14','H15','H16','H17','P01','P02','P03','P04','P05','P06','P07','P08']
const records = []
const watchObservations = []
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = path.join(repo, 'audit-evidence/T13')
fs.mkdirSync(evidence, { recursive: true })
const stamp = `${Date.now()}-${process.pid}`
const base = 'E:/Temp'
fs.mkdirSync(base, { recursive: true })
const fixture = fs.mkdtempSync(path.join(base, 'whale-T13-r2-'))
const files = ['lib/index.js','lib/mods/ask.js','lib/mods/pack.js','lib/pack-server.js','lib/resource-scope.js','test/audit/T13.mjs']
const hashes = Object.fromEntries(files.map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(repo,f))).digest('hex')]))
const originalTimers = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
const timers = new Set()
globalThis.setInterval = (...args) => { const t = originalTimers.setInterval(...args); timers.add(t); return t }
globalThis.clearInterval = t => { timers.delete(t); return originalTimers.clearInterval(t) }
const check = async (id, fn) => {
  let timeout
  try {
    await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error(`${id} timed out after 5000ms`)),5000)})])
    records.push({ id, status: 'pass' })
  } catch (e) { records.push({ id, status: 'fail', error: e.stack || String(e) }) }
  finally { clearTimeout(timeout) }
}
const eq = assert.deepEqual
const hosts = []
// The fake models the public effect/Fiber lifecycle found in the installed Cordis.
// Only ask/pack return non-context-owned route disposers: their explicit ownership is tested too.
function host(root) {
  const rootEffects = [], injections = [], tools = new Map(), routes = new Map(), logs = []
  let dead = false
  const effect = list => fn => { const off = fn(); if (typeof off === 'function') list.push(off); return off }
  const h = {
    tools, routes, injections, logs,
    ctx: {
      logger: Object.fromEntries(['info','warn','error'].map(k => [k, m => logs.push([k,m])])),
      tools: { register(def) { tools.set(def.name,def); return () => tools.delete(def.name) } },
      effect: effect(rootEffects),
      inject(names, cb) {
        const i = { names, cb, effects: [], paths: [], revoked: false }
        i.withdraw = () => { const pending = i.effects.splice(0).reverse().map(f => f()); return Promise.all(pending) }
        i.dispose = () => { i.revoked = true; return i.withdraw() }
        i.deliver = (service, { late = false, throwing = false } = {}) => {
          if (i.revoked && !late) throw new Error('revoked injection')
          const context = { effect: effect(i.effects), get() {
            if (throwing) throw new Error('injection callback failed')
            if (names[0] !== 'connection') return service
            return { fetch: { register(r) {
              assert.equal(routes.has(r.path),false, `duplicate ${r.path}`)
              routes.set(r.path,r)
              if (!i.paths.includes(r.path)) i.paths.push(r.path)
              let active = true
              const off = () => { if (active) { active=false; routes.delete(r.path) } }
              if (!['/api/whale/ask','/api/whale/answer'].includes(r.path) && !r.path.startsWith('/api/whale/pack/')) i.effects.push(off)
              return off
            } } }
          } }
          if (names[0] === 'jobs') context.jobs = service
          const result = cb(context)
          if (typeof result === 'function') i.effects.push(result)
          return result
        }
        injections.push(i)
        if (names[0] === 'connection') i.deliver()
        return { dispose: i.dispose }
      },
    },
    async unload() {
      if (dead) return
      dead = true
      await Promise.all(rootEffects.splice(0).reverse().map(f => f()))
    },
    jobs(service) { const i = injections.find(i => i.names[0] === 'jobs'); i.deliver(service); return i },
    watch(owner = 'agent') { return tools.get('whale_ask').execute({action:'watch',root}, {agent:owner}) },
  }
  apply(h.ctx, {packRoot: root, installPreset:false, announceOnBoot:false, dataDir:path.join(fixture,'data')})
  hosts.push(h)
  return h
}
function jobs({ throws = false } = {}) {
  const runs = []
  let calls = 0
  return { runs, get calls() { return calls }, start(spec) {
    calls++
    if (throws) throw new Error('job.start failed')
    const run = spec.run(); runs.push(run)
    return `job-${calls}`
  }, cancel() { calls++; throw new Error('withdrawn service must not be called') } }
}
const listen = server => new Promise((r,j) => {server.once('error',j);server.listen(0,'127.0.0.1',()=>r(server.address().port))})
const health = port => new Promise(resolve => {
  const req = http.get({host:'127.0.0.1',port,path:'/health',agent:false,timeout:600},res=>{res.resume();resolve(res.statusCode===200)})
  req.on('error',()=>resolve(false));req.on('timeout',()=>{req.destroy();resolve(false)})
})
async function pack(tag) {
  const root = path.join(fixture,tag)
  fs.cpSync(path.join(repo,'lib/pack-template'),root,{recursive:true})
  const probe = http.createServer(); const port = await listen(probe); await new Promise(r=>probe.close(r))
  return {root,port}
}
async function onPort(port, fn) {
  const oldArg=process.argv[2], oldPort=process.env.PORT
  process.argv[2]='';process.env.PORT=String(port)
  try { return await fn() } finally {
    if (oldArg === undefined) delete process.argv[2]; else process.argv[2]=oldArg
    if (oldPort === undefined) delete process.env.PORT; else process.env.PORT=oldPort
  }
}
const open = h => h.routes.get('/api/whale/pack/open').fetch(new Request('http://localhost/api/whale/pack/open',{method:'POST'})).then(r=>r.json())
let fatal
let external
try {
  let s, order=[], release, child, count=0
  await check('S01',()=>{ s=createResourceScope();eq([s.disposed,s.size],[false,0]);assert.throws(()=>s.add(null),TypeError) })
  await check('S02',()=>{s.add(()=>order.push(1));s.add(()=>order.push(2));s.dispose();eq(order,[2,1])})
  await check('S03',async()=>{const a=s.dispose();assert.equal(a,s.dispose());eq((await a).errors,[]);eq(s.size,0)})
  await check('S04',async()=>{s=createResourceScope();release=s.add(()=>count++);release();release();await s.dispose();eq(count,1);eq(s.size,0)})
  await check('S05',async()=>{s=createResourceScope();order=[];s.add(()=>order.push(1));s.add(()=>{throw Error('sync')});s.add(()=>order.push(3));eq((await s.dispose()).errors.map(e=>e.message),['sync']);eq(order,[3,1])})
  await check('S06',async()=>{s=createResourceScope();s.add(async()=>{throw Error('async')});eq((await s.dispose()).errors.map(e=>e.message),['async'])})
  await check('S07',async()=>{count=0;s.add(()=>count++);eq(count,1);eq(s.size,0)})
  await check('S08',async()=>{s=createResourceScope();child=s.child();child.add(()=>count++);await child.dispose();eq(s.size,0);eq(child.disposed,true)})
  await check('S09',async()=>{s=createResourceScope();child=s.child();await s.dispose();eq([s.disposed,child.disposed,s.size,child.size],[true,true,0,0])})
  await check('S10',()=>{child=s.child();eq([child.disposed,child.size],[true,0]);let n=0;child.add(()=>n++);eq(n,1)})
  await check('S11',async()=>{s=createResourceScope();child=s.child();child.add(async()=>{throw Error('child')});eq((await s.dispose()).errors.map(e=>e.message),['child'])})
  await check('S12',async()=>{s=createResourceScope();let done;let n=0;release=s.add(()=>{n++;return new Promise(r=>done=r)});release();const p=s.dispose();eq(n,1);done();await p;release();eq(n,1)})
  const empty = path.join(fixture,'queue');fs.mkdirSync(empty)
  let a,b,svc,ji
  await check('H01',()=>{a=host(empty);eq([...a.tools.keys()].sort(),['whale_ping',...selectMods().mods.flatMap(m=>m.tools||[])].sort());assert.ok(a.routes.has('/api/whale/ask'));assert.ok(a.routes.has('/api/whale/pack/open'))})
  await check('H02',async()=>{svc=jobs();ji=a.jobs(svc);assert.equal((await a.watch()).ok,true);eq(timers.size,1)})
  await check('H03',async()=>{const p=ji.withdraw();eq(timers.size,0);eq(await svc.runs[0].done,{status:'killed',detail:'监听被撤销'});await p})
  await check('H04',async()=>{const n=svc.calls;assert.equal((await a.watch()).ok,false);eq(svc.calls,n);eq(timers.size,0)})
  await check('H05',async()=>{const next=jobs();ji.deliver(next);assert.equal((await a.watch()).ok,true);eq([svc.calls,next.calls,timers.size],[1,1,1]);const replacement=jobs();ji.deliver(replacement);eq(timers.size,0);eq((await next.runs[0].done).status,'killed');assert.equal((await a.watch()).ok,true);eq([next.calls,replacement.calls,timers.size],[1,1,1]);svc=replacement})
  await check('H06',async()=>{b=host(empty);b.jobs(jobs());assert.equal((await b.watch()).ok,true);eq(timers.size,2)})
  await check('H07',async()=>{await a.unload();eq([a.tools.size,a.routes.size,timers.size],[0,0,1]);eq((await svc.runs[0].done).status,'killed');assert.ok(b.tools.size>0);assert.ok(b.routes.size>0)})
  await check('H08',async()=>{await b.unload();eq([b.tools.size,b.routes.size,timers.size],[0,0,0])})
  await check('H09',async()=>{await a.unload();await b.unload();eq(timers.size,0)})
  await check('H10',async()=>{const n=svc.calls;ji.deliver(svc,{late:true});eq(a.tools.size,0);eq(a.routes.size,0);eq(svc.calls,n)})
  await check('H11',async()=>{a=host(empty);const i=a.jobs(jobs({throws:true}));await assert.rejects(a.watch(),/job.start failed/);eq(timers.size,0);await i.withdraw();await a.unload()})
  await check('H12',async()=>{a=host(empty);svc=jobs();a.jobs(svc);await a.watch();await a.unload();eq([a.tools.size,a.routes.size,timers.size],[0,0,0]);eq((await svc.runs[0].done).status,'killed')})
  await check('H13',async()=>{a=host(empty);const i=a.injections.find(i=>i.paths.includes('/api/whale/ask'));await i.withdraw();eq(a.routes.has('/api/whale/ask'),false);eq(a.routes.has('/api/whale/answer'),false);i.deliver();assert.ok(a.routes.has('/api/whale/ask'));await a.unload()})
  await check('H14',async()=>{a=host(empty);for(const i of a.injections.filter(i=>i.names[0]==='connection')) await i.withdraw();eq(a.routes.size,0);for(const i of a.injections.filter(i=>i.names[0]==='connection')) i.deliver();assert.ok(a.routes.has('/api/whale/pack/open'));await a.unload();eq(a.routes.size,0)})
  await check('H15',async()=>{a=host(empty);const i=a.injections.find(i=>i.names[0]==='connection');await i.withdraw();assert.throws(()=>i.deliver(null,{throwing:true}),/injection callback failed/);await a.unload();eq(a.routes.size,0)})
  await check('H16',()=>{for(const h of hosts){eq(h.tools.size,0);eq(h.routes.size,0);assert.ok(h.injections.every(i=>i.revoked))}eq(timers.size,0)})
  await check('H17',async()=>{
    const root=path.join(fixture,'h17-queue')
    fs.mkdirSync(path.join(root,'questions'),{recursive:true})
    fs.writeFileSync(path.join(root,'questions/pending.jsonl'),JSON.stringify({id:'0041',question:'已有问题'})+'\n','utf8')
    const h=host(root), first=jobs(), second=jobs()
    const injection=h.jobs(first)
    const tool=h.tools.get('whale_ask')
    const execute=action=>tool.execute({action,root,intervalMs:250},{agent:'h17-agent'})
    const observe=async(stage,run,status,services,expectedCalls)=>{
      const outcome=await run.done
      const observation={stage,outcome,timers:timers.size,calls:services.map(s=>s.calls)}
      watchObservations.push(observation)
      assert.ok(['completed','killed','failed'].includes(outcome.status),'native terminal outcome')
      eq(outcome.status,status)
      if(status==='killed') eq(outcome.detail,'监听被撤销')
      eq(observation.timers,0)
      eq(observation.calls,expectedCalls)
      return outcome
    }
    assert.equal((await execute('watch')).ok,true);eq(timers.size,1);eq(first.calls,1)
    assert.equal((await execute('unwatch')).ok,true)
    await observe('unwatch',first.runs[0],'killed',[first],[1])
    assert.equal((await execute('watch')).ok,true);eq(timers.size,1);eq(first.calls,2)
    const withdrawn=injection.withdraw()
    eq(timers.size,0)
    await observe('jobs-withdraw',first.runs[1],'killed',[first],[2])
    await withdrawn
    assert.equal((await execute('watch')).ok,false);eq(first.calls,2);eq(timers.size,0)
    injection.deliver(second)
    assert.equal((await execute('watch')).ok,true);eq(timers.size,1);eq([first.calls,second.calls],[2,1])
    const question='H17真实timer新问题摘要'
    fs.appendFileSync(path.join(root,'questions/pending.jsonl'),JSON.stringify({id:'0042',lesson:'H17',question})+'\n','utf8')
    const fresh=await observe('new-question',second.runs[0],'completed',[first,second],[2,1])
    assert.ok(fresh.detail.includes('收到 1 条新提问：'))
    assert.ok(fresh.detail.includes(`#0042 H17 · ${question}`))
    assert.equal((await execute('watch')).ok,true);eq(timers.size,1);eq([first.calls,second.calls],[2,2])
    await h.unload()
    await observe('plugin-unload',second.runs[1],'killed',[first,second],[2,2])
    eq([h.tools.size,h.routes.size],[0,0])
  })
  let p1,p2,h1,h2,socket,owner,other
  await check('P01',async()=>{p1=await pack('preview1');h1=host(p1.root);const out=await onPort(p1.port,()=>open(h1));assert.equal(out.ok,true);assert.equal(out.started,true);assert.equal(await health(p1.port),true)})
  await check('P02',async()=>{socket=net.connect(p1.port,'127.0.0.1');socket.on('error',()=>{});await new Promise(r=>socket.once('connect',r));socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');await h1.unload();assert.equal(await health(p1.port),false);assert.equal(socket.destroyed||socket.readableEnded,true)})
  await check('P03',async()=>{p2=await pack('preview2');h2=host(p2.root);const out=await onPort(p2.port,()=>open(h2));assert.equal(out.started,true);assert.equal(await health(p2.port),true);await h2.unload();assert.equal(await health(p2.port),false)})
  await check('P04',async()=>{const p=await pack('owner');owner=createResourceScope();other=createResourceScope();await onPort(p.port,async()=>{eq((await ensurePackServer(p.root,{scope:owner})).started,true);eq((await ensurePackServer(p.root,{scope:other})).started,false)});await other.dispose();eq(await health(p.port),true);await owner.dispose();eq(await health(p.port),false)})
  // ⚠️ T15-A1（规划者授权的**跨卡夹具前提升级**，断言一字未动）：这里的「外部服务」原本是
  //    一个**无身份**的 200 桩。T15 的新契约是「复用只允许 同包 + 同协议 + 同引擎 + 有合法会话接续」，
  //    无身份桩按新契约**必须**被拒（reason:'port-conflict'）⇒ 旧夹具会让 P05 红。
  //    所以夹具前提换成**真正同包的健康服务**：用这个夹具包**自己的** tools/app-server.js 在
  //    测试进程里起（端口经 process.env.PORT 在 require 前设定，沿用本文件既有的 onPort 手法）。
  //    P05 的两条判据（复用 started===false / 插件卸载后外部服务仍存活）**原样保留**。
  await check('P05',async()=>{const p=await pack('external');await onPort(p.port,async()=>{const mod=createRequire(import.meta.url)(path.join(p.root,'tools','app-server.js'));external=http.createServer(mod.handler);await new Promise((r,j)=>{external.once('error',j);external.listen(p.port,'127.0.0.1',r)})});const h=host(p.root);const out=await onPort(p.port,()=>open(h));eq(out.started,false);await h.unload();eq(await health(p.port),true);await new Promise(r=>external.close(r));external=null})
  await check('P06',async()=>{const p=await pack('late');const s=createResourceScope();await s.dispose();eq((await onPort(p.port,()=>ensurePackServer(p.root,{scope:s}))).ok,false);eq(await health(p.port),false)})
  await check('P07',async()=>{const p=await pack('inflight');const h=host(p.root);await onPort(p.port,async()=>{const opening=open(h);await h.unload();eq((await opening).ok,false)});eq(await health(p.port),false)})
  await check('P08',()=>{eq(timers.size,0);for(const h of hosts){eq(h.tools.size,0);eq(h.routes.size,0)}})
} catch(e) { fatal=e.stack||String(e) }
finally {
  for (const h of hosts) { try {await h.unload()} catch(e) {fatal ??=e.stack} }
  if(external) await new Promise(r=>external.close(r))
  // Leaked product intervals are recorded as failures, never counted as passes.
  const leakedTimers=timers.size
  for(const t of timers) originalTimers.clearInterval(t)
  globalThis.setInterval=originalTimers.setInterval;globalThis.clearInterval=originalTimers.clearInterval
  if(leakedTimers) fatal ??=`leaked timers: ${leakedTimers}`
}
if(JSON.stringify(records.map(r=>r.id))!==JSON.stringify(IDS)) fatal ??='fixed case ID set mismatch'
const failed=records.filter(r=>r.status==='fail').length+(fatal?1:0)
const automated=process.argv.includes('--automated-only')
// B10-R1：自动层判词**不许**用 PASS 词（它不是整卡通过）——用 `AUTO-ONLY`，并让卡号只出现在 label 里。
const verdict=failed?'FAIL':automated?'AUTO-ONLY':'BLOCKED'
const label=automated?'T13-AUTO':'T13'
const exitCode=failed?1:automated?0:2
const result={verdict,label,exitCode,hashes,ids:IDS,records,watchObservations,fatal,fixture,realHost:{status:'unverified',reason:'No authenticated two-round isolated DSH lifecycle evidence; installed Cordis source inspection is not host execution.'}}
const out=path.join(evidence,`run-r2-${stamp}.json`)
fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n','utf8')
// Keep fixture on failure for diagnosis. Delete only our verified absolute fixture.
if(!failed){const abs=path.resolve(fixture);if(path.dirname(abs)!==path.resolve(base)||!path.basename(abs).startsWith('whale-T13-r2-'))throw Error('unsafe fixture cleanup');fs.rmSync(abs,{recursive:true,force:true})}
console.log(`${verdict} ${label} checks=${records.length} failed=${failed} skipped=0${!failed&&!automated?' real-host-unverified':''}`)
process.exit(exitCode)
