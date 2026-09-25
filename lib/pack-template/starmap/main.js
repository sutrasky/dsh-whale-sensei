/**
 * main.js — 星图：知识圆圈的真实数据 + three.js
 * ------------------------------------------------------------------
 * **结构是一棵树**（用户 2026-09-20 定）：
 *
 *     恒星（知识圆圈）
 *     ├── 大分支（知识点：Spring Boot / Vue）── 首课 ── 次课 …
 *     └── 大分支（…）
 *
 *   · 只有**知识点**连恒星；课程**不**直连恒星
 *   · 课程挂在它所属的分支下，课与课之间按"前置"等关系连（halo.json 的 edges）
 *   · 跨分支的关系（如 Vue 课要调第1课的接口）作为额外的关系线
 * 于是：一条分支一个色相，越往外的课越"新"。
 *
 * 视觉部分（沿用已定的版本，不在此处改）：
 *   恒星 = 柔和光晕（上一版 · 无十字）；课程 = 夜空里的点 + 很细的四芒
 *   深空 = 三层星云 + 银河带 + 远近两层星尘；相机 = 阻尼 + 自由移动
 */
import * as THREE from './vendor/three/three.module.js';
import { orbit, starRadius, mulberry32, spherePoint, layout } from './data-layer.js';

const PREFIX = '../';
const PICK_PX = 20;
const DUR = 1.15;
const DAMP = 0.12;

const D = window.STARMAP_REAL;
const app = document.getElementById('app');
const hud = document.getElementById('hud');
const tip = document.getElementById('tip');
if (!D) { hud.textContent = '没有 window.STARMAP_REAL —— 先跑 node tools/build-starmap.js'; throw new Error('missing STARMAP_REAL'); }

/* ── 取色：星图令牌 → 鲸师令牌 → 兜底 ────────────────────────────────── */
const cssv = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
const firstVar = (names, fb) => { for (const n of names) { const v = cssv(n); if (v) return v; } return fb; };
function toHex(v, fb) {
  const s = String(v || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return '#' + m[1].split('').map((c) => c + c).join('');
  m = /^#([0-9a-f]{6,8})$/i.exec(s);
  return m ? '#' + m[1].slice(0, 6) : fb;
}
const T = (k, fb, ...alt) => toHex(firstVar([`--starmap-${k}`, ...alt], ''), fb);
const COL = {
  void: T('void', '#05070e', '--dsw-alias-bg-base'),
  nebs: [T('nebula-1', '#26398f'), T('nebula-2', '#5f3585'), T('nebula-3', '#176b7a')],
  band: T('band', '#7f96c8'),
  dust: T('dust', '#9fb4d8'),
  haloCore: T('halo-core', '#fff6e2', '--dsw-alias-label-primary'),
  cool: T('star-cool', '#9ec8ff', '--lesson-accent'),
  dim: T('star-dim', '#7c8aa5', '--dsw-alias-label-tertiary'),
  // 规划中暗星（还没生成的下一课）的**专属色**：冰青。
  // 为什么不沿用 dim：**没学过的课本来就是往 dim 里调**（lessonTint lerp 0.68），
  // 再灰一点就与它们无从区分 —— 而课程星的视觉词汇本来就是"一个不带十字的小点"。
  // 2026-09-24 主人定：**同尺寸实心点，靠颜色区分**。
  planned: T('star-planned', '#5fd7e0'),
  link: T('link', '#6f8ac0', '--dsw-alias-border-l3'),
  linkActive: T('link-active', '#ffe066'),
  label: T('label', '#dbe4f5', '--dsw-alias-label-secondary'),
};
const BRANCH = [
  T('branch-1', '#ffc978'),
  T('branch-2', '#7ee0c0'),
  T('branch-3', '#c9a0ff'),
  T('branch-4', '#ff9fb0'),
];
const FONT = `'LanxiJingHei', ${firstVar(['--dsw-font-family'], 'system-ui, -apple-system, "Segoe UI", sans-serif')}`;

/* ── 布局：**在数据层**（starmap/data-layer.js 的 layout()）────────────────
   为什么搬过去：M3 要求"无 WebGL / 打印 / 减动效"时用**同一份坐标**出 SVG。
   坐标留在渲染器里，静态版就只能自己重算一遍 —— 两份坐标迟早会漂。
   data-layer 只依赖几何（不 import three、不碰 DOM），于是 WebGL 版与静态版共用它。
   本文件从此只管"怎么画"，不管"摆在哪"。 */
// 每个圆圈一个恒星色相（多星系必须能区分）。
// ⚠️ 这份清单与课程包冻结表 `assets/circle-bands-data.js` 的 `hues.halo` **同源**：
//    那边是"建新圆圈时按这个序挑未占用的色"的真源（`_title-bands/freeze.mjs` 的 DEFAULT_HALO_HUES），
//    这边是浏览器侧的另一份字面量（课程包侧不做颜色数学）。**前 3 个不许换序** —— 已有圆圈的星色按它。
//    2026-09-24 由 3 扩到 12（D4：容量 7 → 16，第 8 个圈不再建不出来）。
//    判据：`tools/circle-bands.test.mjs` 断言**每个星色都出现在本文件里** —— 只扩一边会红。
const HALO_HUE = [
  COL.haloCore, '#bfe0ff', '#ffd9a8', // ← 原有 3 个（不许换序）
  '#c8f0d8', '#c8ecf4', '#d8c8ff', '#ffc8dc', '#ffeab8',
  '#d8e4c8', '#c8d4ff', '#b8f0e4', '#ffd0c0',
];
const LAYOUT_OPTS = {
  POINT_R: 4.4, LESSON_R0: 2.0, LESSON_STEP: 1.6,
  LESSON_TURN: 0.28, LESSON_SPREAD: 0.95,
  HALO_Y_FLAT: 0.62, HALO_GAP: 30, fovDeg: 45,
  branchHues: BRANCH, haloHues: HALO_HUE, defaultHaloId: 'programming',
};
const LAYOUT = layout(D, LAYOUT_OPTS);
const { halos, pts, nodes, ptById, lessonById, homeHalo, FIT } = LAYOUT;
/* 知识点、前置解析、课程摆放（枝干 / 花簇、越学越高）—— 全在数据层 layout() 里。 */

/* 课程节点、`lessonById` —— 数据层 layout() 建好并返回（上面解构里有）。 */

/* ── 规划中的暗星（`_board/01-鲸师.md:202-206`「地图作为方向标」）─────────────
   载荷 `halos[].points[].planned` = **地图前沿**（下一颗 + 紧随它的支线，至多两颗），
   不是 plan.nodes 全量 —— 其余规划节点与"没规划"一样**不出现在图上**。
   它还没有课页：画成**暗星**，不可点击、双击不导航（绝不指向不存在的课页），
   **悬停**看 title / deliverable / criteria —— 走既有的 tip 面板（showTip 的 'planned' 分支）。
   ⚠️ **"暗"不等于"看不见"**（2026-09-24 真浏览器截图验出来的坑）：课程星的视觉词汇本来就是
   "一个不带十字的小点"，所以暗星**不能**靠"更小更暗"来区分（原先是 size 0.85 / opacity 0.34，
   在那堆点里认不出来）。主人定：**同尺寸实心点，靠颜色区分** —— 用 `COL.planned`（冰青），
   size / opacity 与"没学过的课"一致。理由不只是好看：`01:206` 只让靠**悬停**看信息，
   **学生看不见那颗星，就永远悬停不到它**。改这里请同步改 `tools/starmap.test.mjs` 的 12c 判据。
   位置 = 同一条枝干的下一段（未来那课就长在这）：坐标公式只有数据层 layout() 一份，
   所以这里把暗星伪造成"未来的课"再让 layout() 摆一次位、**只取坐标**（不进 p.lessons、
   不算课数），免得在渲染层再抄一份几何。 */
{
  const pseudo = [];
  for (const h of (D.halos || [])) {
    for (const p of (h.points || [])) {
      const built = (D.lessons || []).filter((l) => l.halo === h.id && l.point === p.id);
      const maxNo = built.reduce((m, l) => Math.max(m, Number(l.number) || 0), 0);
      (Array.isArray(p.planned) ? p.planned : []).forEach((spec, k) => {
        pseudo.push({
          _spec: spec,
          id: `planned:${p.id}/${spec.no}`,
          point: p.id,
          number: maxNo + 1 + k,       // 排在已建课之后 → 占据枝干的下一段
          halo: h.id, title: spec.title || '', label: '', navTitle: '',
          href: '', learned: false,
        });
      });
    }
  }
  if (pseudo.length) {
    const L2 = layout({ halos: D.halos, lessons: [...(D.lessons || []), ...pseudo], edges: [] }, LAYOUT_OPTS);
    for (const n of L2.nodes) {
      if (n.kind !== 'lesson' || !n._spec) continue;
      const spec = n._spec;
      const realPt = ptById.get(n.point);
      if (!realPt) continue;          // 不会发生：planned 就是从这个点的定义来的
      n.kind = 'planned';
      n.pointNode = realPt;
      n.haloNode = realPt.haloNode;
      n.hue = realPt.hue;
      n.size = 1;                     // 与"没学过的课"**同尺寸**（主人定：靠颜色区分，不靠更小更暗）
      n.learned = false;
      n.no = spec.no;
      n.title = spec.title || '';
      n.deliverable = spec.deliverable || '';
      n.criteria = spec.criteria || '';
      n.branch = spec.branch === true;
      n.name = n.title;
      n.label = `${realPt.label ? realPt.label + ' ' : ''}第${spec.no}课 · 规划中`;
      nodes.push(n);
      if (!realPt.plannedNodes) realPt.plannedNodes = [];
      realPt.plannedNodes.push(n);
    }
  }
}

nodes.forEach((n, i) => { n._prog = 0; n._at = n.kind === 'point' ? 0.35 + i * 0.22 : 0.95 + i * 0.16; });

/* ── 渲染器 / 场景 / 相机 ────────────────────────────────────────────── */
const scene = new THREE.Scene();
scene.background = new THREE.Color(COL.void);
scene.fog = new THREE.FogExp2(new THREE.Color(COL.void).getHex(), 0.011);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 800);
const renderer = new THREE.WebGLRenderer({ antialias: true });
// ⚠️ 2026-09-20 试过 DPR 上限 1.5（抄参考规范的性能章节），随限帧一起**撤回**：
//    用户的口径是"性能够就猛猛加" —— 不拿观感换性能。要再压，得先有实测的卡顿证据。
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;

/* ── Bloom（M2 · 手写，不引 addons）──────────────────────────────────────
   为什么手写：vendor 的是 three **r186 核心包**，addons（examples/jsm）不在里面，
   而且它们逐版改内部 API —— 取错版本不是花屏就是黑屏；而本场景是**全加色 sprite**，
   亮部阈值 + 可分离模糊在视觉上与 UnrealBloom 肉眼难分，且阈值/强度/半径全留在自己手里。
   链路：场景 → RT(全分辨率) → 亮部提取(1/2) → 横糊 → 竖糊 → 合成到屏幕。
   ⚠️ 自定义 shader **不会**自动做 sRGB 编码 —— 最后一步必须手动 LinearTosRGB，
      否则整页会偏暗偏浓（这是这套东西最容易翻车的地方）。 */
