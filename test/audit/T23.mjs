/** T23-R1: fixed 18-case regression matrix. R1 PASS is local only; R2 owns the final blocked verdict. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createHarness, REPO } from './harness.mjs'
import { discoverSuites } from '../_suite-manifest.mjs'
import { validateRunResult } from '../_result.mjs'

const REVISION = '75152ca36d838cc0d7e8a926683d0df4ab24c383'
const IDS = ['K01','C01','C02','G01','G02','G03','G04','G05','G06','B01','S01','S02','S03','P01','N01','N02','N03','N04']
const R2_IDS = ['D01','D02','D03','D04','D05','D06','M01','M02','M03','M04','M05','W01','R01','R02','R03','R04']
const AUTO = process.argv.includes('--auto')
const h = createHarness({ card: AUTO ? 'T23-AUTO' : 'T23', evidenceDir: path.join(REPO,'audit-evidence/T23'), expectedIds: [...IDS,...R2_IDS] })
const PACK = 'E:/workplace/study'
const SUITES = ['render-parity','circle-create','brief','teaching-view','visual','practice']
const sources = [...SUITES.map(s => `test/${s}.mjs`), 'test/audit/T23.mjs','test/run-all.mjs','test/_suite-manifest.mjs','test/wording.mjs','test/parity-registry.mjs','test/settings-layout.mjs','test/audit/T01.mjs']
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const initial = Object.fromEntries(sources.map(p => [p, sha(path.join(REPO,p))]))
const session = path.resolve(fs.mkdtempSync('E:/Temp/whale-T23-R1-'))
const sandboxRepo = path.join(session, 'repo')
const sandboxPack = path.join(session, 'pack')
const baselineRepo = path.join(session, 'baseline')
const runs = []
let baselineAvailable = false
function run(label, repo, suite, pack = sandboxPack) {
  const result = path.join(session, `${label}.json`)
  const r = spawnSync(process.execPath, [path.join(repo,'test',`${suite}.mjs`), `--pack=${pack}`, '--mode=real'], {
    cwd: repo, encoding:'utf8', timeout:600000, maxBuffer:64*1024*1024,
    env:{...process.env, DSH_WHALE_PACK:pack, DSH_WHALE_MODE:'real', WHALE_VISUAL_BASE:'', DSH_WHALE_RESULT:result, TEMP:session, TMP:session},
  })
  let machine = null
  if (fs.existsSync(result)) { try { machine = JSON.parse(fs.readFileSync(result,'utf8')) } catch {} }
  const out = {label, repo, pack, code:r.status, error:r.error?.message || null, signal:r.signal, stdout:r.stdout || '', stderr:r.stderr || '', machine}
  runs.push(out)
  h.evidenceJson(`R1/runs/${label}.json`,out)
  h.evidence(`R1/runs/${label}.stdout.log`,out.stdout)
  h.evidence(`R1/runs/${label}.stderr.log`,out.stderr)
  h.assert(!r.error && r.status !== null, `${label}: child failed or timed out`)
  return out
}
function uniqueReplace(text, anchor, replacement) {
  h.assert(text.split(anchor).length === 2, `mutation anchor must be unique: ${anchor}`)
  return text.replace(anchor,replacement)
}
function mutate(file, transform, body) {
  const original = fs.readFileSync(file)
  try { fs.writeFileSync(file,transform(original.toString('utf8')),'utf8'); return body() }
  finally { fs.writeFileSync(file,original); h.assert(fs.readFileSync(file).equals(original),'mutation restoration failed') }
}
function valid(r) {
  const v=validateRunResult(r.machine)
  h.assert(v.ok,`${r.label}: ${v.errors.join('; ')}`)
  h.eq(r.code,r.machine.failed ? 1 : 0,`${r.label}: exit/result mismatch`)
  const summaries=[...r.stdout.matchAll(/^=== (\d+) 通过 \/ (\d+) 失败 ===$/gm)]
  h.eq(summaries.length,1,'unique summary')
  h.eq(+summaries[0][1],r.machine.passed,'passed reconciliation')
  h.eq(+summaries[0][2],r.machine.failed,'failed reconciliation')
  h.eq(r.machine.skipped,r.machine.cases.filter(c=>c.status==='skip').length,'exact skipped reconciliation')
  return r.machine
}
const baselineFiles = {}
h.case('K01','pass',()=>{
  const r=spawnSync('git',['cat-file','-e',`${REVISION}^{commit}`],{cwd:REPO,encoding:'utf8'})
  h.assert(!r.error && r.status===0,'fixed revision unavailable')
  for(const suite of SUITES) {
    const p=`test/${suite}.mjs`
    const old=spawnSync('git',['show',`${REVISION}:${p}`],{cwd:REPO,encoding:'utf8',maxBuffer:8*1024*1024})
    h.assert(!old.error && old.status===0,`missing fixed source ${p}`)
    baselineFiles[p]=old.stdout
  }
  baselineAvailable=true
})
if(!baselineAvailable) h.block(`fixed negative-control revision unavailable: ${REVISION}`)
let honestBrowserSkips = false
let normalRender, normalCircle, normalBrief, single, visual, practice, baselineRender, baselineSingle
try {
  const omit=new Set(['.git','audit-evidence','node_modules'])
  fs.cpSync(REPO,sandboxRepo,{recursive:true,filter:p=>!omit.has(path.relative(REPO,p).split(path.sep)[0])})
  h.assert(fs.existsSync(path.join(sandboxRepo,'test/audit/T23.mjs')),'untracked entry missing in copy')
  fs.cpSync(PACK,sandboxPack,{recursive:true,filter:p=>!new Set(['.git','node_modules','_chrome-profile']).has(path.relative(PACK,p).split(path.sep)[0])})
  fs.cpSync(sandboxRepo,baselineRepo,{recursive:true})
  for(const [p,text] of Object.entries(baselineFiles)) fs.writeFileSync(path.join(baselineRepo,p),text,'utf8')
  h.case('C01','pass',()=>{normalRender=run('C01-render-normal',sandboxRepo,'render-parity');h.eq(valid(normalRender).failed,0,'normal renderer')})
  const rendererTool=path.join(sandboxPack,'tools/build-lessons.js')
  const exit3 = text => text + "\nif (!process.argv.includes('--check') && fs.readdirSync(path.join(__dirname, '..', 'lessons', 'src'), { recursive: true }).some(p => p.endsWith('.html') && fs.readFileSync(path.join(__dirname, '..', 'lessons', 'src', p), 'utf8').includes('<!--M2-PARITY-MARK-->'))) { console.error('T23_CORRECT_OUTPUT_EXIT3'); process.exit(3) }\n"
  h.case('C02','pass',()=>mutate(rendererTool,exit3,()=>{
    const r=run('C02-correct-output-exit3',sandboxRepo,'render-parity');const m=valid(r)
    h.assert(r.code===1 && m.cases.some(c=>c.status==='fail' && c.note==='CLI 在影子副本里重渲染成功'),'correct output plus exit3 must be red')
    h.assert(m.cases.some(c=>c.status==='pass' && /^新输入下逐字节相同/.test(c.note)),'tool must really write correct output before exit3')
  }))
  h.case('G01','pass',()=>{normalCircle=run('G01-circle-normal',sandboxRepo,'circle-create');const m=valid(normalCircle);h.eq(m.failed,0,'normal circle');for(const n of ['C2. build-starmap.js --check','C3. build-lessons.js --check'])h.assert(m.cases.some(c=>c.status==='pass' && c.note.includes(n)),'target absent '+n)})
  const gate=path.join(sandboxPack,'tools/gate.mjs')
  for(const [id, transform, note] of [
    ['G02',()=> 'this is invalid syntax !!!\n','syntax'],
    ['G03',()=> 'process.exit(0)\n','empty stdout'],
    ['G04',text=>uniqueReplace(text,"  'node tools/build-starmap.js --check',",''),'C2.'],
    ['G05',text=>uniqueReplace(text,"  'node tools/build-lessons.js --check',",''),'C3.'],
  ]) h.case(id,'pass',()=>mutate(gate,transform,()=>{
    const r=run(`${id}-circle-mutant`,sandboxRepo,'circle-create');const m=valid(r)
    h.assert(r.code===1 && m.failed>0,`${id}: real circle suite accepted ${note}`)
    h.assert(m.cases.some(c=>c.status==='fail' && (id==='G02'||id==='G03'?c.note.includes('[8] A.'):c.note.includes(note))),`${id}: required assertion not hit`)
  }))
  h.case('G06','pass',()=>{
    h.assert(normalCircle,'normal circle did not run')
    h.assert(normalCircle.machine.cases.some(c=>c.status==='pass' && c.note.includes('[8] D. 真实工具源码变异被真实 gate 检出')),'real product mutation did not run')
    const r=run('G06-restored-circle',sandboxRepo,'circle-create');h.eq(valid(r).failed,0,'gate restored green')
  })
  h.case('B01','pass',()=>{
    const target=path.join(sandboxPack,'learning-records/brief.md');fs.mkdirSync(path.dirname(target),{recursive:true})
    const original=fs.existsSync(target)?fs.readFileSync(target):null
    try{fs.writeFileSync(target,'T23 existing user brief\r\n逐字节保留\n');const before=sha(target);normalBrief=run('B01-brief-existing',sandboxRepo,'brief');const m=valid(normalBrief);h.eq(sha(target),before,'existing brief preserved');h.assert(m.cases.some(c=>c.status==='pass'&&c.note==='真包 brief.md 存在性与字节哈希保持不变'),'brief snapshot assertion not executed')}
    finally{if(original)fs.writeFileSync(target,original);else fs.rmSync(target,{force:true})}
  })
  const singlePack=path.join(session,'single-pack')
  fs.cpSync(sandboxPack,singlePack,{recursive:true})
  const halos=fs.readdirSync(path.join(singlePack,'lessons')).filter(n=>fs.existsSync(path.join(singlePack,'lessons',n,'halo.json')))
  h.assert(halos.length>0,'no circle in input')
  for(const n of halos.slice(1))fs.rmSync(path.join(singlePack,'lessons',n,'halo.json'))
  h.case('S01','pass',()=>{single=run('S01-single-circle',sandboxRepo,'teaching-view',singlePack);const m=valid(single);h.eq(m.failed,0,'single circle');h.eq(m.skipped,2,'two real skips');h.eq(m.passed,68,'single circle never pass++ for absent branches')})
  h.case('S02','pass',()=>{visual=run('S02-visual',sandboxRepo,'visual');const m=valid(visual);h.eq(m.failed,0,'visual pure layer');h.eq(m.skipped,1,'unexecuted visual browser skip');h.eq(m.passed,30,'visual no browser pass inflation');h.eq(m.base,null,'no guessed base')})
  h.case('S03','pass',()=>{practice=run('S03-practice',sandboxRepo,'practice');const m=valid(practice);h.eq(m.skipped,1,'unexecuted practice browser skip');h.eq(m.passed+m.failed,26,'practice no browser pass inflation');h.eq(m.base,null,'no guessed base')})
  h.case('P01','pass',()=>{
    const teaching=run('P01-teaching-normal',sandboxRepo,'teaching-view')
    for(const r of [normalRender,normalCircle,normalBrief,teaching,visual,practice]){h.assert(r,'suite not run');valid(r)}
    h.eq(normalBrief.machine.failed,12,'existing brief reds preserved');h.eq(practice.machine.failed,3,'existing practice reds preserved')
  })
  h.case('N01','pass',()=>{h.assert(baselineAvailable,'fixed baseline unavailable');mutate(rendererTool,exit3,()=>{baselineRender=run('N01-fixed-baseline-exit3',baselineRepo,'render-parity');h.eq(baselineRender.code,0,'fixed old CLI false green');h.assert(baselineRender.stdout.includes('ok   CLI 在影子副本里重渲染成功'),'old CLI false pass not reproduced');h.assert(baselineRender.stdout.includes('新输入下逐字节相同'),'real correct output not observed')})})
  h.case('N02','pass',()=>{h.assert(baselineAvailable,'fixed baseline unavailable');baselineSingle=run('N02-fixed-baseline-single',baselineRepo,'teaching-view',singlePack);h.eq(baselineSingle.code,0,'fixed baseline single');h.assert(baselineSingle.stdout.includes('=== 70 通过 / 0 失败 ==='),'old 70 false pass count not reproduced');h.eq(single.machine.passed,68,'new count excludes the two absent branches')})

  // R2 uses the same owned product copy; no full all.mjs run is performed here.
  function r2run(label, script, only = '', repo = sandboxRepo, extraEnv = {}) {
    const resultPath = path.join(session, label + '.result.json')
    fs.rmSync(resultPath,{force:true})
    const r = spawnSync(process.execPath,[path.join(repo,'test',script + '.mjs'),`--pack=${sandboxPack}`,'--mode=real'],{
      cwd:repo,encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024,
      env:{...process.env,DSH_WHALE_PACK:sandboxPack,DSH_WHALE_MODE:'real',DSH_WHALE_SUITES:only,DSH_WHALE_RESULT:resultPath,WHALE_VISUAL_BASE:'',TEMP:session,TMP:session,...extraEnv},
    })
    let machine = null
    if(fs.existsSync(resultPath)) machine=JSON.parse(fs.readFileSync(resultPath,'utf8'))
    const record={label,script,only,repo,code:r.status,error:r.error?.message??null,stdout:r.stdout??'',stderr:r.stderr??'',machine}
    h.evidenceJson(`R2/runs/${label}.json`,record)
    h.evidence(`R2/runs/${label}.stdout.log`,record.stdout)
    h.evidence(`R2/runs/${label}.stderr.log`,record.stderr)
    // Archive the complete child machine files before deleting the owned fixture.
    for(const e of fs.readdirSync(session,{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name.startsWith(path.basename(resultPath)+'.children-'))) {
      for(const f of fs.readdirSync(path.join(session,e.name))) h.evidence(`R2/children/${label}/${f}`,fs.readFileSync(path.join(session,e.name,f),'utf8'),{bom:false})
    }
    h.assert(!r.error&&r.status!==null,`${label}: process error/timeout`)
    return record
  }
  const testDir=path.join(sandboxRepo,'test')
  h.case('D01','pass',()=>{const found=discoverSuites(testDir);h.eq(found.length,51,'default suite count');h.assert(found.includes('settings-layout'),'settings absent');h.eq(found.join(','),[...found].sort().join(','),'ASCII stable order')})
  h.case('D02','pass',()=>{
    const found=discoverSuites(testDir)
    for(const id of ['all','run-all','ci','integration','pack-template-rules','_pack','audit/T23'])h.assert(!found.includes(id),'helper/entrypoint discovered '+id)
    h.assert(!discoverSuites(testDir,{helpers:['settings-layout.mjs'],integrationOnly:['visual']}).includes('settings-layout'),'helper exclusion normalization')
    h.assert(!discoverSuites(testDir,{integrationOnly:['visual.mjs']}).includes('visual'),'integration exclusion normalization')
    for(const fn of [()=>discoverSuites(path.join(session,'absent')),()=>discoverSuites(testDir,{helpers:['../visual']})]){let threw=false;try{fn()}catch{threw=true}h.assert(threw,'invalid discovery input silently accepted')}
  })
  const added=path.join(testDir,'t23-added.mjs')
  h.case('D03','pass',()=>{
    try {
      fs.writeFileSync(added,"import {packRoot} from './_pack.mjs'; packRoot(); console.log('T23_ADDED_REAL_EXECUTION'); console.log('=== 1 通过 / 0 失败 ===')\n",'utf8')
      h.assert(discoverSuites(testDir).includes('t23-added'),'new suite not discovered')
      const r=r2run('D03-added','run-all','t23-added');h.eq(r.code,0,'new discovered suite must execute');h.assert(r.machine.cases.some(c=>c.id==='t23-added'&&c.status==='pass'),'new suite missing from real execution')
    }finally{fs.rmSync(added,{force:true})}
  })
  h.case('D04','pass',()=>{const r=r2run('D04-unknown','run-all','t23-never-existed');h.eq(r.code,1,'unknown filter exit');h.assert((r.stdout+r.stderr).includes('t23-never-existed'),'unknown suite not named')})
  h.case('D05','pass',()=>{
    const good=r2run('D05-layout-before','run-all','settings-layout,wording');h.eq(good.code,0,'original layout green')
    const client=path.join(sandboxRepo,'lib/client.js')
    mutate(client,text=>uniqueReplace(text,"'审计': 'health',","'T23_REMOVED_AUDIT': 'health',"),()=>{
      // Pinned old runner ignores the unregistered layout suite, even with the real product broken.
      const pinned=spawnSync('git',['show',`${REVISION}:test/run-all.mjs`],{cwd:REPO,encoding:'utf8',maxBuffer:8*1024*1024})
      h.assert(pinned.status===0&&!pinned.error,'fixed old run-all unavailable')
      mutate(path.join(testDir,'run-all.mjs'),()=>pinned.stdout,()=>{const old=r2run('D05-pinned-old-ignores-layout','run-all','settings-layout,wording');h.eq(old.code,0,'fixed old discovery hole');h.assert(!old.machine.cases.some(c=>c.id==='settings-layout'),'baseline unexpectedly ran settings-layout')})
      const bad=r2run('D05-real-layout-mutant','run-all','settings-layout,wording');h.eq(bad.code,1,'real unified layout mutation must fail');h.assert(bad.machine.cases.some(c=>c.id==='settings-layout'&&c.status==='fail'),'layout assertion not hit');h.assert(bad.stdout.includes('SECTION_HOME 覆盖'),'target layout failure not observed');h.assert(!/SyntaxError/.test(bad.stdout+bad.stderr),'unrelated syntax failure')
    })
    h.eq(r2run('D05-layout-restored','run-all','settings-layout,wording').code,0,'layout restoration green')
  })
  h.case('D06','pass',()=>{
    const registry=path.join(sandboxPack,'_plugin-prep/同源实现-对拍登记表.md')
    mutate(registry,text=>text+"\n| 包:tools/build-lessons.js | 插件:lib/render.js | 插件:test/settings-layout.mjs |\n",()=>{
      const r=r2run('D06-real-discovery-registry','parity-registry')
      h.eq(r.machine.failed,1,'only existing registry selftest red remains')
      h.assert(!r.stdout.includes('settings-layout.mjs 不在'),'registry rejected discovered layout')
    })
    h.assert(fs.readFileSync(path.join(testDir,'parity-registry.mjs'),'utf8').includes('discoverSuites('),'registry does not share discovery')
  })
  h.case('M01','pass',()=>{
    const r=r2run('M01-real-partial-visual','run-all','visual');h.eq(r.code,0,'real partial visual must be valid')
    const v=validateRunResult(r.machine);h.assert(v.ok,v.errors.join('; '));h.eq(r.machine.skipped,1,'one browser skip');h.eq(r.machine.passed,1,'only executed actual work aggregate passes');h.assert(r.machine.cases.some(c=>c.id==='visual'&&c.status==='skip'&&c.note),'suite records browser skip');h.assert(r.machine.cases.some(c=>c.id==='executed:visual'&&c.status==='pass'&&c.note.includes('30 actual passed')),'executed 30 assertions missing')
  })
  const visualSource=path.join(testDir,'visual.mjs')
  const writer="if (process.env.DSH_WHALE_RESULT) fs.writeFileSync(process.env.DSH_WHALE_RESULT, JSON.stringify(result, null, 2), 'utf8')"
  function machineMutant(label, replacement) {
    return mutate(visualSource,text=>uniqueReplace(text,writer,replacement),()=>{
      const r=r2run(label,'run-all','visual');h.eq(r.code,1,'bad child record must fail');h.assert(r.machine.cases.some(c=>c.id==='visual'&&c.status==='fail'),'bad machine not red');h.assert(!/SyntaxError/.test(r.stdout+r.stderr),'unrelated syntax failure');return r
    })
  }
  h.case('M02','pass',()=>{for(const [label,replacement]of [['M02-corrupt',"if(process.env.DSH_WHALE_RESULT)fs.writeFileSync(process.env.DSH_WHALE_RESULT,'{broken','utf8')"],['M02-missing','/* intentionally suppress required machine result */']]){const r=machineMutant(label,replacement);h.assert(/invalid child machine|required child machine missing/.test(r.stdout),'machine validation reason absent')}})
  h.case('M03','pass',()=>mutate(visualSource,text=>text+"\nprocess.exit(3)\n",()=>{const r=r2run('M03-valid-machine-exit3','run-all','visual');h.eq(r.code,1,'exit3 with valid machine must fail');h.assert(r.machine.cases.some(c=>c.id==='exit:visual'&&c.exitCode===3),'real child exit3 missing')}))
  h.case('M04','pass',()=>{const r=machineMutant('M04-missing-case',"if(process.env.DSH_WHALE_RESULT){result.cases.pop();fs.writeFileSync(process.env.DSH_WHALE_RESULT,JSON.stringify(result),'utf8')}");h.assert(/skip count differs|skip|cases/.test(r.stdout),'removed case discrepancy not caught')})
  h.case('M05','pass',()=>{const r=machineMutant('M05-wrong-context',"if(process.env.DSH_WHALE_RESULT){result.packRoot=ROOT+'-wrong';fs.writeFileSync(process.env.DSH_WHALE_RESULT,JSON.stringify(result),'utf8')}");h.assert(r.stdout.includes('machine packRoot differs'),'wrong explicit context reason absent')})
  h.case('W01','pass',()=>{
    const r=r2run('W01-wording-real-mutants','wording');h.eq(r.code,0,'wording normal real mutants');h.eq(r.machine.passed,21,'original wording21 preserved')
    const evidence=path.join(sandboxRepo,'audit-evidence/T23/wording-runtime')
    const files=fs.readdirSync(evidence);h.eq(files.length,5,'five real receipt mutants')
    for(const file of files){const m=JSON.parse(fs.readFileSync(path.join(evidence,file),'utf8'));h.eq(m.code,1,'real source mutant red');h.assert(m.restored&&m.result.cases.some(c=>c.status==='fail'&&c.note.startsWith(m.label+' 含 ')),'mutant target/restoration absent');h.evidenceJson('R2/wording/'+file,m)}
    const starter=path.join(sandboxRepo,'lib/starter.js');mutate(starter,text=>uniqueReplace(text,'① 查资料：','① T23_REMOVED：'),()=>{const bad=r2run('W01-starter-mutant','wording');h.eq(bad.code,1,'real starter mutation');h.assert(bad.machine.cases.some(c=>c.status==='fail'&&c.note==='协议里有这一段：① 查资料'),'actual starter assertion not hit')})
    h.eq(r2run('W01-wording-restored','wording').code,0,'wording restoration')
  })
  // ── R01/R02「原入口不退化」用例的**运行条件**（T23-R3 修正；判据/期望/ID 逐字不动）───────
  // 规划者 2026-10-19 裁定：这两项必须在**主仓 `REPO`** 上、以**干净环境**跑原入口，即与
  // `audit-evidence/planner-tools/acceptance.mjs` 跑 T01/T02 的条件逐字一致
  // （`spawnSync(process.execPath, [script], { cwd: R, encoding, timeout, maxBuffer })`，不传 env、不传 argv）。
  // 两条理由（别让后人再踩）：
  //   ① **沙箱副本没有 `.git`**：R1 的 `sandboxRepo` 是 `fs.cpSync(REPO, …, filter 排除 .git)` 造出来的
  //      （见上面 `omit` 集合），而 `test/audit/T01.mjs:432` 取基线必须
  //      `git show ba22c948…:test/all.mjs`（cwd=REPO）—— 副本里 REPO 解析到副本自身 ⇒
  //      `fatal: not a git repository` ⇒ `BLOCKED T01 取不到基线` exit2；T02 的
  //      `T02-REG-t01-still-passes`（`test/audit/T02.mjs:635`，cwd: REPO=沙箱）再跑一次 T01，同样拿到 exit2。
  //      副本**按设计**排除 `.git` ⇒ 沙箱本来就不是这两个原入口的合法运行环境。
  //   ② **env 泄漏**：给子进程注入 `DSH_WHALE_MODE='real'` / `DSH_WHALE_PACK` 的话，会经
  //      `test/audit/harness.mjs:57` 的 `env:{...process.env, ...(opts.env??{})}` 穿透进 T02 自己那个
  //      “无 study 沙箱”的内层 `all.mjs`（`T02.mjs:453-474`），打掉 `T02.mjs:474` 断言的 `/mode=fixture/`
  //      （note 逐字：「沙箱里走的是夹具模式（自包含，不依赖活包）」）。那是 T02 的**原判据**，
  //      不许为了跑器方便去动它。
  // 因此：`cwd = REPO`，**不注入** `DSH_WHALE_MODE` / `DSH_WHALE_PACK` / `DSH_WHALE_SUITES` /
  // `DSH_WHALE_RESULT`（`TEMP`/`TMP` 亦不必），也不带 `--pack=` / `--mode=` 参数（原入口自己解析）。
  // 证据名与字段保持 `R2/runs/R01-original-T01.*` / `R02-original-T02.*`（label/script/only/repo/code/
  // error/stdout/stderr/machine 同形；干净环境不写机器结果 ⇒ machine=null）。
  // R01/R02 **不是**已迁移的机器协议套件：禁止加进 MACHINE_SUITES、不要求机器 JSON，仍以
  // stdout 判词 + 退出码判定。两个 run 只落证据、**不进 `runs`** —— N04 断言 `runs` 里每个 run
  // 都落在本次夹具 session 之内（主仓 REPO 的 run 不属于夹具副本）。
  function r2runRepo(label, script) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'test', script + '.mjs')], {
      cwd: REPO, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024,
    })
    const record = { label, script, only: '', repo: REPO, code: r.status, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', machine: null }
    h.evidenceJson(`R2/runs/${label}.json`, record)
    h.evidence(`R2/runs/${label}.stdout.log`, record.stdout)
    h.evidence(`R2/runs/${label}.stderr.log`, record.stderr)
    h.assert(!r.error && r.status !== null, `${label}: process error/timeout`)
    return record
  }
  h.case('R01','pass',()=>{const r=r2runRepo('R01-original-T01','audit/T01');h.eq(r.code,0,'T01 regression');h.assert(r.stdout.includes('PASS T01 checks=27 failed=0 skipped=0'),'original T01 fixed27')})
  h.case('R02','pass',()=>{const r=r2runRepo('R02-original-T02','audit/T02');h.eq(r.code,0,'T02 regression');h.assert(r.stdout.includes('PASS T02 checks=34 failed=0 skipped=0'),'original T02 fixed34')})
  h.case('R03','pass',()=>{h.eq(IDS.length,18,'R1 fixed18 declaration');for(const id of IDS.filter(id=>!['N03','N04'].includes(id)))h.assert(h.cases.some(c=>c.id===id&&c.actual==='pass'),'R1 original case failed/missing '+id)})
  h.case('R04','pass',()=>{
    h.assert(visual.machine.skipped===1&&practice.machine.skipped===1,'real browser skip not measured')
    for(const m of [visual.machine,practice.machine])h.assert(m.cases.some(c=>c.status==='skip'&&c.note),'browser skip reason absent')
    honestBrowserSkips=true
    h.evidenceJson('R2/final-browser-policy.json',{reason:'browser-skipped-unverified',visual:visual.machine.skipped,practice:practice.machine.skipped,defaultExit:2,autoIsLocalOnly:true})
  })

} catch(e) { h.note(e.stack || String(e)); /* missing fixed cases are failures, never environmental PASS */ }
h.case('N03','pass',()=>{for(const p of sources)h.eq(sha(path.join(REPO,p)),initial[p],`primary source changed: ${p}`);h.evidenceJson('R1/source-hashes.json',initial)})
h.case('N04','pass',()=>{
  const resolved=path.resolve(session),parent=path.resolve('E:/Temp')
  h.assert(path.dirname(resolved)===parent && path.basename(resolved).startsWith('whale-T23-R1-'),'cleanup outside owned fixture')
  fs.rmSync(resolved,{recursive:true,force:true});h.assert(!fs.existsSync(resolved),'fixture remained')
  h.assert(runs.every(r=>r.repo.startsWith(session+path.sep)&&r.pack.startsWith(session+path.sep)),'run escaped owned fixture')
  h.evidenceJson('R1/cleanup.json',{session,removed:true,snapshotVerification:'not-measured; planner snapshot-guard required',runCount:runs.length,fixedRevision:REVISION})
})
h.evidenceJson('R1/run-index.json',runs.map(({label,repo,pack,code,error})=>({label,repo,pack,code,error})))
const autoVerdict = h.evaluate()
if (!AUTO && autoVerdict.failed === 0 && honestBrowserSkips) h.block('browser-skipped-unverified')
if (AUTO) h.note('T23-AUTO is only the automated matrix; T23/F03 remains BLOCKED without real browser evidence.')
process.exit(h.run())
