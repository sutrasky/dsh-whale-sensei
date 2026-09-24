#!/usr/bin/env node
/**
 * lesson-map.js — 课次映射表（**课程包侧的唯一一份**）
 * ------------------------------------------------------------------
 * 为什么课程包里还要有一份：包侧的工具是 **CommonJS**、且要能脱离插件独立运行
 * （`build-notes.js:24-29` 的"技能包守卫"就是为这个）。插件的数据层
 * `lib/pack-model.js` 的 `lessonIndex()` 是 ESM，跨仓也不该被 require。
 *
 * ⚠️ **这是同一事实的第二份实现** —— 本项目正在消灭的东西。所以它不是"自由发挥的第二套口径"，
 *    而是被**一道机械对拍钉住**的镜像：
 *      `node lib/pack-model.js --selftest`（插件侧）里会同时加载本文件与 `lessonIndex()`，
 *      逐键比对 { label, point, number, title } 与 `labelOfAnchor()` 的行为 —— 任何一边漂了就当场红。
 *    算法与 `lib/pack-model.js` 的 `lessonIndex()` **逐条对应**，改一边必须改另一边（对拍会告诉你）。
 *
 * 台账口径（用户 2026-09-24 裁定，别重新推）：
 *   · 笔记台账 `notes/notes.jsonl` 里的 `anchor` 是 **星图课次键**（`point/NNNN`）
 *   · 「调用方写法 → 课次键」在**写入口**（插件的 `lib/notes-io.js`）做
 *   · 「课次键 → 显示名」的**反向**那一步只有 `labelOfAnchor()` 这一个实现（这里 + 插件各一份，对拍钉住）
 *
 * 用法：`const { lessonMap, labelOfAnchor } = require('./lesson-map.js')`
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 第 0001 课 → '第1课'（与 pack-model.js 的 lessonLabel 逐字一致） */
function lessonLabel(number) {
  return '第' + Number(number) + '课';
}

/**
 * 编号折算：**文件号（内部 ID）→ 显示号**。fileBase 来自 point.json（缺省 0 = 不折算）。
 * 为什么要折算（用户 2026-09-21 裁定「轨道机制」）：`byNumber` 按文件名的 4 位号索引，
 * 两条轨道不能共用 0001 —— 所以 Vue 第一课的文件号是 **1001**，而页面上要显示「Vue 第1课」。
 * 折算规则只此一处：build-lessons / build-starmap / build-notes 都从这里取（插件侧镜像在 pack-model.js）。
 */
function displayNumberOf(number, fileBase) {
  return Number(number) - (Number(fileBase) || 0);
}

/**
 * 扫 `lessons/<halo>/<point>/point.json`，建 `pointId → { label, fileBase }`。
 * 不缓存（与 lessonIndex 同样的理由：改了 point.json 必须立刻反映）。
 */
function pointMeta(root) {
  const out = new Map();
  const dir = path.join(path.resolve(root), 'lessons');
  if (!fs.existsSync(dir)) return out;
  for (const haloId of fs.readdirSync(dir)) {
    const hp = path.join(dir, haloId);
    let isDir = false;
    try { isDir = fs.statSync(hp).isDirectory(); } catch { isDir = false; }
    if (!isDir) continue;
    for (const pid of fs.readdirSync(hp)) {
      const pf = path.join(hp, pid, 'point.json');
      if (!fs.existsSync(pf)) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch { continue; }
      out.set(d.point || pid, { label: d.label || '', fileBase: Number(d.fileBase) || 0 });
    }
  }
  return out;
}

const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

// 历史平铺布局（`lessons/0001-*.html`）的兜底归属 —— 与插件侧 `lib/pack-model.js` 的同名常量
// **必须一致**（两份实现对拍钉住）：那边也是 programming / spring-boot。
// 为什么需要它：`byNumber` 的键现在是 `point/NNNN`，平铺布局的路径里没有"知识点"那一层。
const LEGACY_HALO = 'programming';
const LEGACY_POINT = 'spring-boot';

/**
 * 建映射表。**不缓存**：与插件的 `lessonIndex()` 行为保持一致（那边每次调用都重建），
 * 缓存会让"改了 EXPECT 却读到旧表"变成静默错误，而这点 IO 便宜得没必要省。
 *
 * @param {string} root 课程包根目录
 * @returns {{ byKey: object, byLabel: object, byNumber: object, conflicts: string[] }}
 */