const BLOOM = {
  threshold: 0.62,      // 远处（整体看）的亮度门槛
  strength: 0.85,       // 远处的强度
  scale: 0.5,           // 光晕扩散范围（同时是性能档：半分辨率）
  // 近处弱、远处强（用户 2026-09-20：镜头一贴近，光晕就把星星罩住了）
  nearDist: 8,          // 离焦点 ≤ 这个距离 = 最近（辉光最弱）
  farDist: 22,          // ≥ 这个距离 = 最远（辉光最强）
  nearScale: 0.26,      // 近处的强度倍率（0.26 × 0.85 ≈ 0.22）
  nearLift: 0.18,       // 近处把阈值抬多少（抬了之后只有星核够亮，光晕自然收小）
};
const BLOOM_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const quadScene = new THREE.Scene();
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quad.frustumCulled = false;
quadScene.add(quad);
const matBright = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null }, uThreshold: { value: BLOOM.threshold } },
  vertexShader: BLOOM_VERT,
  fragmentShader: [
    'uniform sampler2D tSrc; uniform float uThreshold; varying vec2 vUv;',
    'void main(){',
    '  vec3 c = texture2D(tSrc, vUv).rgb;',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.28, l), 1.0);',
    '}',
  ].join('\n'),
  depthTest: false, depthWrite: false,
});
const matBlur = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2(1, 1) } },
  vertexShader: BLOOM_VERT,
  fragmentShader: [
    'uniform sampler2D tSrc; uniform vec2 uDir; uniform vec2 uTexel; varying vec2 vUv;',
    'void main(){',
    '  vec2 o = uDir * uTexel;',
    '  vec3 s = texture2D(tSrc, vUv).rgb * 0.227027;',
    '  s += (texture2D(tSrc, vUv + o * 1.3846).rgb + texture2D(tSrc, vUv - o * 1.3846).rgb) * 0.316216;',
    '  s += (texture2D(tSrc, vUv + o * 3.2308).rgb + texture2D(tSrc, vUv - o * 3.2308).rgb) * 0.070270;',
    '  gl_FragColor = vec4(s, 1.0);',
    '}',
  ].join('\n'),
  depthTest: false, depthWrite: false,
});
const matComp = new THREE.ShaderMaterial({
  uniforms: { tBase: { value: null }, tBloom: { value: null }, uStrength: { value: BLOOM.strength } },
  vertexShader: BLOOM_VERT,
  fragmentShader: [
    'uniform sampler2D tBase; uniform sampler2D tBloom; uniform float uStrength; varying vec2 vUv;',
    'vec3 lin2srgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055, step(vec3(0.0031308), c)); }',
    'void main(){',
    '  vec3 col = texture2D(tBase, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength;',
    '  gl_FragColor = vec4(lin2srgb(col), 1.0);',
    '}',
  ].join('\n'),
  depthTest: false, depthWrite: false,
});
let rtScene = null, rtA = null, rtB = null;
function sizeBloom() {
  const dpr = renderer.getPixelRatio();
  const w = Math.max(2, Math.floor(innerWidth * dpr));
  const h = Math.max(2, Math.floor(innerHeight * dpr));
  const bw = Math.max(2, Math.floor(w * BLOOM.scale));
  const bh = Math.max(2, Math.floor(h * BLOOM.scale));
  const opts = { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false };
  if (!rtScene) {
    rtScene = new THREE.WebGLRenderTarget(w, h, opts);
    rtA = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false });
    rtB = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false });
  } else {
    rtScene.setSize(w, h);
    rtA.setSize(bw, bh);
    rtB.setSize(bw, bh);
  }
  matBlur.uniforms.uTexel.value.set(1 / bw, 1 / bh);
}
sizeBloom();
function blurPass(from, to, dx, dy) {
  quad.material = matBlur;
  matBlur.uniforms.tSrc.value = from.texture;
  matBlur.uniforms.uDir.value.set(dx, dy);
  renderer.setRenderTarget(to);
  renderer.render(quadScene, quadCam);
}
function renderBloom() {
  // ① 场景 → rtScene（线性空间：这一步不做 sRGB 编码）
  renderer.setRenderTarget(rtScene);
  renderer.render(scene, camera);
  // ② 亮部提取 → rtA
  quad.material = matBright;
  matBright.uniforms.tSrc.value = rtScene.texture;
  renderer.setRenderTarget(rtA);
  renderer.render(quadScene, quadCam);
  // ③ 可分离模糊：横糊进 rtB，再竖糊回 rtA
  blurPass(rtA, rtB, 1, 0);
  blurPass(rtB, rtA, 0, 1);
  // ④ 合成到屏幕（**这一步才做 sRGB 编码**）
  //    辉光按"离焦点多远"衰减：贴到某颗星上看时收掉，拉远看整体时给足。
  //    中心视角用 cam.dist（= 到那颗星的距离）；自由视角没有 center，用相机到场景原点的距离兜底。
  const near = center ? cam.dist : camera.position.length();
  const k = Math.min(1, Math.max(0, (near - BLOOM.nearDist) / (BLOOM.farDist - BLOOM.nearDist)));
  matComp.uniforms.uStrength.value = BLOOM.strength * (BLOOM.nearScale + (1 - BLOOM.nearScale) * k);
  matBright.uniforms.uThreshold.value = BLOOM.threshold + (1 - k) * BLOOM.nearLift;
  quad.material = matComp;
  matComp.uniforms.tBase.value = rtScene.texture;
  matComp.uniforms.tBloom.value = rtA.texture;
  renderer.setRenderTarget(null);
  renderer.render(quadScene, quadCam);
}
app.appendChild(renderer.domElement);
const PR = renderer.getPixelRatio();
const canvas = renderer.domElement;

