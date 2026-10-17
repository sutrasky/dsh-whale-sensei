#!/usr/bin/env node
/** T08 + R1/R2 + R3: real HTTP entrypoints, no global exception handlers, no restart.
 * All course data is created under a guarded E:/Temp fixture. No live pack writes.
 * Old implementations are recovered from the dispatch commit into separate copies.
 * R3 pins two seams the R1/R2 candidate left open: the static denial code must stay **403** while API
 * encoding errors stay **400** (T06's contract is not silently upgraded), and a **real OS spawn error**
 * on the child process must converge to a 500 for that request instead of an unhandled 'error' crash.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHarness, REPO } from './harness.mjs';
const SELF = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const BASE = 'fd0d82b6c6b7c05dc515c44c14fd515fe2deabb4';
const SERVICES = ['ask', 'app', 'offline'];
const SCENARIOS = ['url400', 'shape400', 'json400', 'limit413', 'session400', 'session413', 'session-empty', 'auth-before-body', 'rounds20-pid', 'abort-no-write', 'timeout400', 'stream400', 'sync500', 'reject500', 'io500', 'valid-write', 'empty-default'];
const NEGATIVES = [['ask','shape400'], ['ask','session400'], ['app','url400'], ['offline','shape400'], ['offline','url400'], ['ask','timeout400'], ['ask','stream400'], ['ask','sync500'], ['offline','io500'], ['ask','io500'], ['offline','spawn-failure']];
const EXTRA = ['pure-shapes', 'old-pure-shapes', 'pure-limits', 'helper-settle-once', 'helper-ended-response', 'helper-headers-sent', 'scaffold-propagation', 'bootstrap-propagation', 'engine-registration', 'cleanup-guard', 'offline-spawn-failure'];
const IDS = [...SERVICES.flatMap(s => SCENARIOS.map(c => `T08-${s}-${c}`)), ...SERVICES.map(s => `T08-${s}-encoding-contract`), ...NEGATIVES.map(([s,c])=>`T08-old-${s}-${c}`), ...EXTRA.map(c=>`T08-${c}`)];
const arg = n => process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const wj = (p,v) => fs.writeFileSync(p,JSON.stringify(v,null,2),'utf8');
const wait = ms => new Promise(r=>setTimeout(r,ms));
function digest(root) {
 const rows=[];
 function walk(d,rel='') { if(!fs.existsSync(d)) return; for(const e of fs.readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {const r=rel+'/'+e.name;const p=path.join(d,e.name); if(e.isDirectory())walk(p,r); else rows.push([r,crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);} }
 for(const d of ['questions','notes','learning-records','progress.json','packs']) {const p=path.join(root,d);if(fs.existsSync(p)&&fs.statSync(p).isFile()) rows.push([d,fs.readFileSync(p,'utf8')]);else walk(p,d);}
 return JSON.stringify(rows);
}
async function worker() {
 const root=arg('root'), service=arg('worker'), only=arg('only');
 process.env.WHALE_LIB=path.join(root,'packs');
 fs.writeFileSync(path.join(root,'package.json'),'{"type":"commonjs"}');
 // T08-R3：**公开的 child_process 缝**，必须在 require 之前装 —— 产品件在模块加载时就解构了 `spawn`。
 // 默认原样透传；只有 spawn-failure 那一档把它换成**真实缺失的可执行文件**：走的是真 OS 的 error 事件
 // （不是手工 emit），产品侧没挂监听器就会如实崩。夹具课程库照样在盘上（存在性检查过），起不来的只有子进程。
 let spawnFault=false;
 if(service==='offline'){
  const cp=require('child_process'), realSpawn=cp.spawn;
  cp.spawn=(exe,args,opts)=>spawnFault?realSpawn(path.join(root,'deliberately-missing-node.exe'),args,opts):realSpawn(exe,args,opts);
 }
 const api=require(path.join(root,'tools',service==='ask'?'ask-server.js':service+'-server.js'));
 const handler=service==='ask'?api.handleRequest:api.handler;
 const entries=[], traffic=[];
 const server=http.createServer((req,res)=>{
   if(req.headers['x-t08-stream']) setImmediate(()=>req.emit('error',new Error('test stream failure')));
   return handler(req,res);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port, pid=process.pid;
 const health=service==='offline'?'/api/health':'/health';
 const route=service==='offline'?'/api/migrate':'/ask';
 const request=(url,body='',opts={})=>new Promise((resolve,reject)=>{
   const req=http.request({host:'127.0.0.1',port,path:url,method:opts.method||'POST',agent:false,headers:{'content-type':'application/json',...opts.headers}},res=>{
    let raw='';res.setEncoding('utf8');res.on('data',c=>raw+=c);res.on('error',reject);res.on('end',()=>{let doc;try{doc=JSON.parse(raw);}catch{doc=null;}traffic.push({method:opts.method||'POST',url,bodyBytes:Buffer.byteLength(body),status:res.statusCode,raw});resolve({status:res.statusCode,doc,raw});});
   });
   req.on('error',reject);req.setTimeout(7500,()=>req.destroy(Error('test request deadline')));
   if(opts.incomplete){req.write(body); /* intentionally no end until server deadline */}
   else req.end(body);
 });
 const error=(r,status)=>{ assert.equal(r.status,status,r.raw);assert.equal(r.doc?.ok,false);assert.equal(typeof r.doc.code,'string');assert.equal(typeof r.doc.error,'string');assert(r.doc.code&&r.doc.error);assert(!/secret-canary|Error:|\bat .*:\d+/.test(r.raw)); };
 const healthy=async()=>{const r=await request(health,'',{method:'GET'});assert.equal(r.status,200);assert.equal(r.doc.ok,true);assert.equal(process.pid,pid);return r;};
 async function run(name,fn){if(only&&only!==name)return;try{const detail=await fn();entries.push({name,ok:true,detail});}catch(e){entries.push({name,ok:false,error:e.stack});}}
 await run('url400',async()=>{error(await request('/api/session?bad=%zz','{}'),400);error(await request('/api/session?bad=%E0%A4','{}'),400);await healthy();});
 await run('shape400',async()=>{const before=digest(root);for(const body of ['null','[]','true','42','"x"'])error(await request(route,body),400);assert.equal(digest(root),before);});
 await run('json400',async()=>{const before=digest(root);error(await request(route,'{"bad":'),400);assert.equal(digest(root),before);});
 await run('limit413',async()=>{
  const before=digest(root);
  if(service==='offline') { error(await request('/api/session',JSON.stringify({pad:'中'.repeat(3000)})),413); error(await request('/api/import?name=t08.zip&confirm=1',Buffer.alloc(64*1024*1024+1)),413); }
  else for(const [p,msg] of [['/ask','问题'],['/note','笔记'],['/progress','内容']]) {const r=await request(p,JSON.stringify({question:'中'.repeat(5500)}));error(r,413);assert.equal(r.doc.error,`${msg}太长了，请精简到 16KB 以内`);}
  assert.equal(digest(root),before);
 });
 await run('session400',async()=>{for(const body of ['null','[]','1','{']) {const r=await request('/api/session',body);error(r,400);assert(!r.doc.token);} });
 await run('session413',async()=>error(await request('/api/session',JSON.stringify({pad:'x'.repeat(8192)})),413));
 await run('session-empty',async()=>{const r=await request('/api/session','');assert.equal(r.status,200);assert(r.doc.token);});
 await run('auth-before-body',async()=>{const before=digest(root);error(await request(route,'null',{headers:{origin:'http://evil.test'}}),403);error(await request('/api/session','null',{headers:{origin:'http://evil.test'}}),403);assert.equal(digest(root),before);});
 await run('rounds20-pid',async()=>{const rounds=[];for(let i=0;i<20;i++){error(await request(route,i%2?'null':'[]'),400);await healthy();rounds.push({round:i+1,pid,status:200});}return rounds;});
 await run('abort-no-write',async()=>{const before=digest(root);await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:route,method:'POST',agent:false,headers:{'content-length':1000}},()=>reject(Error('aborted request unexpectedly responded')));req.on('error',()=>{});req.write('{"question":"abort-canary',()=>{req.destroy();resolve();});});await wait(60);await healthy();assert.equal(digest(root),before);});
 await run('timeout400',async()=>{const before=digest(root);const start=Date.now();const r=await request(route,'{',{incomplete:true,headers:{'content-length':100}});error(r,400);assert.equal(r.doc.code,'BODY_TIMEOUT');assert(Date.now()-start>=4800&&Date.now()-start<7000);await healthy();assert.equal(digest(root),before);});
 await run('stream400',async()=>{const before=digest(root);for(const target of [route,'/api/session']) {const r=await request(target,'{',{incomplete:true,headers:{'content-length':100,'x-t08-stream':'1'}});error(r,400);assert.equal(r.doc.code,'BODY_STREAM_ERROR');}await healthy();assert.equal(digest(root),before);});
 await run('sync500',async()=>{const orig=api.capabilities.authorize;api.capabilities.authorize=()=>{throw Error('secret-canary');};try{error(await request(route,'{}'),500);}finally{api.capabilities.authorize=orig;}await healthy();});
 await run('reject500',async()=>{const security=service==='app'?require(path.join(root,'tools','ask-server.js')).httpSecurity:api.httpSecurity;const orig=security.sessionHandler;security.sessionHandler=async()=>{throw Error('secret-canary');};try{error(await request('/api/session','{}'),500);}finally{security.sessionHandler=orig;}await healthy();});
 await run('io500',async()=>{
  if(service==='offline'){const orig=fs.readFileSync;fs.readFileSync=function(p,...rest){if(String(p).endsWith('offline-admin.html'))throw Error('secret-canary');return orig.call(this,p,...rest);};try{error(await request('/','',{method:'GET'}),500);}finally{fs.readFileSync=orig;}}
  else {const orig=fs.appendFileSync;fs.appendFileSync=()=>{throw Error('secret-canary');};try{error(await request('/progress',JSON.stringify({lesson:'t08/0001',done:false,adjust:'io-canary'})),500);}finally{fs.appendFileSync=orig;}}
  await healthy();
 });
 await run('valid-write',async()=>{if(service==='offline'){const old=path.join(root,'packs','old-t08','lessons');fs.mkdirSync(old,{recursive:true});fs.writeFileSync(path.join(old,'t08.html'),'<h1>valid-migration-canary</h1>');wj(path.join(old,'lessons.json'),{v:1,lessons:[{rel:'t08.html',number:1,title:'T08 fixture'}]});const plan=await request('/api/migration','',{method:'GET'});const r=await request(route,JSON.stringify({confirm:true,planDigest:plan.doc.digest}));assert.equal(r.status,200);assert.equal(r.doc.ok,true);assert.deepEqual(r.doc.migrated,['old-t08']);assert(fs.readFileSync(path.join(root,'packs','library','lessons','t08.html'),'utf8').includes('valid-migration-canary'));}else {const r=await request('/ask',JSON.stringify({question:'valid-canary'}));assert.equal(r.status,200);assert.equal(r.doc.ok,true);assert(fs.readFileSync(path.join(root,'questions','pending.jsonl'),'utf8').includes('valid-canary'));const p=await request('/progress',JSON.stringify({lesson:'t08/0001',done:false,adjust:'valid-adjust'}));assert.equal(p.status,200);assert.equal(p.doc.adjustSaved,true);}await healthy();});
 await run('empty-default',async()=>{const r=await request(route,'');assert.equal(r.status,service==='offline'?200:400);assert.equal(r.doc.ok,false);});
 // T08-R3 ①：静态面保持 T06 的 **403** 契约（不许被升成 400）；API 的编码语义仍是 **400**。
 await run('encoding-contract',async()=>{
  const apiBad=await request('/api/session?bad=%ZZ','',{method:'GET'});
  error(apiBad,400);assert.equal(apiBad.doc.code,'BAD_URL_ENCODING',apiBad.raw);
  const healthBad=await request(health+'?bad=%ZZ','',{method:'GET'});
  error(healthBad,400);assert.equal(healthBad.doc.code,'BAD_URL_ENCODING',healthBad.raw);
  if(service==='offline'){const r=await request('/assets/%ZZ','',{method:'GET'});assert.equal(r.status,403,`/assets/%ZZ -> ${r.status} ${r.raw}`);assert(!/BAD_URL_ENCODING/.test(r.raw),r.raw);}
  if(service==='app')for(const raw of ['/%ZZ','/assets/%ZZ']){const r=await request(raw,'',{method:'GET'});assert.equal(r.status,403,`${raw} -> ${r.status} ${r.raw}`);}
  await healthy();
 });
 // T08-R3 ②：**真实 OS 子进程启动失败**（经公开 child_process 缝换成真实缺失的可执行文件，不是手工 emit）：
 // 请求回 500、正文不泄漏，进程不崩，同一 PID 随后健康，children 不残留，清理路径不受影响。
 await run('spawn-failure',async()=>{
  if(service!=='offline')return;
  const libTools=path.join(root,'packs','library','tools');
  fs.mkdirSync(libTools,{recursive:true});
  fs.writeFileSync(path.join(libTools,'app-server.js'),'// fixture only: the injected executable is missing, so this file is never executed\n');
  spawnFault=true;
  try{
   const opened=await request('/api/open?id=library','',{method:'POST'});
   error(opened,500);assert.equal(opened.doc.code,'SPAWN_FAILED',opened.raw);
   assert(!/ENOENT|deliberately|missing-node|app-server\.js|\.exe|Error:|\bat .*:\d+/.test(opened.raw),opened.raw);
   const lazy=await request('/library/starmap/','',{method:'GET'});
   error(lazy,500);assert.equal(lazy.doc.code,'SPAWN_FAILED',lazy.raw);
   assert(!/ENOENT|deliberately|missing-node|app-server\.js|\.exe|Error:|\bat .*:\d+/.test(lazy.raw),lazy.raw);
   // children 不残留半起的 child：再点一次不许被它短路成 `started:false`
   const again=await request('/api/open?id=library','',{method:'POST'});
   error(again,500);assert.equal(again.doc.code,'SPAWN_FAILED',again.raw);
   assert(!api.closePackServers().includes('library'),'children 里残留了没起来的 child');
   await healthy();
   // 清理路径不受影响：child 已经死了，removePack 不许抛
   const removed=await api.removePack('library');
   assert.equal(removed.ok,true,JSON.stringify(removed));
  }finally{spawnFault=false;}
  await healthy();
 });
 server.closeAllConnections();await new Promise(r=>server.close(r));api.closePackServers?.();
 wj(arg('report'),{pid,entries,traffic});process.exitCode=entries.some(e=>!e.ok)?1:0;
}

