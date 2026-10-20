import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const REPO=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const TEMP=path.resolve('E:/Temp')
const JVM_ROOTS=['code/_hello-spring-boot/hello-spring-boot','code/programming']
/** Full input-tree identity, including raw bytes and link identities, without following links. */
export function inputTreeHash(root) {
  const hash=crypto.createHash('sha256')
  function walk(dir,rel='') {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)))) {
      const child=path.join(dir,entry.name), name=rel?rel+'/'+entry.name:entry.name
      hash.update(name).update('\0')
      if(entry.isSymbolicLink())hash.update('link\0').update(fs.readlinkSync(child)).update('\0')
      else if(entry.isDirectory()){hash.update('dir\0');walk(child,name)}
      else if(entry.isFile())hash.update('file\0').update(fs.readFileSync(child)).update('\0')
      else throw new Error('Unsupported input tree entry: '+child)
    }
  }
  walk(path.resolve(root));return hash.digest('hex')
}
/** Only test input preparation: no state verdicts, expectations, assertion results or skip handling. */
export function migratedPack(input) {
  const original=path.resolve(input), before=inputTreeHash(original)
  const root=fs.mkdtempSync(path.join(TEMP,'whale-T26-migrated-'))
  let cleaned=false
  const verifyAndCleanup=()=>{
    if(cleaned)return
    cleaned=true
    try {
      const after=inputTreeHash(original)
      process.stderr.write('[T26-input] '+JSON.stringify({original,before,after,unchanged:before===after})+'\n')
      assert.equal(after,before,'T26 migrated fixture changed its original input')
    } finally {
      const resolved=path.resolve(root)
      assert.ok(resolved.startsWith(TEMP+path.sep+'whale-T26-migrated-'),'refusing unknown fixture cleanup')
      fs.rmSync(resolved,{recursive:true,force:true})
    }
  }
  process.once('exit',()=>{try{verifyAndCleanup()}catch(e){process.stderr.write(e.stack+'\n');process.exitCode=1}})
  fs.cpSync(original,root,{recursive:true})
  for(const rel of ['assets/build-glossary.js','tools/fingerprint.js']) {
    const source=path.join(REPO,'lib/pack-template',rel), target=path.join(root,rel)
    if(fs.existsSync(target))fs.copyFileSync(source,target)
  }
  /*
   * 运行内核副本（U19）：模板里的 `assets/build-glossary.js`（U11）与 `tools/fingerprint.js`（U04）
   * 都已改成**委托** `tools/unify/<模块>.cjs`。本夹具的形态是「活包整棵拷贝 + 覆盖这两个包装器」，
   * 而**旧活包**没有 `tools/unify/` ⇒ 覆盖后的包装器一跑就 `Cannot find module '../tools/unify/glossary.cjs'`，
   * 夹具在准备阶段就抛，整个套件连断言都跑不到。
   * 修法与 decisions 决-5（T12 的负向夹具复制清单补 `lib/adapters/jvm.js`）**同类**：
   * 「夹具必须带上新的传递依赖」。这里只补**输入准备**，一条断言都没动。
   */
  const unifySrc=path.join(REPO,'lib/pack-template','tools','unify')
  if(fs.existsSync(unifySrc)) {
    const unifyDst=path.join(root,'tools','unify')
    fs.mkdirSync(unifyDst,{recursive:true})
    for(const e of fs.readdirSync(unifySrc,{withFileTypes:true})) {
      if(e.isFile()&&e.name.endsWith('.cjs')) fs.copyFileSync(path.join(unifySrc,e.name),path.join(unifyDst,e.name))
    }
  }
  declareAdapters(root)
  const cli=path.join(root,'assets/build-glossary.js')
  if(fs.existsSync(cli)) {
    const result=spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024})
    if(result.error||result.signal||result.status!==0)throw new Error('T26 glossary migration failed: '+JSON.stringify({exit:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr}))
  }
  process.stderr.write('[T26-migrated] '+JSON.stringify({original,root,inputHash:before,jvmRoots:JVM_ROOTS})+'\n')
  return root
}

/**
 * T26 的显式迁移：把「B10-R1 诊断」里 brief 夹具也纳入同一口径 ——
 * 通用 `detectFacts` 只在 `practice.adapters` 声明了 `jvm` 时才产出 JVM 事实；
 * 活包（只读）没有声明，所以**任何读活包的测试夹具**都必须在自己的副本里补声明，
 * 否则会把「没声明」误读成「学生没做」（brief 第 2 课就因此从 ✓ 变 ✗）。
 *
 * 只改 `practice.dirs` 命中 JVM 根的那几个 halo/point；不造学科、不改学生代码。
 * @param {string} root 课程包副本根
 */
export function declareAdapters(root){
  const declarations=(dir)=>{
    if(!fs.existsSync(dir))return
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name)
      if(entry.isSymbolicLink())throw new Error('Linked fixture config rejected: '+file)
      if(entry.isDirectory())declarations(file)
      else if(entry.isFile()&&/^(halo|point)\.json$/.test(entry.name)) {
        const doc=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))
        if(Array.isArray(doc?.practice?.dirs)&&doc.practice.dirs.some(d=>JVM_ROOTS.includes(String(d).replace(/\\/g,'/').replace(/^\/+|\/+$/g,'')))) {
          doc.practice.adapters=['jvm'];fs.writeFileSync(file,JSON.stringify(doc,null,2)+'\n')
        }
      }
    }
  }
  declarations(path.join(root,'lessons'))
}
