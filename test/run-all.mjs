/**
 * run-all.mjs —— 一条命令跑完全部判据
 *
 * 每套测试自成进程（互不污染），失败即非零退出。
 * 用途：改完插件先跑这个，再谈重启宿主。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SUITES = [
  ['pack-parity', '课程包读取：同输入 → 同输出'],
  ['build-verify', '产物校验：坏样会被抓出'],
  ['probe-audit', '路径判定 + 五条审计'],
  ['style-mode-author', '主题 / 状态机 / 骨架'],
  ['render-parity', 'M2 对拍：插件渲染 == CLI 渲染（逐字节）'],
  ['build-write', '落盘分支：抓得到漂移、修得对、真包不动'],
  ['state-probe', '学生状态探针：与人工记录一致、坏样本报得出缺什么'],
  ['ask-route', '课程疑问：提交 / 拉取 / 坏样本一动不动'],
  ['ask-answer', '解答写回：台账外科手术式追加 + 真跑重建'],
  ['bom-tolerance', 'BOM 容忍：带 BOM 与不带 BOM 结果完全一致'],
  ['glossary-verify', '名词台账：合成 == CLI，漂移/缺失报得出'],
  ['glossary-edit', '术语增改：切片插入/拒绝覆盖/替换；code 含花括号也不崩，写出的源码能 require 回来'],
  ['pack-model', '数据层唯一入口：课次映射表、data-term 扫描器与 check-terms 逐页对拍、三类 box 不变量'],
  ['ask-watch-job', '原生监听：owner/高水位/复用/撤销'],
  ['intake', '学情摸底：问题生成/落盘回读/author 闸门/decideNext/buildBrief 集成'],
  ['brief', '上下文包：六段对拍一致，建议随数据变'],
  ['visual', '视觉检查：PNG/DOM 断言（有服务就真跑浏览器）'],
  ['practice', '实践区：数据与探针一致、可判漂移、真浏览器里显示'],
  ['mirror-parity', '镜像对拍：文本助手一致 + 两个写入口产出同形记录（共用一本台账）'],
  ['panel', '设置节：只读状态路由（没配也回 200 并指路）+ 客户端半边格式与官方缝对齐'],
  ['tool-smoke', '工具面：装得上、五字段齐全、只读调用不碰盘'],
  ['alien-env', '别人机器：只配课程包目录就能用（本机路径静态守卫 + 装得上 + 降级不糊屏 + 没配就报错）'],
]

let failed = 0
let total = 0
for (const [name, what] of SUITES) {
  const t0 = Date.now()
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [path.join(HERE, name + '.mjs')], { encoding: 'utf8' })
  } catch (e) {
    code = e.status ?? 1
    out = (e.stdout || '') + (e.stderr || '')
  }
  const m = out.match(/=== (\d+) 通过 \/ (\d+) 失败 ===/)
  const p = m ? Number(m[1]) : 0
  const f = m ? Number(m[2]) : 1
  total += p
  if (code !== 0 || f !== 0) failed++
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`${code === 0 && f === 0 ? '✓' : '✗'} ${name.padEnd(18)} ${String(p).padStart(3)} 通过${f ? ` / ${f} 失败` : ''}  (${secs}s)  ${what}`)
  if (code !== 0 && !m) console.log(out.split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'))
}

console.log(`\n=== ${SUITES.length} 套 · 共 ${total} 条断言 · ${failed ? failed + ' 套失败 ✗' : '全部通过 ✓'} ===`)
if (failed) process.exit(1)