/* ── 点云 shader（星尘/星点的闪烁）───────────────────────────────────── */
const pointMaterials = [];
function makePointMaterial({ breath = 0.3, speed = 1.0, glow = 0.45, sizeK = 260 } = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uBreath: { value: breath }, uSpeed: { value: speed },
      uGlow: { value: glow }, uPixelRatio: { value: PR }, uSizeK: { value: sizeK },
    },
    vertexShader: /* glsl */`
      attribute float aSize; attribute float aPhase; attribute vec3 aColor;
      attribute float aProgress; attribute float aHighlight;
      uniform float uTime, uBreath, uSpeed, uPixelRatio, uSizeK;
      varying vec3 vColor; varying float vAlpha; varying float vHot;
      void main() {
        vec3 p = mix(vec3(0.0), position, aProgress);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float breathe = 1.0 + uBreath * sin(uTime * uSpeed + aPhase);
        float grow = 0.2 + 0.8 * aProgress;
        gl_PointSize = aSize * breathe * grow * uPixelRatio * (uSizeK / max(0.001, -mv.z));
        gl_Position = projectionMatrix * mv;
        vColor = aColor + vec3(0.4) * aHighlight;
        vAlpha = clamp(0.25 + 0.75 * aProgress, 0.0, 1.0);
        vHot = smoothstep(0.10, 0.30, aProgress) * (1.0 - smoothstep(0.40, 0.95, aProgress));
      }`,
    fragmentShader: /* glsl */`
      uniform float uGlow;
      varying vec3 vColor; varying float vAlpha; varying float vHot;
      void main() {
        float r = length(gl_PointCoord - vec2(0.5));
        if (r > 0.5) discard;
        float core = smoothstep(0.5, 0.05, r);
        float halo = smoothstep(0.5, 0.0, r) * uGlow;
        vec3 c = mix(vColor, vec3(1.0), vHot * 0.85);
        gl_FragColor = vec4(c, (core + halo) * vAlpha);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  pointMaterials.push(m);
  return m;
}

function dustCloud(count, fill, matOpts) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3), size = new Float32Array(count), phase = new Float32Array(count);
  const color = new Float32Array(count * 3), prog = new Float32Array(count).fill(1), hl = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const { p, s, ph, c } = fill(i);
    pos.set([p.x, p.y, p.z], i * 3);
    size[i] = s; phase[i] = ph;
    const col = new THREE.Color(c);
    color.set([col.r, col.g, col.b], i * 3);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  g.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  g.setAttribute('aProgress', new THREE.BufferAttribute(prog, 1));
  g.setAttribute('aHighlight', new THREE.BufferAttribute(hl, 1));
  scene.add(new THREE.Points(g, makePointMaterial(matOpts)));
}

/* ── 深空 ─────────────────────────────────────────────────────────────── */
function nebulaTexture(hex) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const col = new THREE.Color(hex);
  const rgb = `${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0}`;
  const rnd = mulberry32(7717);
  for (let k = 0; k < 30; k++) {
    // 极坐标取样：中心密、外围疏，云才有形状（原来是均匀撒在方格里，容易铺满边角）
    const a = rnd() * Math.PI * 2;
    const rad = Math.sqrt(rnd()) * 84;
    const x = 128 + Math.cos(a) * rad, y = 128 + Math.sin(a) * rad;
    const r = 24 + rnd() * 62;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${0.10 + rnd() * 0.14})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  }
  // ⚠️ 关键：精灵（Sprite）是**方的**。不遮罩的话，靠近边缘的云会把画布边界显出来 ——
  //    背景里那几块"若隐若现的正方体"就是这么来的。用 destination-in 把 alpha 抹成圆形。
  const fade = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  fade.addColorStop(0, 'rgba(0,0,0,1)');
  fade.addColorStop(0.55, 'rgba(0,0,0,0.62)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, 256, 256);
  ctx.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const nebulae = [];
[[COL.nebs[0], 50, 0.55, -8], [COL.nebs[1], 40, -1.9, 6], [COL.nebs[2], 34, 2.6, -4]].forEach(([hex, scale, ang, y], i) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: nebulaTexture(hex), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: i === 0 ? 0.85 : 0.62,
  }));
  s.position.set(Math.cos(ang) * 44, y, Math.sin(ang) * 44);
  s.scale.setScalar(scale);
  scene.add(s);
  nebulae.push(s);
});
{
  const rnd = mulberry32(4242);
  dustCloud(1800, () => {
    const r = 18 + rnd() * 95, th = rnd() * Math.PI * 2;
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    return { p: { x, y: x * 0.42 + (rnd() - 0.5) * 7, z }, s: 0.28 + rnd() * 0.5, ph: rnd() * 6.283, c: COL.band };
  }, { breath: 0.22, speed: 0.5, glow: 0.25, sizeK: 210 });
}
[[1400, 26, 70, 0.9, 0.32], [600, 70, 150, 1.5, 0.5]].forEach(([N, rMin, rMax, sMax, alpha]) => {
  const rnd = mulberry32(20260920 + rMin);
  dustCloud(N, () => {
    const r = rMin + rnd() * (rMax - rMin);
    const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
    return {
      p: { x: r * Math.sin(ph) * Math.cos(th), y: r * Math.cos(ph) * 0.75, z: r * Math.sin(ph) * Math.sin(th) },
      s: 0.2 + rnd() * sMax, ph: rnd() * 6.283, c: COL.dust,
    };
  }, { breath: 0.4, speed: 0.6, glow: alpha, sizeK: 230 });
});

/* ── 贴图 ─────────────────────────────────────────────────────────────── */
function glowTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  stops.forEach(([at, col, a]) => g.addColorStop(at, `rgba(${col},${a})`));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function flareTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const hg = x.createLinearGradient(0, 0, S, 0);
  hg.addColorStop(0, 'rgba(255,255,255,0)'); hg.addColorStop(0.5, 'rgba(255,255,255,0.85)'); hg.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = hg; x.fillRect(0, S / 2 - 2, S, 4);
  const vg = x.createLinearGradient(0, 0, 0, S);
  vg.addColorStop(0, 'rgba(255,255,255,0)'); vg.addColorStop(0.5, 'rgba(255,255,255,0.85)'); vg.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = vg; x.fillRect(S / 2 - 2, 0, 4, S);
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, 24);
  g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(255,255,255,0.22)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const rgbOf = (hex) => { const c = new THREE.Color(hex); return `${c.r * 255 | 0},${c.g * 255 | 0},${c.b * 255 | 0}`; };
/* ⚠️ 已废弃（留着以备对照）：用 canvas 贴图做 3D 标签 —— 实测必糊，
   改成下面的 DOM 覆盖层（`drawLabel`）。原因：134px 的图缩到屏幕 ~25px，细笔画没救。 */
function labelSprite(text, sub) {
  // 高清贴图：画布按 2.6 倍画，再缩到屏幕 —— 等于 2.6 倍超采样（实测仍糊）。
  const pad = 20, fs = 88, fs2 = 52;
  const c = document.createElement('canvas');
  const mx = c.getContext('2d');
  mx.font = `600 ${fs}px ${FONT}`;
  const w1 = mx.measureText(text).width;
  mx.font = `400 ${fs2}px ${FONT}`;
  const w2 = sub ? mx.measureText(sub).width : 0;
  c.width = Math.ceil(Math.max(w1, w2) + pad * 2);
  c.height = sub ? fs + fs2 + pad * 2 + 6 : fs + pad * 2;
  const x = c.getContext('2d');
  x.textBaseline = 'top';
  x.shadowColor = 'rgba(0,0,0,0.85)'; x.shadowBlur = 10;
  x.fillStyle = COL.label;
  x.font = `600 ${fs}px ${FONT}`;
  x.fillText(text, pad, pad);
  if (sub) {
    x.shadowBlur = 6;
    x.globalAlpha = 0.72;
    x.font = `400 ${fs2}px ${FONT}`;
    x.fillText(sub, pad, pad + fs + 6);
  }
  const t = new THREE.CanvasTexture(c);
  if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;      // 缩小时走 mipmap，不闪
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  if (renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false }));
  sp.userData.aspect = c.width / c.height;
  return sp;
}

/* 核星（`h._starNodes`）已由数据层的 layout() 建好 —— 这里只负责画它。 */

/* ── 前置航道：弧线 + 虚线 + 亮黄，只在选中时出现 ───────────────────────
   为什么是弧线而不是直线：直线会从恒星/别的星身上穿过去；二次贝塞尔把控制点
   **抬离恒星平面**，绕开中间的东西。虚线 = "这是依赖，不是父子"。
   一个知识点有几条前置就画几条 —— 这就是"两个前置 = 两条上游线"。 */
const ROAD_SEG = 28, ROAD_MAX = 8;
const roadLines = [];
for (let i = 0; i < ROAD_MAX; i++) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ROAD_SEG * 3), 3));
  const l = new THREE.Line(g, new THREE.LineDashedMaterial({
    color: new THREE.Color(COL.linkActive || '#ffe066'),
    dashSize: 0.34, gapSize: 0.24, transparent: true, opacity: 0.9, depthWrite: false,
  }));
  l.visible = false;
  l.frustumCulled = false;
  scene.add(l);
  roadLines.push(l);
}
function updateRoads() {
  for (const l of roadLines) l.visible = false;
  const cur = pinned || hovered;
  if (!cur) return;
  const pt = cur.kind === 'point' ? cur : (cur.kind === 'lesson' ? cur.pointNode : null);
  if (!pt || !pt.reqNodes || !pt.reqNodes.length) return;
  pt.reqNodes.forEach((up, i) => {
    const l = roadLines[i];
    if (!l) return;
    if (isHiddenNode(up)) return;                            // #4：前置在隐藏的圆圈里 → 这条航道也不画
    const a = pt.pos, b = up.pos;
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2 + d * 0.36;          // 控制点抬离平面 → 绕开中间
    const cz = (a.z + b.z) / 2;
    const pos = l.geometry.attributes.position;
    for (let k = 0; k < ROAD_SEG; k++) {
      const t = k / (ROAD_SEG - 1), u = 1 - t;
      pos.setXYZ(k,
        u * u * a.x + 2 * u * t * cx + t * t * b.x,
        u * u * a.y + 2 * u * t * cy + t * t * b.y,
        u * u * a.z + 2 * u * t * cz + t * t * b.z);
    }
    l.geometry.attributes.position.needsUpdate = true;
    l.computeLineDistances();                        // 虚线必须算距离（在 **Line 上**算，不是 geometry）
    l.visible = true;
  });
}

/* 每个圆圈 / 每条分支的**半径**：离中心最远的那个节点。
   用它把镜头距离**推出来**，而不是写死一个常数 ——
   参考规范说"dist ≈ R×1.62 刚好填满、R×2.1 就空洞小气"，但那个 1.62 是配**宽 fov** 的；
   我们是 fov 45°（半角 22.5°，tan = 0.4142），等价系数是 1/tan(22.5°) ≈ **2.41**。
   照抄 1.62 会把最外圈的课切出画面。留 5% 边。 */
/* FIT（镜头"刚好装满"的系数 ≈ 2.29）与每个圆圈的 radius / 每条分支的 extent，
   现在都由数据层 layout() 算好返回（推导写在 starmap/data-layer.js 那段注释里）。 */

/* 点得到的东西：圆圈（质心）+ 每颗核星（点核星 = 选中那个圆圈）+ 知识点 + 课程 */
const pickNodes = [...nodes, ...halos.flatMap((h) => h._starNodes || [])];

/* ── 每颗核星的视觉（柔和光晕版 · 十字光芒试过已撤）──────────────────── */
const coolRGB = rgbOf(COL.cool);
const haloSets = [];
halos.forEach((h) => {
  (h._starNodes || []).forEach((coreNode, ci) => {
    const hr = rgbOf(coreNode.hue);
    const A = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture([[0, hr, 0.95], [0.18, hr, 0.42], [0.5, coolRGB, 0.10], [1, coolRGB, 0]]),
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    A.position.set(coreNode.pos.x, coreNode.pos.y, coreNode.pos.z);
    A.scale.setScalar(4.6);
    scene.add(A);
    const B = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture([[0, coolRGB, 0.30], [0.45, coolRGB, 0.10], [1, coolRGB, 0]]),
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.7,
    }));
    B.position.set(coreNode.pos.x, coreNode.pos.y, coreNode.pos.z);
    B.scale.setScalar(11);
    scene.add(B);
    const g = new THREE.BufferGeometry();
    const cc = new THREE.Color(coreNode.hue);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([coreNode.pos.x, coreNode.pos.y, coreNode.pos.z]), 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array([1.8]), 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array([h.idx * 1.3 + ci * 2.1]), 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array([cc.r, cc.g, cc.b]), 3));
    g.setAttribute('aProgress', new THREE.BufferAttribute(new Float32Array([1]), 1));
    g.setAttribute('aHighlight', new THREE.BufferAttribute(new Float32Array([0]), 1));
    const corePts = new THREE.Points(g, makePointMaterial({ breath: 0.09, speed: 0.8, glow: 0.7, sizeK: 300 }));
    scene.add(corePts);
    coreNode._glowA = A;
    coreNode._glowB = B;
    coreNode._corePts = corePts;
    haloSets.push({ A, B });
  });
});

/* 标签是 canvas 贴图，**必须等 webfont 加载完再画** ——
   不等的话画出来的是系统字体，看起来像"换了字体却没生效"。 */
async function ensureFont() {
  try {
    if (document.fonts && document.fonts.load) {
      await document.fonts.load(`600 88px 'LanxiJingHei'`);
      await document.fonts.load(`400 52px 'LanxiJingHei'`);
      await document.fonts.ready;
    }
  } catch { /* 拿不到就用系统字体，不阻断渲染 */ }
}
/* 只预热，**不能 await**：await 会把事件监听与主循环都挡在字体后面 ——
   字体没到就点不动、悬停无反应。标签现在是 DOM 文本，字体就绪后浏览器自己会换。 */
ensureFont();

/* ── 树的节点：知识点（大分支）+ 课程（小星）──────────────────────────── */
const starTex = glowTexture([[0, '255,255,255', 1], [0.22, '255,255,255', 0.55], [0.5, '255,255,255', 0.14], [1, '255,255,255', 0]]);
/* 点亮的星要多一层「彩色柔光晕」（参考图里那些粉/金/蓝紫的亮星就是这个），
   未点亮的星不配这层 —— 亮不亮全靠它区分。 */
const softHaloTex = glowTexture([[0, '255,255,255', 0.95], [0.30, '255,255,255', 0.34], [0.62, '255,255,255', 0.08], [1, '255,255,255', 0]]);
const flareTex = flareTexture();

function lessonTint(hue, learned) {
  const c = new THREE.Color(hue);
  if (!learned) c.lerp(new THREE.Color(COL.dim), 0.68);   // 没学过 → 往暗灰里调
  return c;
}
/* 课程星的颜色。#7 异常是**全图唯一的高饱和**（红 / 黄），其余一律低饱和 ——
   口诀抄自《Cosmos 血缘星图规范》："白光为主，库色轻点，红黄专坏"。 */
const FLAG_RED = '#ff3b4e', FLAG_YELLOW = '#ffd633';
function lessonColor(n) {
  if (n.flag === 'red') return new THREE.Color(FLAG_RED);
  if (n.flag === 'yellow') return new THREE.Color(FLAG_YELLOW);
  return lessonTint(n.hue, n.learned);
}
nodes.forEach((n) => {
  const isPoint = n.kind === 'point';
  // 呼吸相位：由 id 哈希出一个稳定的相位 —— **各星不同步**才有"活"的感觉，
  // 全体同相位会变成整屏一起涨缩，像闹鬼。（不用随机：同一个 id 永远同一个相位）
  n._ph = [...String(n.id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7) / 997 * 6.283;
  // #5 大小由数据驱动（本课名词数，对数压缩后落在 0.62~1.12），再叠一层"学过 / 没学过"
  const base = (isPoint ? 0.95 : (n.learned ? 0.50 : 0.26)) * (n.size || 1);
  const col = isPoint ? new THREE.Color(n.hue) : (n.kind === 'planned' ? new THREE.Color(COL.planned) : lessonColor(n));
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: starTex, color: col, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
    // #6 亮度分层标定：圆圈间标定过的 bright 作用在**课程星**上（异常色不受压制）
    // 暗星**不压暗**：它与"没学过的课"同一个透明度（0.5），区别只在颜色（见 COL.planned）。
    // 曾经写成 0.34 —— 真浏览器截图验出来"学生根本找不到那颗星"，而 01:206 只让靠悬停看信息，
    // 看不见就永远悬停不到。别改回去。
    opacity: isPoint ? 1 : (n.learned ? 1 : 0.5) * (n.bright || 1),
  }));
  sp.position.set(n.pos.x, n.pos.y, n.pos.z);
  sp.userData.base = base;
  sp.scale.setScalar(0);
  scene.add(sp);
  n._sprite = sp;

  const fl = new THREE.Sprite(new THREE.SpriteMaterial({
    map: flareTex, color: col, transparent: true, depthWrite: false,
    // 课程**不配十字**（参考图里亮星就是圆点 + 柔晕；课程一多，十字会扎眼）；
    // 只有大分支留一道减半强度的细十字 —— 它本来就该比课程显眼。
    // **例外：带异常标记的课也配一道** —— 远处一眼就能看出"哪几课有麻烦"。
    blending: THREE.AdditiveBlending, opacity: isPoint ? 0.18 : (n.flag ? 0.22 : 0),
  }));
  fl.position.copy(sp.position);
  fl.userData.base = isPoint ? 2.6 : 0.95;
  fl.material.rotation = n.idx !== undefined ? n.idx * 0.6 : (n.number || 0) * 0.6;
  fl.scale.setScalar(0);
  scene.add(fl);
  n._flare = fl;

  const gl = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softHaloTex, color: col, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0,
  }));
  gl.position.copy(sp.position);
  gl.userData.base = isPoint ? 2.4 : 1.8;
  gl.scale.setScalar(0);
  scene.add(gl);
  n._glow = gl;

});
/* 选中环 = 锁定瞄准具：**四段圆弧（留口）+ 里面一个完整的细圈**，色号用 DSH 淡蓝，
   5 秒转一圈（慢，不抢视线）。贴图一次性画好，靠 material.rotation 转。 */
const reticleTex = (() => {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const CX = S / 2, CY = S / 2, R = 100;
  x.strokeStyle = 'rgba(255,255,255,1)';
  x.lineCap = 'round';
  x.lineWidth = 3.5;                                 // 细一点：原来 7，在屏幕上一圈太粗
  for (let i = 0; i < 4; i++) {                     // 四段弧，每段 46°，口 44°
    const a0 = i * (Math.PI / 2) + (44 * Math.PI / 180) / 2;
    x.beginPath();
    x.arc(CX, CY, R, a0, a0 + 46 * Math.PI / 180);
    x.stroke();
  }
  x.lineWidth = 1.8;                                 // 内圈更细
  x.beginPath();                                     // 里面那条完整的圈
  x.arc(CX, CY, R - 26, 0, Math.PI * 2);
  x.stroke();
  const t = new THREE.CanvasTexture(c);
  if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const hoverRing = new THREE.Sprite(new THREE.SpriteMaterial({
  map: reticleTex, color: new THREE.Color(COL.cool), transparent: true, depthWrite: false, depthTest: false,
  blending: THREE.AdditiveBlending, opacity: 0.9,
}));
hoverRing.scale.setScalar(0);
scene.add(hoverRing);

/* 3D 标签 = **DOM 覆盖层**（同一时刻最多一个）：真文字，任意缩放都锐利。
   canvas 贴图那版被否：一张 134px 的图缩到屏幕上约 25px，细笔画必糊，
   提高贴图分辨率也治不了 —— 只能换做法。 */
const $hlabel = document.getElementById('hlabel');
const $lead = document.getElementById('lead');
const $leadLine = $lead.querySelector('line');
let labelAnchor = null;      // 标签占用的屏幕矩形（引线起点）
let labelScreen = null;      // 节点的屏幕坐标（引线终点）
function drawLabel(focus, sp) {
  const isHalo = focus.kind === 'halo';
  const isPoint = focus.kind === 'point';
  const name = isHalo ? focus.name : (isPoint ? focus.name : focus.title);
  const sub = isHalo ? '知识圆圈' : (isPoint ? '知识点' : focus.label);
  const key = `${name}|${sub}`;
  if ($hlabel.dataset.key !== key) {
    $hlabel.innerHTML = `<div class="hlabel__name">${name}</div><div class="hlabel__sub">${sub}</div>`;
    $hlabel.dataset.key = key;
  }
  $hlabel.style.display = 'block';
  const w = $hlabel.offsetWidth, h = $hlabel.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - w - 8, sp.x + 16));
  const top = Math.max(8, Math.min(innerHeight - h - 8, sp.y - h - 12));
  $hlabel.style.left = `${left}px`;
  $hlabel.style.top = `${top}px`;
  labelAnchor = { x: left, y: top, w, h };
  labelScreen = sp;
}

/* ── 连线：恒星→大分支 · 大分支→首课 · 课→课（用关系线，避免重复画）── */
function lineSegments(pairs, color, opacity) {
  if (!pairs.length) return null;
  const p = new Float32Array(pairs.length * 6);
  pairs.forEach(([a, b], i) => p.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const mesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color: new THREE.Color(color), transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(mesh);
  return mesh;
}
const trunkPairs = pts.map((p) => [{ x: 0, y: 0, z: 0 }, p.pos]);                       // 恒星 → 大分支
pts.forEach((p) => { if (p.lessons.length) trunkPairs.push([p.pos, p.lessons[0].pos]); }); // 大分支 → 首课
const explicit = new Set((D.edges || []).map((e) => `${e.from}>${e.to}`));
pts.forEach((p) => {
  for (let k = 1; k < p.lessons.length; k++) {
    const a = p.lessons[k - 1], b = p.lessons[k];
    if (!explicit.has(`${a.id}>${b.id}`)) trunkPairs.push([a.pos, b.pos]);
  }
});
/* 连线：**默认全隐**（2026-09-20 用户：线多了观感差）。只有选中的那颗星才画出它的"上下"连线。 */
const trunkLines = lineSegments(trunkPairs, COL.link, 0.42);
const relPairs = (D.edges || [])
  .map((e) => { const a = lessonById.get(e.from), b = lessonById.get(e.to); return a && b ? [a.pos, b.pos] : null; })
  .filter(Boolean);
const relLines = lineSegments(relPairs, COL.cool, 0.34);
if (trunkLines) trunkLines.visible = false;
if (relLines) relLines.visible = false;

const ACTIVE_MAX = 24;
const actPos = new Float32Array(ACTIVE_MAX * 6);
const actGeo = new THREE.BufferGeometry();
actGeo.setAttribute('position', new THREE.BufferAttribute(actPos, 3).setUsage(THREE.DynamicDrawUsage));
actGeo.setDrawRange(0, 0);
const activeLines = new THREE.LineSegments(actGeo, new THREE.LineBasicMaterial({
  color: new THREE.Color(COL.linkActive), transparent: true, opacity: 0.85,
  depthWrite: false, blending: THREE.AdditiveBlending,
}));
scene.add(activeLines);

/* 悬停某根线时：**只加粗约 20%** + **液态流动**。
   走过的弯路：先用「10 颗离散光点」做流动 → 一格一格跳，很闪（用户："太闪了"）。
   正确做法：用一根**细圆柱当线**（WebGL 的 linewidth 被驱动钳死成 1px，改不动），
   圆柱的 uv.y 正好沿轴向 0→1 → 在 shader 里画一道**连续、缓慢行进**的明暗波，
   叠一道更慢的次波让波形不呆板。方向：从选中的星 → 那一端。 */
const thickLine = new THREE.Mesh(
  new THREE.CylinderGeometry(1, 1, 1, 6, 1, true),
  new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(COL.linkQuiet) } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float w1 = 0.5 + 0.5 * sin(6.28318 * (vUv.y * 1.15 - uTime * 0.16));
        float w2 = 0.5 + 0.5 * sin(6.28318 * (vUv.y * 0.55 - uTime * 0.07) + 1.7);
        float f = 0.20 + 0.58 * pow(w1, 1.7) + 0.16 * w2;   // 缓起缓落 → 静
        gl_FragColor = vec4(uColor, f);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }),
);
thickLine.visible = false;
scene.add(thickLine);
let hoverLineIdx = -1;
const _segDir = new THREE.Vector3(), _yAxis = new THREE.Vector3(0, 1, 0);
function showHoverLine() {
  const seg = hoverLineIdx >= 0 ? activeSegs[hoverLineIdx] : null;
  if (!seg) { thickLine.visible = false; return; }
  const a = seg.a, b = seg.b;
  _segDir.set(b.x - a.x, b.y - a.y, b.z - a.z);
  const len = _segDir.length() || 0.001;
  thickLine.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  thickLine.quaternion.setFromUnitVectors(_yAxis, _segDir.clone().normalize());
  // 屏幕恒定宽度 ×1.2（用户定的"悬停只加粗 20%"）—— 固定半径在远近之间会从看不见变成柱子
  const rr = tubeRadius(camera.position.distanceTo(thickLine.position), LINE_PX) * 1.2;
  thickLine.scale.set(rr, len, rr);
  thickLine.visible = true;
  thickLine.material.uniforms.uTime.value = clockT;
}
const posOf = (n) => n.pos;
/** 上游：前置课；已是首课则回到它所属的大分支；分支的上游是恒星 */
function upOf(n) {
  if (!n || n.kind === 'halo') return null;
  if (n.kind === 'point') return n.haloNode;
  for (const e of D.edges || []) if (e.to === n.id) { const p = lessonById.get(e.from); if (p) return p; }
  return n.pointNode;
}
/** 下游：以它为前置的下一课；分支节点则指向它的首课；恒星指向第一条分支 */
function downOf(n) {
  if (!n) return null;
  if (n.kind === 'halo') return n.points[0] || null;
  if (n.kind === 'point') return n.lessons[0] || null;
  for (const e of D.edges || []) if (e.from === n.id) { const q = lessonById.get(e.to); if (q) return q; }
  return null;
}
let activeSegs = [];          // 当前画出来的线段：[{ a, b, target }] —— 点线即切到 target

/* 常驻的上下连线：**必须有真 3D 圆管**。
   为什么：WebGL 的 linewidth 被平台钳死成 1px，上面那根 LineSegments 在深空 + Bloom 下
   几乎看不见（用户反馈"像完全隐藏"）。这里给每段配一根圆柱 —— 1px 实线当**芯**、圆管当**体**。
   半径关系沿用用户定的规矩：常驻 = 基准线宽，悬停 = **+20%** + 液态流动。 */
const ACTIVE_TUBE_R = 0.0166;      // 兜底值（正常走 tubeRadius 的屏幕恒定换算）
const activeTubes = [];
for (let i = 0; i < ACTIVE_MAX; i++) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 6, 1, true),
    new THREE.MeshBasicMaterial({
      // **和虚线弧（前置航道）同一套呈现**：同一个色号 + **平涂不加色**。
      // 之前用 AdditiveBlending 是"明黄刺眼"的真因 —— 观感差在呈现，不在色号。
      color: new THREE.Color(COL.linkActive), transparent: true, opacity: 0.45,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  m.visible = false;
  m.frustumCulled = false;
  scene.add(m);
  activeTubes.push(m);
}
/** 想让线在屏幕上看起来约 `px` 宽时，世界半径该取多少（**屏幕恒定宽度**）。
    不做这个换算的话，固定半径会随视距从"看不见"变到"一根柱子" —— 我第一版就栽在这。 */
function tubeRadius(d, px) {
  return px * d * Math.tan((camera.fov * Math.PI / 180) / 2) / innerHeight;
}
const LINE_PX = 3.2;               // 常驻线的屏幕宽度（悬停 = ×1.2，即用户定的 +20%）
/** 把常驻圆管摆到当前线段上（与悬停管同一套算法：中点 + 朝向 + 按长度缩放） */
function placeActiveTubes() {
  activeSegs.forEach((s, i) => {
    const m = activeTubes[i];
    if (!m) return;
    _segDir.set(s.b.x - s.a.x, s.b.y - s.a.y, s.b.z - s.a.z);
    const len = _segDir.length() || 0.001;
    m.position.set((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, (s.a.z + s.b.z) / 2);
    m.quaternion.setFromUnitVectors(_yAxis, _segDir.clone().normalize());
    const rr = tubeRadius(camera.position.distanceTo(m.position), LINE_PX);
    m.scale.set(rr, len, rr);
    m.visible = true;
  });
  for (let i = activeSegs.length; i < activeTubes.length; i++) activeTubes[i].visible = false;
}
function updateActiveLines(syncTree = true) {
  // #4 兜底：选中的东西被隐藏了 → 不画线（正常情况下 setHidden 会把 pinned 清掉，这里是双保险）
  if (isHiddenNode(pinned) || isHiddenNode(hovered)) {
    actGeo.setDrawRange(0, 0);
    activeSegs = [];
    placeActiveTubes();
    for (const l of roadLines) l.visible = false;
    if (syncTree) syncTreeActive();
    return;
  }
  const n = pinned || hovered;
  let k = 0;
  activeSegs = [];
  if (n) {
    const a = posOf(n);
    for (const t of [upOf(n), downOf(n)]) {
      if (!t || k >= ACTIVE_MAX) continue;
      const b = posOf(t);
      actPos.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6);
      activeSegs.push({ a, b, target: t });
      k++;
    }
  }
  actGeo.setDrawRange(0, k * 2);
  actGeo.attributes.position.needsUpdate = true;
  placeActiveTubes();               // 常驻圆管跟着同一批线段摆好
  updateRoads();                    // 前置航道与上下连线同一时机重算
  if (syncTree) syncTreeActive();
}
/** 点到线段的最短距离（屏幕像素）—— 用来让"点线切换"能点中 */
function distToSeg(px, py, A, B) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - A.x) * dx + (py - A.y) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (A.x + t * dx), py - (A.y + t * dy));
}
function pickLine(px, py) {
  for (let i = 0; i < activeSegs.length; i++) {
    const s = activeSegs[i];
    const A = project(s.a), B = project(s.b);
    if (!A || !B) continue;
    if (distToSeg(px, py, A, B) < 11) return { target: s.target, index: i };
  }
  return null;
}

/* ── 相机：两种模式（用户 2026-09-20 定）────────────────────────────────
   中心视角（有中心）：左拖绕中心**公转**，相机始终看向中心；滚轮靠近/远离中心
   自由视角（无中心）：左拖只改朝向（**环顾**），位置不动；靠右键/WASD 平移
   自由视角下**点击恒星 → 把视角中心固定为它**（回到中心视角）；Esc / 双击空白解除 */
const cam = { theta: 0.7, phi: 0.92, dist: homeHalo.radius * FIT };
const goal = { theta: 0.7, phi: 0.92, dist: homeHalo.radius * FIT };
let center = null;                        // null = 自由视角；Vector3 = 中心视角的中心
let centerName = '知识圆圈';
const goalCenter = new THREE.Vector3();   // 中心视角：中心要去哪

/* ── 镜头飞行（M2）──────────────────────────────────────────────────────
   受令的移动（点星 / ↑↓ / 深链 / 复位）走一条**定时缓动**的路径，而不是指数逼近 ——
   指数逼近永远"慢慢飘过去"，没有起承转合。路径在 (theta, phi, dist) 空间插值，
   中途把 dist **拉远一点**（弓起来）：既不直直穿过星场，也有"拉远—掠过—推近"的读感。
   任何拖拽 / WASD / 滚轮**立刻取消** —— 人要有否决权。
   用 performance.now() 而不是 clockT：这两段代码相隔很远，少一个跨段依赖就少一个坑。 */
let flight = null;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function flyTo() {
  const dTheta = Math.abs(goal.theta - cam.theta);
  const dPhi = Math.abs(goal.phi - cam.phi);
  const dDist = Math.abs(goal.dist - cam.dist);
  // 飞多久由"要转多少、要拉多远"决定：小挪一下 0.5 秒，大跨度的 1.4 秒封顶
  const dur = Math.max(0.5, Math.min(1.4, 0.35 + dTheta * 0.45 + dPhi * 0.35 + dDist * 0.012));
  flight = {
    t0: performance.now(),
    dur,
    from: { theta: cam.theta, phi: cam.phi, dist: cam.dist },
    to: { theta: goal.theta, phi: goal.phi, dist: goal.dist },
    fromCenter: center ? center.clone() : null,
    arc: Math.min(5, Math.max(1.2, dDist * 0.1)),   // 弓形高度
  };
}
function cancelFlight() { flight = null; }
function stepFlight() {
  if (!flight) return false;
  const k = Math.min(1, (performance.now() - flight.t0) / (flight.dur * 1000));
  const e = easeInOut(k);
  cam.theta = flight.from.theta + (flight.to.theta - flight.from.theta) * e;
  cam.phi = flight.from.phi + (flight.to.phi - flight.from.phi) * e;
  cam.dist = flight.from.dist + (flight.to.dist - flight.from.dist) * e
    + Math.sin(Math.PI * k) * flight.arc;          // 弓形：两头归零，中间最远
  if (center && flight.fromCenter) center.lerpVectors(flight.fromCenter, goalCenter, e);
  if (k >= 1) flight = null;
  return true;
}
const camPos = new THREE.Vector3();       // 自由视角：相机在哪
const goalCamPos = new THREE.Vector3();
const _right = new THREE.Vector3(), _up = new THREE.Vector3(), _fwd = new THREE.Vector3(), _z = new THREE.Vector3();
function camBasis() {
  camera.matrixWorld.extractBasis(_right, _up, _z);
  _fwd.set(-_right.z, 0, _right.x);       // 相机的水平朝前方向
  if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
  _fwd.normalize();
  return { right: _right, up: _up, fwd: _fwd };
}
function applyCam() {
  const dx = Math.sin(cam.phi) * Math.cos(cam.theta);
  const dy = Math.cos(cam.phi);
  const dz = Math.sin(cam.phi) * Math.sin(cam.theta);
  if (center) {
    camera.position.set(center.x + dx * cam.dist, center.y + dy * cam.dist, center.z + dz * cam.dist);
    camera.lookAt(center);
  } else {
    camera.position.copy(camPos);
    camera.lookAt(camPos.x - dx, camPos.y - dy, camPos.z - dz);   // 沿 -dir 看：与中心视角的朝向连续
  }
}
let hudExtra = '左拖旋转 · 右键平移 · WASD 移动 · ↑↓ 切换课程 · 滚轮缩放';
function modeText() { return center ? `中心视角：${centerName}` : '自由视角'; }
const $modeBtn = document.getElementById('modebtn');
const $hudExtra = document.getElementById('hudextra');
function refreshHud(extra) {
  if (extra !== undefined) hudExtra = extra;
  if ($modeBtn) $modeBtn.textContent = modeText();
  if ($hudExtra) $hudExtra.textContent = ` · ${hudExtra}`;
}
/* 模式开关：点一下在「中心视角 / 自由视角」之间切（Esc 也会切，但浏览器可能吃掉 Esc）*/
if ($modeBtn) {
  $modeBtn.addEventListener('click', () => {
    if (center) releaseCenter(); else setCenter(0, 0, 0, '知识圆圈');
  });
}
function setCenter(x, y, z, name, keepDist) {
  center = new THREE.Vector3(x, y, z);
  centerName = name || '知识圆圈';
  goalCenter.copy(center);
  // ⚠️ 只有"没有明确视距目标"时才用当前距离兜底。
  //    否则会把 selectNode 按内容算好的 goal.dist 覆盖掉 —— 这条曾经让 FIT 变成死代码。
  if (!keepDist) goal.dist = Math.max(6, camera.position.distanceTo(center));
  refreshHud(`视角中心 → ${centerName}`);
  flyTo();
}
function releaseCenter() {
  if (!center) return;
  camPos.copy(camera.position);          // 就地接管当前位置：解除中心时画面不跳
  goalCamPos.copy(camPos);
  center = null;
  refreshHud('左拖环顾 · 右键 / WASD 平移 · 点恒星可重新固定中心');
}
const keys = new Set();   // 键位集合：resetView() 会用它，声明必须在调用之前（否则 TDZ 直接崩）
function resetView() {
  goal.theta = 0.7; goal.phi = 0.92; goal.dist = homeHalo.radius * FIT;
  const home = homeHalo;
  center = new THREE.Vector3(home.pos.x, home.pos.y, home.pos.z);
  centerName = home.name;
  goalCenter.copy(center);
  flyTo();                                          // ← 必须放在 center 赋好之后：飞行要拿它当起点
  keys.clear();
  refreshHud(`已回到「${home.name}」`);
}
resetView();
applyCam();

/* ── 命中：恒星 / 知识点 / 课程，取 20px 内最近 ─────────────────────── */
const v3 = new THREE.Vector3();
function project(p) {
  v3.set(p.x, p.y, p.z).project(camera);
  if (v3.z > 1) return null;
  return { x: (v3.x * 0.5 + 0.5) * canvas.clientWidth, y: (-v3.y * 0.5 + 0.5) * canvas.clientHeight };
}
function pick(px, py) {
  let best = null, bestD = PICK_PX;
  for (const n of pickNodes) {
    if (n._prog !== undefined && n._prog < 0.35) continue;   // 还没长出来的别抢命中
    if (isHiddenNode(n)) continue;                           // #4：隐藏的圆圈**不许被点到**（与渲染同一真相）
    const q = project(n.pos);
    if (!q) continue;
    const d = Math.hypot(q.x - px, q.y - py);
    const kind = n.kind === 'core' ? 'halo' : n.kind;        // 点核星 = 选中它所属的圆圈
    const r = kind === 'halo' ? PICK_PX * 2 : (kind === 'point' ? PICK_PX * 1.5 : PICK_PX);
    if (d < bestD + (r - PICK_PX) && d < r) {
      bestD = d;
      best = { kind, node: n.kind === 'core' ? n.haloNode : n };
    }
  }
  if (!best) {                                          // 节点没命中 → 再看是不是点在选中的那根线上
    const L = pickLine(px, py);
    if (L) best = { kind: 'line', target: L.target, index: L.index };
  }
  return best;
}
let hovered = null;      // 当前悬停的节点（或 'halo'）
let pinned = null;       // 被钉住的节点（单击钉住，Esc / 点空白 / 再点一次取消）
/** 选中哪个节点，就把它所属的圆圈展开 —— 否则树里看不到"当前选中的是谁"。
 *  抽出来是因为有**两条**选中路径：鼠标点星（pinTo）与树/搜索/↑↓（selectNode）。 */
function revealInTree(n) {
  if (!n) return;
  const hn = n.kind === 'halo' ? n : (n.haloNode || (n.pointNode && n.pointNode.haloNode));
  if (hn && collapsed.has(hn.id)) { collapsed.delete(hn.id); fillCorners(); }
}
function pinTo(hit) {
  // 规划中的暗星：**不可点击**（不钉住、不导航）—— 只有悬停能看它的信息（01:204）
  if (hit && hit.kind === 'planned') return;
  const next = !hit ? null : hit.node;
  pinned = (next === pinned) ? null : next;
  tip.classList.toggle('is-pinned', !!pinned);
  if (pinned) {
    showTip(hit, 0, 0);
    pinLastHit = hit;
  } else {
    hideTip();
  }
  refreshHud(hudExtra);
  updateActiveLines();
  revealInTree(pinned);
}
let pinLastHit = null;   // 钉住时重算面板内容用
function setHovered(hit) {
  const next = !hit ? null : hit.node;
  if (next === hovered) return;
  hovered = next;
  // 暗星（规划中）**不可点击** —— 光标也别暗示能点；其余照旧
  canvas.style.cursor = next ? (next.kind === 'planned' ? 'help' : 'pointer') : 'default';
  updateActiveLines();
}
function relationText(node) {
  const out = [];
  for (const e of D.edges || []) {
    if (e.from === node.id) { const b = lessonById.get(e.to); if (b) out.push(`${b.label}：${e.kind}`); }
    if (e.to === node.id) { const a = lessonById.get(e.from); if (a) out.push(`${a.label}：${e.kind}`); }
  }
  return out;
}
/* ── 悬浮面板：结构对齐参考图（小标题栏 / 等宽名字 / chip / 键值表 / 细分隔线）── */
const chip = (t, on) => `<span class="chip${on ? ' chip--on' : ''}">${t}</span>`;
const kvRows = (rows) => `<dl class="kv">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const tipPanel = (kind, body, mode) =>
  `<div class="tip__head"><span class="tip__kind">◈ ${kind}</span><span class="tip__mode">${mode}</span></div>
   <div class="tip__body">${body}</div>
   <span class="tip__resize" data-resize="1" title="拖动放大"></span>`;

