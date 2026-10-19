/**
 * distribution-license.cjs — 分发材料的**硬校验器**（纯本地、零网络）
 * ------------------------------------------------------------------
 * 病（报告 G03 / P1）：正式分发链**只警告不阻断** ——
 * `build-offline-payload.js#nodeExePath()` 直接取 `process.execPath`，
 * 找不着许可只 `console.warn` 就继续产出；于是"分发包里有 node.exe、没有它的许可"
 * 这件事在产物上**看不出来**，发布判定也没有任何机器判据。
 *
 * 本文件的立场只有一句话：**材料对不上，就别打包**。
 *   · 校验全部落在**真实字节**上：许可文件与二进制的 sha256、二进制的自报版本；
 *   · 一条材料不对就返回 `problems`（**字符串数组**，每条点名是哪一件），
 *     调用方（`tools/check-distribution.mjs` / `build-offline-payload.js`）据此 exit 非零；
 *   · **不做任何网络请求**、不猜发行版、不凭名字判侵权 —— 这是发布证据缺口，不是法律意见。
 *
 * manifest（`schema = whale-distribution/1`）每项至少要有：
 *   `name` / `version` / `source` / `sha256` / `licenseFiles` / `licenseSha256` /
 *   `redistributionEvidence`；且必须有一项 `name === 'node'`，其 `version`/`sha256`
 *   要和**真的那个二进制**对上（版本取自 `node -p process.versions.node`，不取 `process.execPath`）。
 *
 * ⚠️ 本件**不随课程包模板**：它属于离线安装器通道，登记在 `engine-files.cjs#CODE_EXCLUDE`
 *    （与 offline-bootstrap / offline-server / build-offline-installer / build-offline-payload 同性质）。
 * ⚠️ 不许写机器专属路径（盘符 / 用户目录）：`test/alien-env.mjs` 会静态扫模板目录。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/** manifest 的 schema（逐字比对，不做版本兼容猜测） */
const MANIFEST_SCHEMA = 'whale-distribution/1';
/** payload 里那份"我是谁、我核过什么"的回执（`build-offline-payload.js` 写、安装器读） */
const RECEIPT_SCHEMA = 'whale-distribution-receipt/1';

/** 64 位小写 hex（sha256 只认这一种写法：大小写混写等于两份清单口径不同） */
const HEX64 = /^[0-9a-f]{64}$/;

const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256OfFile = (p) => sha256Of(fs.readFileSync(p));
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isHex64 = (v) => typeof v === 'string' && HEX64.test(v);
const isArray = (v) => Array.isArray(v);

/** 相对路径一律换成 POSIX（`files` 是给人看、给判据比的稳定形状） */
const posix = (rel) => String(rel).replace(/\\/g, '/');

/** 许可件的名字：只能是**单个 ASCII 文件名**（不许带目录、不许 `..`） */
function licenseNameProblem(name) {
  if (!isNonEmptyString(name)) return '文件名是空的';
  if (/[\\/]/.test(name)) return '带路径分隔符（许可件只许落在 payload 根）';
  if (name === '.' || name === '..') return '不是文件名';
  // eslint-disable-next-line no-control-regex
  if (!/^[\x20-\x7e]+$/.test(name)) return '含非 ASCII 字符（payload 根的文件名一律 ASCII）';
  return null;
}

/**
 * 校验 manifest 描述的**材料是否真的齐、真的对**。
 *
 * @param {{manifestPath: string, nodePath: string, payloadDir?: string|null}} args
 *   · `manifestPath` manifest JSON 的绝对路径（许可件按**它所在目录**解析相对路径）
 *   · `nodePath` node 二进制的绝对路径（**不拿 `process.execPath` 兜底**：兜底等于自己证明自己）
 *   · `payloadDir` 可选；给了就逐件核 payload 内的产物（`path` + sha256）
 * @returns {{ok: boolean, problems: string[], files: string[]}}
 *   `problems` 每条都点名是哪一件；`files` 是已核验材料的相对路径（升序、去重）
 */
