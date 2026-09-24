#!/usr/bin/env node
/**
 * make-icon.js — 画星图的图标（零依赖）
 * ------------------------------------------------------------------
 * 跑：node tools/make-icon.js
 * 出：assets/starmap.ico（16/32/48/256 四档，Windows 快捷方式用）
 *     demo/starmap-icon.png（256，给人看/给工具读）
 *
 * 设计：**深空圆角方块 + 一颗四角星**（和星图里"恒星 + 锁定环"同一套视觉语言），淡蓝柔光。
 *
 * 为什么要自己画：Windows 快捷方式要 .ico；而 .ico 从 Vista 起**允许直接内嵌 PNG**，
 * 于是只差"手写一个最小 PNG 编码器"（zlib 是 Node 自带的）—— 不装任何图像库。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');

/* ── 最小 PNG 编码（8bit RGBA，无滤波）─────────────────────────────── */
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;                                  // filter = none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── 画一个像素（坐标已归一化到 -1..1，中心 0）────────────────────── */
function sample(x, y) {
  // ① 圆角方块：抠一个有符号距离场，>0 就是外面（透明）
  const R = 0.94, cr = 0.32;
  const qx = Math.abs(x) - (R - cr), qy = Math.abs(y) - (R - cr);
  const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - cr;
  if (sd > 0) return [0, 0, 0, 0];

  // ② 底色：深空竖向渐变（#0a0e22 → #16203c）
  const t = (y + 1) / 2;
  let r = 10 + 12 * t, g = 14 + 18 * t, b = 34 + 26 * t;

  // ③ 中心柔光（恒星的光晕）
  const d = Math.hypot(x, y);
  const glow = Math.exp(-(d * d) / 0.16);
  r += 30 * glow; g += 92 * glow; b += 185 * glow;

  // ④ 四角星：astroid  |x|^(2/3) + |y|^(2/3) <= R^(2/3)
  const SR = 0.66, k = 2 / 3;
  const ax = Math.pow(Math.abs(x) / SR, k);
  const ay = Math.pow(Math.abs(y) / SR, k);
  const star = ax + ay;                                        // <=1 → 在星内
  if (star <= 1) {
    const edge = Math.max(0, Math.min(1, (star - 0.30) / 0.70));   // 0 中心 → 1 尖角
    r = 255 * (1 - edge) + 186 * edge;
    g = 250 * (1 - edge) + 220 * edge;
    b = 236 * (1 - edge) + 255 * edge;
  }
  return [r, g, b, 255];
}

/* ── 渲染一张（3×3 超采样抗锯齿）────────────────────────────────── */
function render(S) {
  const SS = 3, n = SS * SS;
  const px = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = ((x + (sx + 0.5) / SS) / S) * 2 - 1;
          const fy = ((y + (sy + 0.5) / SS) / S) * 2 - 1;
          const c = sample(fx, fy);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const i = (y * S + x) * 4;
      px[i] = Math.round(r / n); px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n); px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

/* ── ICO：内嵌 PNG ───────────────────────────────────────────────── */
function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = entries.map((e) => {
    const b = Buffer.alloc(16);
    b.writeUInt8(e.size >= 256 ? 0 : e.size, 0);      // 256 在 ICO 里写 0
    b.writeUInt8(e.size >= 256 ? 0 : e.size, 1);
    b.writeUInt16LE(1, 4); b.writeUInt16LE(32, 6);
    b.writeUInt32LE(e.png.length, 8);
    b.writeUInt32LE(offset, 12);
    offset += e.png.length;
    return b;
  });
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.png)]);
}

const SIZES = [16, 32, 48, 256];
const entries = SIZES.map((size) => ({ size, png: encodePNG(size, size, render(size)) }));
const icoBuf = ico(entries);

const icoPath = path.join(ROOT, 'assets', 'starmap.ico');
fs.writeFileSync(icoPath, icoBuf);

const demoDir = path.join(ROOT, 'demo');
fs.mkdirSync(demoDir, { recursive: true });
const pngPath = path.join(demoDir, 'starmap-icon.png');
fs.writeFileSync(pngPath, entries[entries.length - 1].png);

console.log('[icon] ' + path.relative(ROOT, icoPath) + '  ' + icoBuf.length + ' B  (' + SIZES.join('/') + ')');
console.log('[icon] ' + path.relative(ROOT, pngPath) + '  ' + entries[entries.length - 1].png.length + ' B  (256 预览用)');