/* 上下游导航：键盘 ↑↓ 与面板里那两个按钮走同一条路径。
   ⚠️ 恒星（'halo'）也是合法目标 —— 早先把它挡掉了，导致"从首课往上走到恒星"永远失败。 */
function selectNode(n) {
  if (!n) return;
  pinned = n;
  revealInTree(n);
  tip.classList.add('is-pinned');
  // 视距由**内容大小**推出来：进圆圈 = 装下整个圆圈；进分支 = 装下这条分支。
  // 点**课程**不动视距（否则镜头忽近忽远，读一颗星时会被拽走）。
  if (n.kind === 'halo') goal.dist = n.radius * FIT;
  else if (n.kind === 'point') goal.dist = n.extent * FIT;
  const hit = { kind: n.kind, node: n };
  pinLastHit = hit;
  showTip(hit, 0, 0);
  updateActiveLines();
  setCenter(n.pos.x, n.pos.y, n.pos.z, n.label || n.name || '知识圆圈',
    n.kind === 'halo' || n.kind === 'point');      // 圆圈/分支已有按内容算的视距 → 别覆盖
}
function navStep(dir) {
  const cur = pinned || hovered;
  if (!cur) return;
  const t = dir === 'up' ? upOf(cur) : downOf(cur);
  if (t) selectNode(t);
}
function navName(x) { return !x ? '' : (x.label || x.name || ''); }
function navBlock(n) {
  const u = upOf(n), d = downOf(n);
  return `<div class="tip__nav">
    <button type="button" data-nav="up"${u ? '' : ' disabled'}>↑ 上游${u ? '：' + navName(u) : ''}</button>
    <button type="button" data-nav="down"${d ? '' : ' disabled'}>↓ 下游${d ? '：' + navName(d) : ''}</button>
  </div>`;
}
tip.addEventListener('click', (e) => {
  const ds = e.target && e.target.dataset ? e.target.dataset : null;
  if (!ds) return;
  if (ds.nav) { navStep(ds.nav); return; }
  if (ds.goto) { const n = ptById.get(ds.goto); if (n) selectNode(n); }   // 前置：点一下就过去
});

