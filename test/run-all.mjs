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
  ['lightup', '点亮换钉子：判据快照先判后写 / 失败关闭五分支 / 判据拒绝与不可达分离 / 真包不动'],
  ['challenge-gate', '开新课门禁：上一课挑战逐条判 / 无判据放行有告警 / author 拦住且 force 留痕'],
  ['judge-parity', '判词表对拍：插件 judgeSnapshot ↔ 包侧 judgeLightup 同输入同判词（code/hint/gaps）+ 放行三元组 + 豁免表反核账'],
  ['plan-gate', '知识点地图：判据矩阵 / 写口拒坏图 / 大纲闸（禁 force 绕） / 真包不动'],
  ['ask-route', '课程疑问：提交 / 拉取 / 坏样本一动不动'],
  ['ask-answer', '解答写回：台账外科手术式追加 + 真跑重建'],
  ['rebuild-job', '异步重建器：起完就返回 / 顺序有意义 / 失败不中断 / 与同步版告警逐字相同'],
  ['rebuild-wiring', '三入口接重建：建圈五条 / 建点建课两条 / 入口不等脚本 / 缺件如实报 / 全缺不起作业'],
  ['bom-tolerance', 'BOM 容忍：带 BOM 与不带 BOM 结果完全一致'],
  ['glossary-verify', '名词台账：合成 == CLI，漂移/缺失报得出'],
  ['glossary-edit', '术语增改：切片插入/拒绝覆盖/替换；code 含花括号也不崩，写出的源码能 require 回来'],
  ['pack-model', '数据层唯一入口：课次映射表、data-term 扫描器与 check-terms 逐页对拍、三类 box 不变量'],
  ['ask-watch-job', '原生监听：owner/高水位/复用/撤销'],
  ['intake', '学情摸底：问题生成/落盘回读/author 闸门/decideNext/buildBrief 集成'],
  ['brief', '上下文包：六段对拍一致，建议随数据变'],
  ['goals', '终点契约：schema 校验 / 键序钉死 / 无时间戳 / append-only 留痕 / 失败回滚 / 空态回落'],
  ['goal-tool', 'whale_goal：必填严拒 / 原文逐字 / 裸名补圆圈 / append-only / from 接摸底 / 真包不动'],
  ['visual', '视觉检查：PNG/DOM 断言（有服务就真跑浏览器）'],
  ['practice', '实践区：数据与探针一致、可判漂移、真浏览器里显示'],
  ['mirror-parity', '镜像对拍：文本助手一致 + 两个写入口产出同形记录（共用一本台账）'],
  ['panel', '设置节：只读状态路由（没配也回 200 并指路）+ 客户端半边格式与官方缝对齐'],
  ['tool-smoke', '工具面：装得上、五字段齐全、只读调用不碰盘'],
  ['alien-env', '别人机器：只配课程包目录就能用（本机路径静态守卫 + 装得上 + 降级不糊屏 + 没配就报错）'],
  ['catalog', '数据面：圆圈/知识点/课程的规范 id（唯一、可解析）+ 下一课号 + 圆圈建议'],
  ['new-course-wizard', '新课程向导：三屏顺序 / 字段逐字未变 / 归属行按需出现 / 建点后地图指令 mapPrompt（话术·回执·客户端）'],
  ['circle-create', '写入口：新建圆圈/知识点（原子、拒覆盖、坏 id 拒绝、绝不碰真包）'],
  ['circle-delete', '圆圈删除：dryRun 只报清单 / 必须 confirm / 目录+源+进度一并删 / 学生代码只报不删 / 歧义拒绝'],
  ['settings-catalog', '设置页：三级目录 / 圆圈改名（只改 name、其余逐字节保留）/ 模块表可查 / 展开不串台 / 删除弹窗'],
  ['parity-registry', '同源实现对拍：每对的两个实现都在、落点存在且**真的在跑**（§5）'],
  ['pack-scaffold', '选课程包：原生选择框 / 只往空目录建 / 引擎模板中性化对拍 / profile 层就地改一行 / 拒绝面'],
  ['pack-open', '课程中心：先探活再起（复用不重复 listen）/ 起完真的答 / 缺件与端口被占一律如实报'],
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
  // 有摘要但失败了 → 把该套件自己的 FAIL/✗ 行打出来。
  // 为什么必须有这一条：2026-09-22 实测过"账报了红，但不告诉你红在哪" ——
  // 结果在整轮/单独跑之间来回猜了三轮（alien-env 整轮红、单跑绿）。摘要只给条数，定位得看原文。
  if (f !== 0) {
    const detail = out.split('\n').filter((l) => /FAIL|✗/.test(l)).slice(0, 8)
    if (detail.length) console.log(detail.map((l) => '    ' + l.trim()).join('\n'))
  }
}

console.log(`\n=== ${SUITES.length} 套 · 共 ${total} 条断言 · ${failed ? failed + ' 套失败 ✗' : '全部通过 ✓'} ===`)
if (failed) process.exit(1)