function verifyDistributionMaterials({ manifestPath, nodePath, payloadDir = null } = {}) {
  const problems = [];
  const files = new Set();
  const manifestDir = isNonEmptyString(manifestPath) ? path.dirname(path.resolve(manifestPath)) : null;

  // ── ① manifest 本身读得动吗（坏 JSON / 不存在都只是 problem，**不抛崩**）──────────
  let manifest = null;
  if (!isNonEmptyString(manifestPath)) {
    problems.push('没有给 manifest 路径（--manifest=<manifest.json>）');
  } else if (!fs.existsSync(path.resolve(manifestPath))) {
    problems.push(`manifest 不存在：${posix(manifestPath)}`);
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
    } catch (e) {
      problems.push(`manifest 不是合法 JSON：${posix(path.basename(String(manifestPath)))}（${e && e.message ? e.message : String(e)}）`);
    }
  }
  if (problems.length) return { ok: false, problems, files: [] };

  // ── ② schema 与 items 的形状 ────────────────────────────────────────────────
  if (!manifest || typeof manifest !== 'object' || isArray(manifest)) {
    problems.push('manifest 顶层不是对象');
    return { ok: false, problems, files: [] };
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    problems.push(`manifest 的 schema 不是 ${MANIFEST_SCHEMA}（实得 ${JSON.stringify(manifest.schema)}）`);
  }
  const items = manifest.items;
  if (!isArray(items) || items.length === 0) {
    problems.push('manifest 的 items 是空的（没有任何材料就没有任何可核验的东西）');
    return { ok: false, problems, files: [] };
  }

  // ── ③ 逐项：字段齐全 + 许可件真的在、真的对 ─────────────────────────────────
  items.forEach((item, i) => {
    const tag = `第 ${i + 1} 项${isNonEmptyString(item && item.name) ? `（${item.name}）` : ''}`;
    if (!item || typeof item !== 'object' || isArray(item)) {
      problems.push(`${tag}不是对象`);
      return;
    }
    for (const k of ['name', 'version', 'source']) {
      if (!isNonEmptyString(item[k])) problems.push(`${tag}缺 ${k}`);
    }
    if (!isHex64(item.sha256)) problems.push(`${tag}的 sha256 不是 64 位小写 hex`);

    const licFiles = item.licenseFiles;
    if (!isArray(licFiles) || licFiles.length === 0) {
      problems.push(`${tag}缺 licenseFiles（没有许可件就不叫"可再分发"）`);
    }
    const licSha = item.licenseSha256;
    if (!licSha || typeof licSha !== 'object' || isArray(licSha)) {
      problems.push(`${tag}缺 licenseSha256`);
    }

    const declared = isArray(licFiles) ? licFiles.filter((f) => isNonEmptyString(f)) : [];
    if (isArray(licFiles) && declared.length !== licFiles.length) {
      problems.push(`${tag}的 licenseFiles 里有空名字`);
    }
    // 键集合必须与 licenseFiles **恰好相等**（多一个 = 混进未声明的件，少一个 = 有件没 hash）
    if (licSha && typeof licSha === 'object' && !isArray(licSha) && isArray(licFiles)) {
      const keys = Object.keys(licSha).sort();
      const want = [...new Set(declared)].sort();
      if (keys.join('\u0000') !== want.join('\u0000')) {
        problems.push(`${tag}的 licenseSha256 键集合与 licenseFiles 不相等（licenseSha256=${JSON.stringify(keys)} licenseFiles=${JSON.stringify(want)}）`);
      }
    }

    if (!isArray(item.redistributionEvidence) || item.redistributionEvidence.filter((x) => isNonEmptyString(x)).length === 0) {
      problems.push(`${tag}缺 redistributionEvidence（"凭什么可以再分发"这条证据链没写）`);
    }

    for (const name of declared) {
      const bad = licenseNameProblem(name);
      if (bad) { problems.push(`${tag}的许可件名不合规：${JSON.stringify(name)} —— ${bad}`); continue; }
      const abs = path.join(manifestDir, name);
      if (!fs.existsSync(abs)) {
        problems.push(`许可文件不存在：${name}（按 manifest 所在目录解析）`);
        continue;
      }
      const want = licSha && typeof licSha === 'object' ? licSha[name] : null;
      if (!isHex64(want)) {
        problems.push(`许可文件缺 sha256：${name}`);
        continue;
      }
      const got = sha256OfFile(abs);
      if (got !== want) {
        problems.push(`许可文件 sha256 不符：${name}（manifest=${want} 实测=${got}）`);
        continue;
      }
      files.add(posix(name));
    }
  });

  // ── ④ node：版本与 hash 必须与**真的那个二进制**对上 ────────────────────────
  const nodeItem = items.find((it) => it && it.name === 'node');
  if (!nodeItem) {
    problems.push("manifest 里没有 name === 'node' 的项（运行时的许可与版本是这张清单的最小集）");
  } else {
    if (!isNonEmptyString(nodePath)) {
      problems.push('没有给 node 二进制路径（--node=<node 可执行文件>）');
    } else {
      const absNode = path.resolve(nodePath);
      if (!fs.existsSync(absNode)) {
        problems.push(`node 二进制不存在：${posix(nodePath)}`);
      } else {
        const got = sha256OfFile(absNode);
        if (isHex64(nodeItem.sha256) && got !== nodeItem.sha256) {
          problems.push(`node 二进制 sha256 不符（manifest=${nodeItem.sha256} 实测=${got}）`);
        }
        // 版本**只认这个二进制自己说的**（不许拿 process.execPath 的版本顶替）
        const r = spawnSync(absNode, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 60000 });
        if (r.error) {
          problems.push(`node 二进制跑不起来（${r.error.code || r.error.message}）—— 自证不了版本`);
        } else if (r.status !== 0) {
          problems.push(`node 二进制 \`-p process.versions.node\` 非零退出（exit ${r.status}）`);
        } else {
          const gotVer = String(r.stdout || '').trim();
          if (gotVer !== nodeItem.version) {
            problems.push(`Node 版本不符：manifest=${JSON.stringify(nodeItem.version)} 实测=${JSON.stringify(gotVer)}`);
          }
        }
      }
    }
  }

  // ── ⑤ 给了 payloadDir 就逐件核产物（"清单对了、包里那件不对"也要拦）──────────
  if (payloadDir !== null && payloadDir !== undefined) {
    const absPayload = path.resolve(String(payloadDir));
    if (!fs.existsSync(absPayload)) {
      problems.push(`payload 目录不存在：${posix(String(payloadDir))}`);
    } else {
      items.forEach((item, i) => {
        const tag = `第 ${i + 1} 项${isNonEmptyString(item && item.name) ? `（${item.name}）` : ''}`;
        if (!isNonEmptyString(item && item.path)) {
          problems.push(`${tag}缺 path（给了 payloadDir 时每项都要说清产物落在哪）`);
          return;
        }
        const abs = path.join(absPayload, item.path);
        if (!fs.existsSync(abs)) {
          problems.push(`payload 里缺产物：${posix(item.path)}`);
          return;
        }
        const got = sha256OfFile(abs);
        if (isHex64(item.sha256) && got !== item.sha256) {
          problems.push(`payload 里的产物 sha256 与 manifest 不符：${posix(item.path)}（manifest=${item.sha256} 实测=${got}）`);
          return;
        }
        files.add(`payload/${posix(item.path)}`);
      });
    }
  }

  const out = [...files].sort();
  return { ok: problems.length === 0, problems, files: out };
}