/* 图例折叠：图例一长就压观感 —— 点标题收起 / 展开（真按钮，键盘也能开；默认展开，刷新恢复） */
{
  const hd = document.getElementById('legend-fold');
  const box = hd && hd.closest('.corner');
  if (hd && box) {
    hd.addEventListener('click', () => {
      const folded = box.classList.toggle('is-folded');
      hd.setAttribute('aria-expanded', String(!folded));
    });
  }
}

/* ── #4 圆圈开关：**可见性只有一个真相** = halo.hidden ───────────────────
   渲染 / 拾取 / 连线 / 航道 / 标签 / 左树 / 图例 七处全部读它，不另存第二份状态。
   为什么强调：同型的坑我们踩过 —— "选中"曾有两条路径（鼠标点星走 pinTo、
   树/搜索/↑↓ 走 selectNode），只挂了一条 → 点恒星不展开左树。这次不许再有第二份真相。 */
function isHiddenNode(n) {
  if (!n) return false;
  if (n.kind === 'halo') return !!n.hidden;
  if (n.kind === 'core') return !!(n.haloNode && n.haloNode.hidden);
  const h = n.haloNode || (n.pointNode && n.pointNode.haloNode);
  return !!(h && h.hidden);
}
function applyHidden() {
  for (const h of halos) {
    const vis = !h.hidden;
    for (const c of h._starNodes || []) {
      if (c._glowA) c._glowA.visible = vis;
      if (c._glowB) c._glowB.visible = vis;
      if (c._corePts) c._corePts.visible = vis;
    }
    for (const p of h.points) {
      for (const n of [p, ...p.lessons, ...(p.plannedNodes || [])]) {
        if (n._sprite) n._sprite.visible = vis;
        if (n._flare) n._flare.visible = vis;
        if (n._glow) n._glow.visible = vis;
      }
    }
  }
}
function setHidden(h, v) {
  h.hidden = !!v;
  // 隐藏的圆圈上不该还挂着面板/悬停 —— 否则会对着空气说话
  if (h.hidden && pinned && isHiddenNode(pinned)) { pinned = null; pinLastHit = null; hideTip(); }
  if (h.hidden && hovered && isHiddenNode(hovered)) setHovered(null);
  applyHidden();
  refreshLegendCircles();
  fillCorners();            // 左树也跟着（隐藏的圆圈只留标题行，标"已隐藏"）
  updateActiveLines();
  refreshHud();
}
/** 图例里的"圆圈"分组：一行一个圆圈，点了就隐藏/显示 */
function refreshLegendCircles() {
  if (!$legendCircles) return;
  $legendCircles.innerHTML = halos.map((h) => `<button type="button" class="legend__circle${h.hidden ? ' is-hidden' : ''}"
      data-halo-toggle="${h.id}" aria-pressed="${h.hidden ? 'false' : 'true'}"
      title="${h.hidden ? '显示' : '隐藏'}「${h.name}」">
      <span class="g" style="background:${h.hue}"></span>${h.name}
      <b>${h.hidden ? '已隐藏' : '显示中'}</b>
    </button>`).join('');
  $legendCircles.querySelectorAll('[data-halo-toggle]').forEach((el) => {
    el.addEventListener('click', () => {
      const h = halos.find((x) => x.id === el.dataset.haloToggle);
      if (h) setHidden(h, !h.hidden);
    });
  });
}