async function main(){
 const runId=`executor4-r3-${Date.now()}-${process.pid}`;
 const evidence=path.join(REPO,'audit-evidence','T08',runId);fs.mkdirSync(evidence,{recursive:true});
 const h=createHarness({card:'T08',expectedIds:IDS,evidenceDir:evidence});
 const baselineMaterial=spawnSync('git',['cat-file','-e',BASE+'^{commit}'],{cwd:REPO,encoding:'utf8'});
 if(baselineMaterial.error||baselineMaterial.status!==0){h.block('基线材料不可用（git/dispatch commit）');process.exitCode=h.run();return;}
 let temp;
 try{fs.mkdirSync('E:/Temp',{recursive:true});temp=fs.mkdtempSync('E:/Temp/whale-T08-executor3-');}
 catch(e){h.block('临时夹具环境不可用：'+String(e.message).replace(/\s+/g,' '));process.exitCode=h.run();return;}
 // Use the public test/deployment seam; never persist a fixture's secret in user runtime state.
 process.env.WHALE_RUNTIME_DIR=path.join(temp,'runtime');
 process.env.WHALE_RUNTIME_SECRET=crypto.randomBytes(32).toString('hex');
 const fixture=name=>{const p=path.join(temp,name);fs.cpSync(path.join(REPO,'lib','pack-template'),p,{recursive:true});fs.writeFileSync(path.join(p,'package.json'),'{"type":"commonjs"}');return p;};
 const child=(args,name,timeout=90000)=>{
  const r=spawnSync(process.execPath,[SELF,...args],{cwd:REPO,encoding:'utf8',timeout,maxBuffer:16*1024*1024});
  fs.writeFileSync(path.join(evidence,name+'.stdout.log'),r.stdout||'','utf8');fs.writeFileSync(path.join(evidence,name+'.stderr.log'),r.stderr||'','utf8');
  wj(path.join(evidence,name+'.process.json'),{command:[process.execPath,SELF,...args],status:r.status,signal:r.signal,error:r.error?.message});return r;
 };
 const check=(id,fn)=>h.case('T08-'+id,'pass',()=>{try{return fn();}catch(e){throw Error(String(e.message).replace(/\s+/g,' '));}});
 try {
  for(const service of SERVICES){
   const root=fixture(service), report=path.join(evidence,service+'.json');
   const r=child([`--worker=${service}`,`--root=${root}`,`--report=${report}`],service);
   let data;try{data=JSON.parse(fs.readFileSync(report,'utf8'));}catch{}
   for(const c of SCENARIOS)check(service+'-'+c,()=>{assert(!r.error&&!r.signal,'child failed/timeout: '+r.error);assert(data,'missing child report, exit '+r.status);const e=data.entries.find(e=>e.name===c);assert(e?.ok,e?.error||'missing case');});
   // T08-R3：静态/API 编码契约（三服务）与真实 OS spawn 失败收敛（只有管理台自己会起子进程）。
   check(service+'-encoding-contract',()=>{assert(!r.error&&!r.signal,'child failed/timeout: '+r.error);assert(data,'missing child report, exit '+r.status);const e=data.entries.find(e=>e.name==='encoding-contract');assert(e?.ok,e?.error||'missing case');});
   if(service==='offline')check('offline-spawn-failure',()=>{assert(!r.error&&!r.signal,'child failed/timeout: '+r.error);assert(data,'missing child report, exit '+r.status);const e=data.entries.find(e=>e.name==='spawn-failure');assert(e?.ok,e?.error||'missing case');});
   if(data)assert.equal(r.status,data.entries.some(e=>!e.ok)?1:0,'child exit/report mismatch');
  }
  // Every negative assertion runs unchanged against a fresh dispatch-baseline copy.
  for(const [service,c] of NEGATIVES){
   const root=fixture('old-'+service+'-'+c);
   for(const f of ['ask-server.js','app-server.js','offline-server.js']){
    const r=spawnSync('git',['show',`${BASE}:lib/pack-template/tools/${f}`],{cwd:REPO,encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr);fs.writeFileSync(path.join(root,'tools',f),r.stdout);
   }
   const report=path.join(evidence,'old-'+service+'-'+c+'.json');
   const r=child([`--worker=${service}`,`--only=${c}`,`--root=${root}`,`--report=${report}`],'old-'+service+'-'+c,20000);
   check('old-'+service+'-'+c,()=>{assert(!r.error&&!r.signal,'negative must fail behaviorally, not tool timeout');assert.equal(r.status,1);if(fs.existsSync(report)){const d=JSON.parse(fs.readFileSync(report,'utf8'));assert.equal(d.entries.length,1);assert.equal(d.entries[0].ok,false);}else assert(/TypeError|secret-canary|Unhandled 'error'|ERR_HTTP_HEADERS_SENT/.test(r.stderr),r.stderr);});
  }
  const {parseAskBody,validateAnswerBody,ASK_MAX_BYTES}=await import('../../lib/ask.js');
  const oldAsk = spawnSync('git',['show',`${BASE}:lib/ask.js`],{cwd:REPO,encoding:'utf8',maxBuffer:1024*1024});
  assert.equal(oldAsk.status,0,oldAsk.stderr);
  const oldAskFile=path.join(temp,'old-ask.mjs');fs.writeFileSync(oldAskFile,oldAsk.stdout);
  const oldPure=await import(new URL('file:///'+oldAskFile.replace(/\\/g,'/')).href);
  check('old-pure-shapes',()=>{assert.throws(()=>oldPure.parseAskBody('null'),TypeError);assert.throws(()=>oldPure.validateAnswerBody('null'),TypeError);});
  check('pure-shapes',()=>{for(const f of [parseAskBody,validateAnswerBody])for(const b of ['null','[]','true','1','"x"']){const r=f(b);assert.equal(r.status,400);assert.equal(r.ok,false);}});
  check('pure-limits',()=>{assert.equal(ASK_MAX_BYTES,16384);assert.equal(parseAskBody('x'.repeat(16385)).status,413);assert.equal(validateAnswerBody('中'.repeat(5500)).status,413);});
  const helper=require(path.join(REPO,'lib','pack-template','tools','http-request.cjs'));
  const {PassThrough}=await import('node:stream');
  await (async()=>{let failure;try{const req=new PassThrough();let settled=0;const p=helper.readJsonObject(req,{timeoutMs:20}).then(()=>{settled++;},e=>{settled++;assert.equal(e.code,'BODY_TIMEOUT');});await p;req.emit('end');req.emit('aborted');req.emit('close');req.emit('error',Error('late'));assert.equal(settled,1);assert.equal(req.listenerCount('data'),0);assert.equal(req.listenerCount('end'),0);assert.equal(req.listenerCount('aborted'),0);assert.equal(req.listenerCount('close'),0);}catch(e){failure=e;}check('helper-settle-once',()=>{if(failure)throw failure;});})();
  for(const [id,flag] of [['helper-ended-response','writableEnded'],['helper-headers-sent','headersSent']]) {let failure;try{const res={[flag]:true,writeHead(){throw Error('duplicate headers');},end(){throw Error('duplicate end');}};await helper.withRequestBoundary(()=>{throw Error('late');})({},res);await helper.withRequestBoundary(async()=>{throw Error('late');})({},res);}catch(e){failure=e;}check(id,()=>{if(failure)throw failure;});}
  const {writeScaffold}=await import('../../lib/pack-scaffold.js');const scaffold=path.join(temp,'scaffold');
  check('scaffold-propagation',()=>{fs.mkdirSync(scaffold);const r=writeScaffold(scaffold);assert.equal(r.ok,true,r.error);assert(fs.existsSync(path.join(scaffold,'tools','http-request.cjs')));assert.equal(typeof require(path.join(scaffold,'tools','app-server.js')).handler,'function');});
  check('bootstrap-propagation',()=>{const root=fixture('bootstrap-source');const dest=path.join(temp,'bootstrap-dest');const r=require(path.join(root,'tools','offline-bootstrap.js')).initSkeleton(dest);assert.equal(r.ok,true,r.error);assert(fs.existsSync(path.join(dest,'tools','http-request.cjs')));assert.equal(typeof require(path.join(dest,'tools','app-server.js')).handler,'function');assert.equal(typeof require(path.join(dest,'tools','offline-server.js')).handler,'function');});
  check('engine-registration',()=>{const p=require(path.join(REPO,'lib','pack-template','tools','engine-policy.cjs'));assert(p.ENGINE_FILES.includes('tools/http-request.cjs'));const m=p.buildManifest(path.join(REPO,'lib','pack-template'));assert(m.files.some(f=>f.path==='tools/http-request.cjs'&&f.sha256));});
 } catch(e){h.note(e.stack);check('unexpected',()=>{throw e;});}
 finally {
  check('cleanup-guard',()=>{const abs=path.resolve(temp);assert.equal(path.dirname(abs).toLowerCase(),path.resolve('E:/Temp').toLowerCase());assert(path.basename(abs).startsWith('whale-T08-executor3-'));fs.rmSync(abs,{recursive:true,force:true});assert(!fs.existsSync(abs));});
 }
 process.exitCode = h.run();
 const casesFile=path.join(evidence,'cases.jsonl');
 if(fs.existsSync(casesFile))fs.writeFileSync(casesFile,fs.readFileSync(casesFile,'utf8').replace(/^\uFEFF/,''),'utf8');
}
if(arg('worker')) await worker();else await main();
