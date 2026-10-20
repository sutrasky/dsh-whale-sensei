#!/usr/bin/env node
/**
 * build-starmap.js — 星图数据生成器（课程包 → 星图数据）：**薄委托包装器**
 * ------------------------------------------------------------------
 * 用法： node tools/build-starmap.js [--check] [--allow-missing-requires]
 *
 * 输入： lessons/<halo>/halo.json          圆圈（大恒星）+ 课程之间的连线
 *        lessons/<halo>/<point>/point.json 知识点（轨道）+ `plan` 地图（规划暗星的唯一来源）
 *        lessons/src/**\/*.html 的 data-lesson-meta   课程（小星星）
 *        progress.json                     哪几颗星已经点亮
 * 输出： starmap/content.js   window.STARMAP_REAL
 *
 * **权威实现只有一份**：`lib/unify/content.cjs#projectStarmap`（U-SPEC §5 的单一源码；
 * U19 会把它逐字节生成成课程包里的 `tools/unify/content.cjs`）。本文件只剩 CLI 与 IO：
 * 选投影、打印内核给的文案、落盘、`--check` 的退出码、spawn 静态版。
 *
 * 课程身份口径（U-SPEC §2）：载荷里 `lessons[].id` 是**规范身份** `circle/point/NNNN`
 * ——跨圈同名知识点（`math/vue` 与 `programming/vue`）不会再互踩；
 * `progress.json.learned` 也按规范身份折算（历史形状逐条告警、不计入）。
 *
 * 三条硬规则（违反就大声说，绝不静默）：
 *   ① 每颗星都必须对应一个**真实存在的课程页**；构建产物缺失时报警。
 *   ② edges 的端点缺了就报警并跳过 —— 不许悄悄少画一条线。
 *   ③ lessons/src/ 根下的平铺课程是历史布局，归给 LEGACY_POINT，并在输出里点名。
 *
 * ⚠️ 本文件从模板铺出来的包里 require `./unify/content.cjs` —— 那份副本由 **U19** 生成；
 *    之前（R1，U15 登记）新包跑它会 MODULE_NOT_FOUND。这不是本文件的第二个实现。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');
const core = require('./unify/content.cjs');
const GX = require('./galaxy-shapes.cjs');     // 星系形状字典（与测试共用同一份真相；内核消费注入）

const ROOT = path.join(__dirname, '..');
const checkOnly = process.argv.includes('--check');
/** 离线端用（`--allow-missing-requires`）：库里可能只有"一节课所在的那个知识点"（老师一次只发一节课），
 *  前置还没导进来 ⇒ 悬空前置降级成**告警 + 剔除这条**，而不是让整张星图重建失败。
 *  默认（作者机器、有 src）**仍然硬失败** —— 本仓「悬空前置必须报」的纪律不变。 */
const allowMissingRequires = process.argv.includes('--allow-missing-requires');

let built = null;
try {
  built = core.buildCourseContent({
    root: ROOT,
    fs,
    sections: ['starmap'],
    loadData: (rel) => require(path.join(ROOT, rel)),
    deps: { galaxyShapes: GX },
    options: { allowMissingRequires },
  });
} catch (e) {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}

const r = built.sections.starmap;
if (r.fatal) {
  for (const line of r.fatal.err) console.error(line);
  process.exit(r.fatal.code);
}

for (const line of r.log) console.log(line);

const abs = path.join(ROOT, r.artifact.rel);
const text = r.artifact.text;
const ctx = { rel: path.relative(ROOT, abs), chars: text.length };

/** 内核文案里的占位符（路径与长度都是调用方才知道的事实） */
const say = (list) => {
  for (const m of list) {
    const line = m.line.replace(/%REL%/g, ctx.rel).replace(/%CHARS%/g, String(ctx.chars));
    (m.stream === 'err' ? console.error : console.log)(line);
  }
};

/** 静态版（M3）跟着一起重建 / 核对 —— 它读的正是 content.js，坐标来自 data-layer 的 layout() */
function buildStaticSvg() {
  const sub = spawnSync(process.execPath,
    [path.join(__dirname, 'build-starmap-svg.js'), ...(checkOnly ? ['--check'] : [])],
    { cwd: ROOT, stdio: 'inherit' });
  // 子进程**没起来**（EPERM / ENOENT）时 r.status 是 null —— 别喊「未同步（见上）」：上方什么都没有
  if (sub.error) {
    console.error(`[starmap] 起不了子进程：${sub.error.code || sub.error.message}（权限/沙箱边界）—— 这不是「命令没跑」也不是代码坏了。`
      + '出路：① 改 stdio:\'inherit\'（本处已是）② 结果写文件再读 ③ 在无沙箱环境跑。');
    process.exit(1);
  }
  if (sub.status !== 0) { console.error('[starmap] 静态版未同步（见上）'); process.exit(1); }
}

if (checkOnly) {
  const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (cur === text) {
    say(r.messages.checkSame);
    buildStaticSvg();
    process.exit(0);
  }
  say(r.messages.checkDiff);
  process.exit(1);
}
core.writeArtifact({ fs, target: abs, content: text, mode: r.artifact.mode });
say(r.messages.write);
buildStaticSvg();