/* ── 四角 UI ─────────────────────────────────────────────────────────── */
const $tree = document.getElementById('tree');
const $legendCircles = document.getElementById('legend-circles');
refreshLegendCircles();
applyHidden();
const collapsed = new Set(halos.map((h) => h.id));   // **默认全收起**（用户要求）；选中某节点时会自动展开它所属的圆圈
function syncTreeActive() {
  if (!$tree) return;
  const cur = pinned || hovered;
  const id = !cur ? '' : cur.id;
  $tree.querySelectorAll('.trow').forEach((el) => el.classList.toggle('is-active', el.dataset.id === id));
}
function fillCorners() {
  const all = nodes.filter((n) => n.kind === 'lesson');
  const lit = all.filter((n) => n.learned).length;
  // 「名词」= **台账词条总数**（assets/glossary-data.js，与 GLOSSARY.md / 插件设置页同源）。
  // 原来这里把每课 meta.terms 相加 —— 那是另一个口径（各课"本课名词清单"的声明数），
  // 于是同一个标签在星图 50、在设置页 71（2026-09-21 用户发现）。现在取台账真源，并留 title 说明口径。
  const perLessonTerms = all.reduce((s, n) => s + (n.termCount || 0), 0);
  const terms = (D && typeof D.termTotal === 'number') ? D.termTotal : perLessonTerms;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('as-halos', halos.length);
  set('as-points', pts.length);
  set('as-lessons', all.length);
  set('as-lit', `${lit} / ${all.length}`);
  set('as-terms', terms);
  const tel = document.getElementById('as-terms');
  if (tel) {
    tel.title = `台账词条总数（assets/glossary-data.js，与 GLOSSARY.md、插件设置页同源）；`
      + `各课"本课名词"清单声明合计 ${perLessonTerms} 个`;
  }
  const bar = document.getElementById('as-bar');
  if (bar) bar.style.width = `${all.length ? (lit / all.length) * 100 : 0}%`;
  if (!$tree) return;
  // 三级树：知识圆圈（可折叠）→ 知识点 → 课程。课一多，收起来就不会把方框撑大。
  $tree.innerHTML = '<div class="corner__hd">知识圆圈 · 知识点 · 课程</div>' + halos.map((h) => {
    const open = !collapsed.has(h.id) && !h.hidden;           // #4：隐藏的圆圈只留标题行
    const hLessons = h.points.reduce((a, p) => a + p.lessons.length, 0);
    const rows = [`<div class="trow trow--halo${h.hidden ? ' is-off' : ''}" data-halo="${h.id}"><span class="caret${open ? ' is-open' : ''}"></span><span class="g" style="background:${h.hue}"></span>${h.name}<b>${h.hidden ? '已隐藏' : h.points.length + ' · ' + hLessons}</b></div>`];
    if (open) {
      for (const p of h.points) {
        rows.push(`<div class="trow trow--point" data-id="${p.id}"><span class="g" style="background:${p.hue}"></span>${p.name}<b>${p.lessons.length}</b></div>`);
        for (const l of p.lessons) {
          rows.push(`<div class="trow trow--lesson" data-id="${l.id}"><span class="g" style="background:${l.hue};opacity:${l.learned ? 1 : 0.35}"></span>${l.label}<b>${l.learned ? '已学' : '未学'}</b></div>`);
        }
      }
    }
    return rows.join('');
  }).join('');
  // 圆圈那一行 = 折叠开关（点它不选中节点，避免"想折叠却跳走了"）
  $tree.querySelectorAll('[data-halo]').forEach((el) => el.addEventListener('click', () => {
    const id = el.dataset.halo;
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    fillCorners();
    syncTreeActive();
  }));
  $tree.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => {
    const n = nodes.find((x) => x.id === el.dataset.id);
    if (n) selectNode(n);
  }));
}
fillCorners();