function lessonMap(root) {
  const abs = path.resolve(root);
  const byNumber = new Map();

  // 产物页与源页：文件名 `NNNN-*.html`（对应 lessonIndex 的 collect()）。
  // **递归**：分层布局（lessons[/src]/<圆圈>/<知识点>/NNNN-*.html）与旧的平铺都要认 ——
  // 存进 map 的是**相对包根的路径**，平铺时它就等于文件名，分层时是 lessons/programming/vue/1001-*.html。
  const collect = (dir, field) => {
    const root = path.resolve(abs, dir);
    if (!fs.existsSync(root)) return;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          // ⚠️ lessons/src 是**作者态镜像**，不是产物页：扫进去会把 page 指到源文件上
          if (e.name === 'src') continue;
          walk(full); continue;
        }
        const m = /^(\d{4})-(.+)\.html$/.exec(e.name);
        if (!m) continue;
        // ⚠️ 键必须是 **point/NNNN**，不能只按 4 位课号：跨圈同号（`spring-boot/0001` 与 `alge/0001`）
        //    会把两课绑到同一个页面上，而且是**静默的** —— 2026-09-24 实测：`alge/0001` 的 src/page
        //    都指到了 spring-boot 那两页，`conflicts` 却还是空的。分层布局里知识点就是文件名的上一层；
        //    旧的平铺布局没有这一层 → 用 LEGACY_POINT（与 build-lessons 同一条规则）。
        const relPath = rel(abs, full);
        const parts = relPath.split('/');
        const point = parts.length >= 3 ? parts[parts.length - 2] : LEGACY_POINT;
        const key = point + '/' + m[1];
        const en = byNumber.get(key) || { number: m[1], slug: m[2] };
        en[field] = relPath;
        byNumber.set(key, en);
      }
    };
    walk(root);
  };
  collect(path.join('lessons', 'src'), 'src');
  collect('lessons', 'page');

  // EXPECT.json：权威的 `point/NNNN` 键。
  // **逐根递归**扫（≤4 层）：Spring Boot 轨在 `code/_hello-spring-boot/`，
  // Vue 轨按 point.json 的 practice.dirs 在 `code/programming/vue/` —— 只扫一层会漏掉后者，
  // 漏掉的表现是"lessons 里有 1001 但 EXPECT.json 没声明它"（conflict），而不是静默。
  // 扫**哪些**目录：**课程包自己的判据快照说了算**（`learning-records/state.json` 的
  // `practiceRoots` —— 2026-09-24 起是"圈级 `halo.json` ∪ 点级 `point.json` 声明的实践区"）。
  // 老快照只有 `codeDir` → 当成单根；快照读不动 → 按老规矩 'code'。**零回归**。
  // 必须与插件侧 `lib/pack-model.js` 读**同一个源** ——
  // 两侧一漂就会出现"点亮认 math/、EXPECT 却只认 code/"的半瘫（2026-09-24 主人定）。
  let roots = ['code'];
  try {
    const st = JSON.parse(fs.readFileSync(path.join(abs, 'learning-records', 'state.json'), 'utf8'));
    const list = Array.isArray(st && st.practiceRoots)
      ? st.practiceRoots.map((d) => String(d == null ? '' : d).trim()).filter(Boolean)
      : [];
    if (list.length) roots = [...new Set(list)].sort();
    else if (st && typeof st.codeDir === 'string' && st.codeDir.trim()) roots = [st.codeDir.trim()];
  } catch (e) { /* 没有快照 / 读不动 → 用老的 'code'，零回归 */ }
  const declared = new Map();
  function readExpect(exp) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(exp, 'utf8')); } catch (e) { return; }
    for (const l of doc.lessons || []) {
      if (!l || typeof l.id !== 'string') continue;
      declared.set(l.id, { id: l.id, title: l.title, expect: rel(abs, exp) });
    }
  }
  function walkExpect(dir, depth) {
    if (depth > 4) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    if (names.includes('EXPECT.json')) readExpect(path.join(dir, 'EXPECT.json'));
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const p = path.join(dir, n);
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch (e) { isDir = false; }
      if (isDir) walkExpect(p, depth + 1);
    }
  }
  for (const r of roots) {
    const dir = path.isAbsolute(r) ? r : path.join(abs, r);
    if (!fs.existsSync(dir)) continue;
    // EXPECT.json 既可能在项目根，也可能在它的**上一层**（学生的目录习惯是 `<项目名>/<项目名>/`）。
    // 声明的实践区可能直接指到项目根（spring-boot 那条历史路径就是），只往树里找会**漏掉它**，
    // 表现是"lessons 里有 0001 但 EXPECT.json 没声明它"（conflict）—— 与插件侧 `state-scan.findExpect` 同一条约定
    const up = path.join(path.dirname(dir), 'EXPECT.json');
    if (fs.existsSync(up)) readExpect(up);
    walkExpect(dir, 1);
  }

  const byKey = {};
  const byLabel = {};
  const conflicts = [];
  const pm = pointMeta(abs);
  for (const [id, d] of declared) {
    const m = /^(.+)\/(\d{4})$/.exec(id);
    if (!m) { conflicts.push('EXPECT 里的 id 形状不对：' + id); continue; }
    const number = m[2];
    // 直接用声明里的 id 当键（`point/NNNN`）—— 只按课号查会跨圈串页
    const e = byNumber.get(id);
    if (!e) { conflicts.push(id + ' 在 EXPECT 里声明了，但 lessons/ 与 lessons/src/ 里都没有 ' + number + ' 的页面'); continue; }
    const info = pm.get(m[1]) || { label: '', fileBase: 0 };
    const displayNumber = displayNumberOf(number, info.fileBase);
    const entry = {
      key: id,
      point: m[1],
      number,
      displayNumber,
      label: info.label ? `${info.label} 第${displayNumber}课` : `第${displayNumber}课`,
      pointLabel: info.label,
      fileBase: info.fileBase,
      title: d.title,
      expect: d.expect,
      src: e.src || null,
      page: e.page || null,
    };
    if (!entry.src) conflicts.push(id + ' 缺课程源（lessons/src/' + number + '-*.html）');
    if (!entry.page) conflicts.push(id + ' 缺课程产物（lessons/' + number + '-*.html）');
    byKey[id] = entry;
    // 显示名撞车要**点名**：跨圈同号（`spring-boot/0001` 与 `alge/0001` 都叫「第1课」）会让
    // `keyOfAnchor` 变成"看谁后遍历到" —— 两份实现顺序不同就选出不同的赢家（2026-09-24 对拍抓到）。
    // 修法是给那个知识点一个 label（vue 早就这么做：显示名成「Vue 第1课」）。
    if (byLabel[entry.label]) {
      conflicts.push('课次显示名撞车：' + entry.label + '（' + byLabel[entry.label].key + ' 与 ' + entry.key + '）—— 给其中一个知识点的 point.json 加 label');
    }
    byLabel[entry.label] = entry;
  }
  for (const [key, e] of byNumber) {
    if (!declared.has(key)) {
      conflicts.push('lessons 里有 ' + key + '（' + (e.page || e.src) + '）但 EXPECT.json 没声明它');
    }
  }
  return { byKey, byLabel, byNumber: Object.fromEntries(byNumber), conflicts };
}

/**
 * 台账的 `anchor`（星图课次键）→ 课次显示名（`第1课`）。解析不到 → null。
 * 与 `lib/pack-model.js` 的同名函数逐字对应（对拍钉住）。
 *
 * @param {string} anchor
 * @param {{byKey: object}} index `lessonMap(root)` 的返回值
 */
function labelOfAnchor(anchor, index) {
  return index?.byKey?.[anchor]?.label ?? null;
}

/**
 * 调用方写法（`第1课` label 或 `point/NNNN` key）→ **星图课次键**。解析不到 → null。
 * 与 `lib/pack-model.js` 的同名函数逐字对应（对拍钉住）。
 * 旧写入口 `ask-server.js` 的 `/note` 靠它把记录归一成与插件写入口**同形**的。
 *
 * @param {string} anchor
 * @param {{byKey: object, byLabel: object}} index `lessonMap(root)` 的返回值
 */
function keyOfAnchor(anchor, index) {
  if (!anchor) return null;
  return index?.byKey?.[anchor]?.key ?? index?.byLabel?.[anchor]?.key ?? null;
}

module.exports = { lessonMap, labelOfAnchor, keyOfAnchor, lessonLabel, displayNumberOf, pointMeta };