/**
 * 读 `package.json#dsh.distribution.mode`。
 *   · 键缺失 → `'private'`（**默认不发布**；"没说"不等于"可以发"）
 *   · 不是 `private|public` → **抛错**（不许静默回落：写错一个字母就悄悄变私模式，等于闸恒真）
 * @param {string} pkgJsonPath
 * @returns {'private'|'public'}
 */
function modeOf(pkgJsonPath) {
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(String(pkgJsonPath)), 'utf8');
  } catch (e) {
    throw new Error(`modeOf：读不了 package.json（${e && e.code ? e.code : e && e.message ? e.message : String(e)}）`);
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`modeOf：package.json 不是合法 JSON（${e && e.message ? e.message : String(e)}）`);
  }
  const mode = pkg && pkg.dsh && pkg.dsh.distribution ? pkg.dsh.distribution.mode : undefined;
  if (mode === undefined || mode === null) return 'private';
  if (mode === 'private' || mode === 'public') return mode;
  throw new Error(`modeOf：dsh.distribution.mode 只能是 private|public（实得 ${JSON.stringify(mode)}）—— 拒绝静默回落`);
}

module.exports = {
  MANIFEST_SCHEMA,
  RECEIPT_SCHEMA,
  verifyDistributionMaterials,
  modeOf,
};