/* ── 面板：与星星**解耦** —— 拖标题栏移动、拖右下角放大；只用一根虚线连回星星 ──────
   用户要求：面板可随意移动放大，但**与星星的距离有上限**（"幅度不能太大，导致方框和星星太远"）。
   做法：存一个相对星星的偏移 panelOff，长度夹在 PANEL_MAXR 以内；星星怎么动，面板跟着动，
   于是相对位置（用户摆的那一处）保留，而距离永远被夹住。 */
let panelOff = { x: 250, y: -95 };
const PANEL_MAXR = 340;
let panelZoom = 1;
const clampOff = () => {
  const L = Math.hypot(panelOff.x, panelOff.y);
  if (L > PANEL_MAXR) { panelOff.x = panelOff.x / L * PANEL_MAXR; panelOff.y = panelOff.y / L * PANEL_MAXR; }
};
function setZoom(z) {
  panelZoom = Math.max(0.8, Math.min(2.2, z));
  tip.style.setProperty('--sm-zoom', String(panelZoom));
}
let panelDrag = null, zoomDrag = null;
tip.addEventListener('pointerdown', (e) => {
  if (!pinned) return;                                   // 只有钉住后面板才可操作
  if (e.target && e.target.dataset && e.target.dataset.resize) {
    zoomDrag = { sx: e.clientX, sz: panelZoom };
    e.preventDefault(); e.stopPropagation();
    return;
  }
  if (e.target && e.target.closest && e.target.closest('.tip__head')) {
    panelDrag = { sx: e.clientX, sy: e.clientY, ox: panelOff.x, oy: panelOff.y };
    e.preventDefault(); e.stopPropagation();
  }
});
addEventListener('pointermove', (e) => {
  if (panelDrag) {
    panelOff.x = panelDrag.ox + (e.clientX - panelDrag.sx);
    panelOff.y = panelDrag.oy + (e.clientY - panelDrag.sy);
    clampOff();
  } else if (zoomDrag) {
    setZoom(zoomDrag.sz + (e.clientX - zoomDrag.sx) / 260);
  }
});
addEventListener('pointerup', () => { panelDrag = null; zoomDrag = null; });

const $search = document.getElementById('search');
if ($search) {
  $search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = $search.value.trim().toLowerCase();
    if (!q) return;
    const hit = nodes.find((n) => `${n.label || ''}${n.title || ''}${n.name || ''}`.toLowerCase().includes(q));
    if (hit) { selectNode(hit); $search.blur(); }
    else { hudExtra = `没找到「${$search.value.trim()}」`; refreshHud(); }
  });
}
const $fs = document.getElementById('fs');
if ($fs) {
  $fs.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  });
}

/* 面板展开动效：只在「从无到有」那一刻播，节点之间移动不重播（否则会一直抽动）*/
let tipVisible = false;
function popTip() {
  tip.classList.remove('is-open');
  void tip.offsetWidth;                 // 强制重排，动画才肯重播
  tip.classList.add('is-open');
}
function hideTip() { tip.style.display = 'none'; tipVisible = false; }

function showTip(hit, px, py) {
  if (!hit) { hideTip(); return; }
  const lessonsOf = nodes.filter((n) => n.kind === 'lesson');
  const mode = pinned ? 'PINNED' : 'HOVER';
  if (hit.kind === 'halo') {
    const h = hit.node;
    const hLessons = h.points.reduce((a, p) => a.concat(p.lessons), []);
    tip.innerHTML = tipPanel('知识圆圈 · Halo',
      `<div class="tip__name">${h.name}</div>
       <div class="tip__sub">${h.center || ''}</div>
       <div class="chips">${chip(`${h.points.length} 大分支`)}${chip(`${hLessons.length} 课`)}${chip(`已点亮 ${hLessons.filter((x) => x.learned).length}`, true)}</div>
       <div class="tip__sec">这个圆圈</div>
       ${kvRows([
         ['圈内知识点', (h.inside || []).length + ' 条'],
         ['大分支', h.points.map((p) => p.name).join(' · ')],
         ['圈外不教', (h.outside || []).length + ' 类'],
       ])}
       ${navBlock(h)}
       <div class="tip__go">这是整个圆圈的中心</div>`, mode);
  } else if (hit.kind === 'point') {
    const p = hit.node;
    tip.innerHTML = tipPanel('知识点 · Branch',
      `<div class="tip__name">${p.name}</div>
       <div class="tip__sub">挂在知识圆圈上的一条大分支</div>
       <div class="chips">${chip(`${p.lessons.length} 课`)}${chip(`已点亮 ${p.lessons.filter((x) => x.learned).length}`, true)}</div>
       <div class="tip__sec">本分支已开课</div>
       ${kvRows(p.lessons.length
         ? p.lessons.map((x) => [x.label, x.learned ? '已学过' : '还没学'])
         : [['—', '还没开课']])}
       ${navBlock(p)}
       ${(p.reqNodes && p.reqNodes.length)
        ? `<div class="tip__sec">前置（必须先会）</div>
           <div class="tip__nav">${p.reqNodes.map((x) => `<button type="button" data-goto="${x.id}">→ ${x.name}</button>`).join('')}</div>`
        : ''}
       <div class="tip__go">点击即钉住 · 双击飞过去看这条分支</div>`, mode);
  } else if (hit.kind === 'planned') {
    // 规划中的暗星（01:204）：**只有悬停**能看到这课的基本信息 —— 没有课页，
    // 所以这里**不给任何链接**（"进入这一课"那行只属于真课次星）
    const n = hit.node;
    tip.innerHTML = tipPanel('规划中 · 未开课',
      `<div class="tip__name">${n.title}</div>
       <div class="tip__sub">${n.label}</div>
       <div class="chips">${chip('课程还没生成')}${chip(n.pointNode.name || n.pointNode.id)}${n.branch ? chip('支线') : chip('主线')}</div>
       <div class="tip__sec">这门课的计划</div>
       ${kvRows([
         ['可交付物', n.deliverable],
         ['通过判据', n.criteria],
       ])}
       ${navBlock(n)}
       <div class="tip__go">课还没生成：点不开、双击也打不开（交了上一课的作品才会生成它）</div>`, mode);
  } else {
    const n = hit.node, rel = relationText(n);
    const rows = [
      ['知识点', n.pointNode.name],
      ['状态', n.learned ? '已学过' : '还没学'],
    ];
    // #7 异常：红 = 有未解决的答疑（会自动标）；黄 = 人工标记待补
    if (n.flag) rows.push(['异常', n.flag === 'red' ? `有 ${n.pendingQ} 条未解决的答疑` : '人工标记：待补']);
    if (n.termCount != null) rows.push(['本课名词', `${n.termCount} 个`]);
    if (n.source) rows.push(['参考来源', n.source]);
    tip.innerHTML = tipPanel('课程 · Lesson',
      `<div class="tip__name">${n.title}</div>
       <div class="tip__sub">${n.label}</div>
       <div class="chips">${n.learned ? chip('已学过', true) : chip('还没学')}${chip(n.pointNode.name)}</div>
       <div class="tip__sec">课程信息</div>
       ${kvRows(rows)}
       ${rel.length ? `<div class="tip__sec">关系</div>${kvRows(rel.map((s) => s.split('：')))}` : ''}
       ${navBlock(n)}
       <div class="tip__go"><a href="${PREFIX + n.href}?fs=1" target="_blank" rel="noopener">进入这一课 →</a></div>`, mode);
  }
  tip.style.display = 'block';
  if (!tipVisible) { tipVisible = true; popTip(); }
  if (pinned) return;                    // 钉住时位置由主循环每帧重算（跟着节点走）
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(innerWidth - r.width - 8, px + 16)}px`;
  tip.style.top = `${Math.min(innerHeight - r.height - 8, py + 16)}px`;
}

/* ── 事件 ────────────────────────────────────────────────────────────── */
let dragging = false, lastX = 0, lastY = 0, moved = 0, dragMode = null;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
  dragMode = (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'orbit';
  keys.clear();
  canvas.setPointerCapture(e.pointerId);
});
/* 右键 = 平移（见上面 pointerdown 的 dragMode），所以必须压掉浏览器自带的右键菜单。
   原来只挂在 canvas 上：只要事件目标不是 canvas（浮层、面板、扩展注入的元素、pointer capture 之后），
   右键就会漏到浏览器 / Edge 鼠标手势那边（2026-09-21 现场：「右键逻辑变成了浏览器自带手势」）。
   这里补一条文档级兜底，只对**明确要右键操作**的面板放行（提示卡 / 角落面板 / 静态告警 / 输入框）。 */
const KEEP_NATIVE_MENU = '.tip, .corner, #staticnote, input, textarea, [contenteditable="true"]';
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (t && typeof t.closest === 'function' && t.closest(KEEP_NATIVE_MENU)) return;
  e.preventDefault();
});
canvas.addEventListener('dblclick', (e) => {
  const hit = pick(e.offsetX, e.offsetY);
  if (hit && hit.kind === 'planned') return;                              // 暗星（规划中）：双击**不导航** —— 课页还不存在（01:204），不许指向不存在的页面
  if (hit && hit.kind === 'lesson') { window.open(PREFIX + hit.node.href + '?fs=1', '_blank', 'noopener'); return; }  // 双击课程 = 直接进课（?fs=1 = 打开即全屏，见 assets/lesson-fs.js）
  if (hit && hit.kind === 'point') {                                                      // 双击分支 = 以它为中心
    const p = hit.node;
    setCenter(p.pos.x, p.pos.y, p.pos.z, p.name);
    return;
  }
  resetView();
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  if (moved >= 5) return;
  const hit = pick(e.offsetX, e.offsetY);
  if (hit && hit.kind === 'line') { selectNode(hit.target); return; }   // 点线 = 切到那一端
  pinTo(hit);                                              // 单击 = 钉住 / 取消
  if (hit && hit.kind === 'halo') setCenter(hit.node.pos.x, hit.node.pos.y, hit.node.pos.z, hit.node.name);
});
canvas.addEventListener('pointermove', (e) => {
  if (dragging) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    lastX = e.clientX; lastY = e.clientY;
    if (dragMode === 'pan') {
      const k = cam.dist * 0.0016;
      const b = camBasis();
      const t = center ? goalCenter : goalCamPos;     // 中心视角移中心，自由视角移相机
      t.addScaledVector(b.right, -dx * k).addScaledVector(b.up, dy * k);
    } else {
      goal.theta -= dx * 0.005;
      goal.phi = Math.min(1.48, Math.max(0.20, goal.phi - dy * 0.005));
    }
    tip.style.display = 'none';
  } else {
    const hit = pick(e.offsetX, e.offsetY);
    if (hit && hit.kind === 'line') {
      // 悬停线**不改选中**（只高亮 + 流动提示）—— 否则选中一变线就重画，会闪
      hoverLineIdx = hit.index;
      hudExtra = `点击沿此线 → ${navName(hit.target)}`;
      refreshHud();
      canvas.style.cursor = 'pointer';
      return;
    }
    hoverLineIdx = -1;
    setHovered(hit);
    if (!pinned) showTip(hit, e.clientX, e.clientY);
    else if (hit && hit !== pinLastHit) tip.style.opacity = '1';
  }
});
canvas.addEventListener('pointerleave', () => {
  setHovered(null);
  hoverLineIdx = -1;
  if (!pinned) hideTip();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  goal.dist = Math.min(120, Math.max(1.5, goal.dist * (1 + Math.sign(e.deltaY) * 0.09)));
  cancelFlight();                                    // 一滚轮就交还控制权（别跟人抢镜头）
}, { passive: false });

/* 键盘自由移动：WASD / 方向键 · Q E 升降 · R 复位（keys 已在相机段声明）*/
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'escape') { if (pinned) pinTo(null); else releaseCenter(); return; }
  if (k === 'r') { resetView(); return; }
  if (k === 'arrowup' || k === 'arrowdown') {      // 上下切换课程（方向键不再管相机，避免和导航打架）
    e.preventDefault();
    navStep(k === 'arrowup' ? 'up' : 'down');
    return;
  }
  if (['w', 'a', 's', 'd', 'q', 'e'].includes(k)) {
    keys.add(k);
    e.preventDefault();
  }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  sizeBloom();                                    // Bloom 的几个 RT 也得跟着改尺寸
});

/* ── 主循环 ──────────────────────────────────────────────────────────── */
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2; };
let last = performance.now(), clockT = 0;
const T0 = last;
function frame(now) {
  const raw = (now - last) / 1000;
  const dt = Math.min(0.05, raw);
  last = now;
  clockT = (now - T0) / 1000;     // 绝对时间：帧被节流也不会卡在动画起点

  // 阻尼（飞行中由 stepFlight 接管；一拖一按就取消飞行）
  if (dragging || keys.size > 0) cancelFlight();
  if (!stepFlight()) {
    cam.theta += (goal.theta - cam.theta) * DAMP;
    cam.phi += (goal.phi - cam.phi) * DAMP;
    if (center) {
      cam.dist += (goal.dist - cam.dist) * DAMP * 0.9;
      center.lerp(goalCenter, DAMP);
    } else {
      camPos.lerp(goalCamPos, DAMP);
    }
  }

  // 键盘移动（中心视角移中心，自由视角移相机）
  {
    const sp = cam.dist * 0.9 * dt;
    const b = camBasis();
    const t = center ? goalCenter : goalCamPos;
    if (keys.has('w') || keys.has('arrowup')) t.addScaledVector(b.fwd, sp);
    if (keys.has('s') || keys.has('arrowdown')) t.addScaledVector(b.fwd, -sp);
    if (keys.has('a') || keys.has('arrowleft')) t.addScaledVector(b.right, -sp);
    if (keys.has('d') || keys.has('arrowright')) t.addScaledVector(b.right, sp);
    if (keys.has('e')) t.y += sp;
    if (keys.has('q')) t.y -= sp;
  }
  applyCam();

  // 长出：知识点先长，课程随后
  for (const n of nodes) {
    if (clockT < n._at) continue;
    const t = Math.min(1, (clockT - n._at) / DUR);
    n._prog = easeOutBack(t);
  }

  // 节点外观 + 只有悬停才出字
  for (const n of nodes) {
    const on = hovered === n;
    const isPoint = n.kind === 'point';
    n._sprite.scale.setScalar(n._sprite.userData.base * (on ? 1.4 : 1) * Math.max(0.001, n._prog));
    // 暗星（规划中）比"没学的课"更暗一档：它连课都还没生成
    n._sprite.material.opacity = (isPoint ? 1 : (n.learned ? 1 : 0.5)) * (on ? 1 : 0.94);
    n._flare.scale.setScalar(n._flare.userData.base * (on ? 1.5 : 1) * Math.max(0.001, n._prog));
    n._flare.material.opacity = (isPoint ? 0.18 : (n.flag ? 0.22 : 0)) * (on ? 1.4 : 1);
    n._flare.material.rotation += (isPoint ? 0.035 : 0.06) * dt;
    // 点亮的星：彩色柔光晕（未点亮 = 0，纯暗点）
    const lit = isPoint || n.learned;
    const burst = 1 + 0.9 * Math.max(0, 1 - (clockT - n._at) / 0.9);   // 刚点亮那一下向外炸开
    // 微微呼吸：±7% 透明度、±1.5% 大小，周期约 15 秒，各星相位错开（"液体静谧"，不是闪）
    const br = 0.93 + 0.07 * Math.sin(clockT * 0.42 + n._ph);
    n._glow.scale.setScalar(n._glow.userData.base * burst * (on ? 1.35 : 1) * Math.max(0.001, n._prog) * (0.985 + 0.03 * br));
    n._glow.material.opacity = lit ? (on ? 0.78 : 0.46) * (isPoint ? 1 : (n.bright || 1)) * br : 0;
  }
  // 标签（DOM 覆盖层）：钉住时让位——名字面板里已经有了，两个叠一起会糊成一团
  if (pinned) {
    $hlabel.style.display = 'none';
    labelScreen = project(pinned.pos);
  } else if (hovered) {
    const sp = project(hovered.pos);
    if (sp) drawLabel(hovered, sp);
    else $hlabel.style.display = 'none';
  } else {
    $hlabel.style.display = 'none';
    labelAnchor = null; labelScreen = null;
  }

  // 钉住时的：面板定位（跟着星星 + 用户偏移）+ 引线（接到面板上离星星最近的那一点）
  if (pinned && labelScreen) {
    const r = tip.getBoundingClientRect();          // 已含 scale，所以宽高就是放大后的
    const w = r.width, h = r.height;
    const left = Math.max(8, Math.min(innerWidth - w - 8, labelScreen.x + panelOff.x));
    const top = Math.max(8, Math.min(innerHeight - h - 8, labelScreen.y + panelOff.y));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    const lx = Math.max(left, Math.min(left + w, labelScreen.x));
    const ly = Math.max(top, Math.min(top + h, labelScreen.y));
    $lead.style.display = 'block';
    $leadLine.setAttribute('x1', lx);
    $leadLine.setAttribute('y1', ly);
    $leadLine.setAttribute('x2', labelScreen.x);
    $leadLine.setAttribute('y2', labelScreen.y);
  } else {
    $lead.style.display = 'none';
  }

  // 悬停线：加粗 + 流动（方向：选中的星 → 那一端）
  showHoverLine();

  // 悬停环
  if (hovered) {
    hoverRing.position.set(hovered.pos.x, hovered.pos.y, hovered.pos.z);
    hoverRing.scale.setScalar(hovered.kind === 'halo' ? 2.6 : (hovered.kind === 'point' ? 2.3 : 1.45));
    hoverRing.material.rotation -= (Math.PI * 2 / 5) * dt;      // 5 秒一圈（慢）
  } else {
    hoverRing.scale.setScalar(0);
  }

  for (const m of pointMaterials) m.uniforms.uTime.value = clockT;
  haloSets.forEach(({ A, B }, i) => {
    A.scale.setScalar(4.6 + 0.14 * Math.sin(clockT * 0.7 + i * 1.7));
    B.material.opacity = 0.5 + 0.08 * Math.sin(clockT * 0.45 + i * 1.1 + 1.2);
    B.scale.setScalar(11 + 0.45 * Math.sin(clockT * 0.31 + i));
  });
  nebulae.forEach((n, i) => {
    n.material.rotation += (0.012 + i * 0.006) * dt;
    // 若隐若现：每块云用**不同的周期与相位**慢慢明灭（65~110 秒一轮，短了就像在闪）
    const base = i === 0 ? 0.85 : 0.62;
    n.material.opacity = base * (0.72 + 0.28 * Math.sin(clockT * (0.058 + i * 0.019) + i * 2.1));
  });

  if (activeSegs.length) placeActiveTubes();      // 屏幕恒定宽度：镜头一动就得重算半径
  renderBloom();                                  // 场景 → 亮部 → 模糊 → 合成（见文件上半的 Bloom 段）
  requestAnimationFrame(frame);
}
/* ⚠️ 2026-09-20 试过限帧（静止 30fps / 交互不限），**用户否掉**："体验太差了，性能够就给我猛猛加"。
   所以这里就是裸的 rAF —— 不做任何限帧。别再"顺手优化"回来。 */
requestAnimationFrame(frame);

hudExtra = pinned ? `已钉住：${pinned.label || pinned.name} · Esc 取消` : '左拖旋转 · 右键平移 · WASD 移动 · ↑↓ 切换课程 · 滚轮缩放';
refreshHud();

/* ── 深链：#<lesson-id>（课程页里的「在星图中查看这一课」就靠它）─────────
   打开 starmap 时带上 #spring-boot/0001，就直接选中并飞到那一课。 */
function deepLink() {
  const want = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
  if (!want) return;
  const n = nodes.find((x) => x.id === want)
    || pts.find((p) => p.id === want)
    || halos.find((h) => h.id === want);
  if (n) selectNode(n);
}
deepLink();
addEventListener('hashchange', deepLink);

/* ── 进度同步：本地服务在跑就定时对一次（学完一课，星图自己点亮）─────────
   · 读的是**活文件**（:8788/progress），不是构建时烘进 starmap-real.js 的那份快照
   · 服务不在 → 静默保持内置进度（不刷屏、不干扰观感）
   · 只在**真的变了**才动 DOM/材质；新点亮那颗复用既有的"刚点亮炸开"动画（n._at）
   · 颜色是建贴图时就烘死的，所以翻转 learned 时必须手动把颜色也翻过来 */
// 同源优先（tools/app-server.js 一个端口时）；file:// 才回落到独立服务（8788）
const PROGRESS_URL = window.STARMAP_PROGRESS_URL
  || (location.protocol === 'file:' ? 'http://127.0.0.1:8788/progress' : location.origin + '/progress');
function syncProgress() {
  if (document.hidden) return;
  fetch(PROGRESS_URL, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j || !j.learned) return;
      const lit = new Set(j.learned);
      let changed = false;
      for (const n of nodes) {
        if (n.kind !== 'lesson') continue;
        const want = lit.has(n.id);
        if (n.learned !== want) {
          n.learned = want;
          if (want) n._at = clockT;                                        // 刚点亮 → 炸开
          if (n._sprite) n._sprite.material.color.copy(lessonColor(n));
          changed = true;
        }
      }
      if (changed) { fillCorners(); refreshHud(); }
    })
    .catch(() => { /* 服务不在：保持内置进度，什么都不说 */ });
}
setInterval(syncProgress, 8000);
addEventListener('focus', syncProgress);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncProgress(); });
syncProgress();
