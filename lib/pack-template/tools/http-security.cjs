'use strict';
/**
 * http-security.cjs — 独立服务的**授权件**（T07 / 报告 D02）
 * ------------------------------------------------------------------
 * 为什么要有它（D02 原文）：
 *
 *   「恶意 Origin + `text/plain` JSON 的 `/ask` 返回 200 并写问题，**即使没有 ACAO**；
 *     无体跨源 POST `/api/clear` 返回 200 并把夹具库移到 `.trash`。」
 *
 * 也就是说：**CORS 响应头不是授权**。浏览器拦的是"攻击者读不到响应"，不是"副作用没发生"。
 * 绑 `127.0.0.1` 也不是授权 —— 它只减少网络暴露，挡不住本机浏览器里别的页面。
 *
 * 本件做的事（三条，缺一条就退回 D02）：
 *
 *   ① **能力令牌（capability）**：写操作必须带 `X-Whale-Capability`。令牌是
 *      `packId + scope + origin` 绑定的 HMAC 签名串 —— 换一个包、换一个作用域、
 *      换一个来源都用不了。跨站简单表单**根本发不出自定义请求头**；
 *      `fetch` 能发，但会先撞预检，而预检不给不可信来源任何 CORS 头。
 *   ② **来源校验**：`POST /api/session` 只给**可信来源**发令牌 ——
 *      「本站自己的来源」（由 `Host` 推出，且 Host 必须是本机回环地址）＋ 显式配置的来源。
 *      `Origin` 与 `Host` 对不上就拒。`Origin: null` **默认不认**（不盲信 null：
 *      `null` 不专属于 `file://`，沙箱 iframe 也是 `null`）——
 *      要用 `file://` 那条路必须**显式**把 `null` 放进可信来源（`--allow-file-origin`），
 *      而且还得带浏览器自己的取数元数据（`Sec-Fetch-Mode: cors`），
 *      简单表单（`Sec-Fetch-Mode: navigate`）即使开着开关也进不来。
 *   ③ **管理确认**：管理作用域（`admin`）的请求还要 `confirm: true`。
 *      令牌下发只按来源分：`reader`（课件 / 学生面）与 `admin`（管理台）**两个作用域**，
 *      课件来源拿不到 `admin` 令牌 —— 这正是卡面「课件源不能调用管理能力」。
 *
 * 接口（卡面逐字）：
 *   createCapabilities({ packId, adminOrigin, readerOrigin }) -> capabilities
 *   authorizeRequest(req, { scope, capabilities })            -> { ok, status, code, error, ... }
 *   另有：`readBody()` / `bodyConfirm()`（**先授权后读体**：确认闸在读完体之后才判）、
 *        `sessionHandler()`（`POST /api/session` 的公共实现）、`isLocalHostHeader()`。
 *
 * ⚠️ 本件随包发（进 `lib/pack-scaffold.js` 的 `TEMPLATE_FILES` 与
 *    `tools/engine-policy.cjs` 的 `ENGINE_FILES`），所以：**只依赖 node: 内置模块**，
 *    不 require 包内别的件，不写任何机器专属路径。
 *
 * 判据：`test/audit/T07.mjs`。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/** 令牌请求头（卡面钉的名字） */
const CAP_HEADER = 'x-whale-capability';
/** 两个作用域：课件 / 学生面（reader）与管理台（admin）。别的值一律拒。 */
const SCOPES = ['reader', 'admin'];
/** 令牌有效期（毫秒）。到期回 403 + `CAP_EXPIRED`，页面会重新开一次会话。 */
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** 令牌格式版本：进签名输入 —— 改格式必须让旧令牌当场失效 */
const TOKEN_VERSION = 'wcap1';
/** 会话路由（`POST /api/session`） */
const SESSION_PATH = '/api/session';
/** 管理请求要的确认字段（卡面 `confirm:true`） */
const CONFIRM_FIELD = 'confirm';

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const str = (v) => (v === undefined || v === null ? '' : String(v));
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** 回环主机名（**只认这些**：`Host` 头里的名字不是它们就拒） */
const LOCAL_HOSTNAMES = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/**
 * `Host` 头是不是本机回环地址。
 *
 * 为什么要它：`Host` 是攻击者能控的（DNS rebinding）。把 `evil.test` 解析到 127.0.0.1
 * 之后，请求的 `Host` 就是 `evil.test` —— 那时"本站自己的来源"会算成 `http://evil.test`，
 * 于是 `Origin: http://evil.test` 与它一致、被判为可信。所以**先**核 Host 的形状。
 *
 * @param {string} host `req.headers.host`
 * @returns {boolean}
 */
function isLocalHostHeader(host) {
  const raw = str(host).trim();
  if (!raw) return false;
  // 去掉端口（`[::1]:3091` 这种带方括号的要先剥括号）
  let name = raw;
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end === -1) return false;
    name = name.slice(1, end);
  } else {
    const colon = name.lastIndexOf(':');
    if (colon !== -1) name = name.slice(0, colon);
  }
  return LOCAL_HOSTNAMES.includes(name.toLowerCase());
}

/** `Host` 头 → 本站自己的来源（`http://127.0.0.1:3091`）。Host 不是回环就回 null。 */
function ownOriginOf(req) {
  const host = str(req && req.headers ? req.headers.host : '').trim();
  if (!isLocalHostHeader(host)) return null;
  return `http://${host}`;
}

/** 归一一个来源串：`http://127.0.0.1:3091/` → `http://127.0.0.1:3091`（大小写、尾斜杠、默认端口） */
function normalizeOrigin(value) {
  const raw = str(value).trim();
  if (!raw) return '';
  if (raw === 'null') return 'null';
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const def = u.protocol === 'https:' ? '443' : '80';
  return `${u.protocol}//${u.hostname.toLowerCase()}${port === def ? '' : ':' + port}`;
}

/**
 * 把一串来源值收成一个**去重后的归一清单**（`''` / 坏值一律丢掉，不静默变成"全放行"）。
 * `null` 是**显式**值（只有调用方明写它才进清单）。
 */
function originList(values) {
  const out = [];
  for (const v of Array.isArray(values) ? values : [values]) {
    if (v === undefined || v === null) continue;
    const n = normalizeOrigin(v);
    if (!n) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/* ── 运行态秘密：当前用户私有运行目录 ─────────────────────────────────────── */

/**
 * 运行目录的**唯一**算法（与 `tools/offline-server.js` 的课程库分开：秘密不进课程库）。
 * `WHALE_RUNTIME_DIR` > `%LOCALAPPDATA%/<鲸师课件>/runtime` > `~/.local/share/...`
 */
function runtimeDir() {
  const explicit = str(process.env.WHALE_RUNTIME_DIR).trim();
  if (explicit) return path.resolve(explicit);
  const base = str(process.env.LOCALAPPDATA).trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(base, '鲸师课件', 'runtime');
}

/**
 * 只属于当前用户的目录判据。
 *
 * Windows：不核 mode（NTFS 上 `chmod` 只影响只读位，核它等于自欺），
 * 但**核目录的属主 SID 就是当前用户**（`fs.statSync().uid` 在 Node 的 Windows 实现里
 * 给的是文件属主 —— 与 `process.getuid` 在本机不提供的事实一起，这里只做**尽力而为**的核对，
 * 核不了就如实说"核不了"，不假装安全）。
 * POSIX：目录 mode 必须没有 group / other 位（`0o077` 全零）。
 *
 * @returns {{ok:boolean, why:string, mode:number|null}}
 */
function privateDirVerdict(dir) {
  let st;
  try { st = fs.statSync(dir); } catch (e) { return { ok: false, why: `读不到目录（${e && e.code ? e.code : 'ERR'}）`, mode: null }; }
  if (!st.isDirectory()) return { ok: false, why: '不是目录', mode: null };
  if (process.platform === 'win32') {
    // NTFS：核不了 POSIX 位。**不假装**核过 —— 如实报"Windows 上按用户目录约定"。
    return { ok: true, why: 'Windows：按当前用户私有目录约定（NTFS 不核 POSIX 位）', mode: null };
  }
  const mode = st.mode & 0o777;
  if (mode & 0o077) return { ok: false, why: `目录权限太松（mode ${mode.toString(8)}：group/other 可读）`, mode };
  return { ok: true, why: `mode ${mode.toString(8)}（group/other 无权限）`, mode };
}

/** 秘密文件的判据（比目录更严：POSIX 上必须 0600） */
function privateFileVerdict(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { ok: false, why: `读不到文件（${e && e.code ? e.code : 'ERR'}）`, mode: null }; }
  if (!st.isFile()) return { ok: false, why: '不是普通文件', mode: null };
  if (process.platform === 'win32') return { ok: true, why: 'Windows：按当前用户私有目录约定', mode: null };
  const mode = st.mode & 0o777;
  if (mode & 0o077) return { ok: false, why: `文件权限太松（mode ${mode.toString(8)}）`, mode };
  return { ok: true, why: `mode ${mode.toString(8)}`, mode };
}

/** 把目录/文件的权限收紧（POSIX；Windows 上 chmod 只当尽力而为） */
function tighten(target, mode) {
  try { fs.chmodSync(target, mode); } catch { /* 收紧不了：下面用 verdict 复核，核不过就拒绝复用 */ }
}

/**
 * 取运行态秘密（HMAC 密钥）。
 *
 * **权限不能保证就拒绝落盘和复用**（卡面逐字）：
 *   · 目录建不出来 / 权限太松 → **不写盘**，改用**进程内临时秘密**（`persisted:false`）——
 *     临时秘密下"令牌跨进程复用"这件事**不成立**（重启即失效，页面会重开会话），
 *     这比"把秘密写进一个谁都能读的地方"正确。
 *   · 文件权限太松 → **删掉重建**（不沿用一份可疑的秘密）。
 *
 * @param {{scope?:string}} [opts] `scope` 用来把秘密按包分家（换包不串秘密）
 * @returns {{secret:Buffer, source:'private-file'|'ephemeral'|'env', persisted:boolean,
 *            dir:string, file:string, why:string, notes:string[]}}
 */
function loadRuntimeSecret(opts = {}) {
  const notes = [];
  const envSecret = str(process.env.WHALE_RUNTIME_SECRET).trim();
  if (envSecret) {
    // 显式给了就用它（判据 / 部署用）。**仍然要 ≥32 字节**，短的当场拒（不许悄悄补零）
    if (envSecret.length < 32) {
      return { secret: crypto.randomBytes(32), source: 'ephemeral', persisted: false, dir: '', file: '', why: 'WHALE_RUNTIME_SECRET 太短（<32 字符）—— 拒绝使用，改用临时秘密', notes };
    }
    return { secret: crypto.createHash('sha256').update(envSecret).digest(), source: 'env', persisted: false, dir: '', file: '', why: '来自 WHALE_RUNTIME_SECRET', notes };
  }

  const dir = runtimeDir();
  const file = path.join(dir, 'session-secret');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { secret: crypto.randomBytes(32), source: 'ephemeral', persisted: false, dir, file, why: `运行目录建不出来（${e && e.message ? e.message : e}）—— 拒绝落盘，改用临时秘密`, notes };
  }
  tighten(dir, 0o700);
  const dv = privateDirVerdict(dir);
  if (!dv.ok) {
    return { secret: crypto.randomBytes(32), source: 'ephemeral', persisted: false, dir, file, why: `运行目录权限保证不了（${dv.why}）—— 拒绝落盘与复用`, notes };
  }
  notes.push(`运行目录：${dir}（${dv.why}）`);

  // 已有的秘密：**先核权限再复用**（可疑就删掉重建，绝不沿用）
  if (fs.existsSync(file)) {
    const fv = privateFileVerdict(file);
    if (!fv.ok) {
      notes.push(`已有秘密文件的权限保证不了（${fv.why}）—— 不复用，删掉重建`);
      try { fs.unlinkSync(file); } catch { /* 删不掉就走下面的"写不进"分支 */ }
    } else {
      try {
        const raw = fs.readFileSync(file, 'utf8').trim();
        const buf = Buffer.from(raw, 'base64');
        if (buf.length >= 32) {
          return { secret: buf, source: 'private-file', persisted: true, dir, file, why: `复用私有运行目录里的秘密（${fv.why}）`, notes };
        }
        notes.push('已有秘密文件内容太短 —— 不复用，重建');
      } catch (e) {
        notes.push(`已有秘密文件读不动（${e && e.message ? e.message : e}）—— 重建`);
      }
    }
  }

  const secret = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, secret.toString('base64') + '\n', { encoding: 'utf8', mode: 0o600, flag: 'w' });
    tighten(file, 0o600);
  } catch (e) {
    return { secret, source: 'ephemeral', persisted: false, dir, file, why: `秘密写不进私有运行目录（${e && e.message ? e.message : e}）—— 本次用临时秘密`, notes };
  }
  const fv2 = privateFileVerdict(file);
  if (!fv2.ok) {
    // 写完复核不过：**删掉**并退回临时秘密（不留一份谁都能读的秘密在盘上）
    try { fs.unlinkSync(file); } catch { /* 尽力 */ }
    return { secret, source: 'ephemeral', persisted: false, dir, file, why: `写完复核权限不过（${fv2.why}）—— 已删掉，本次用临时秘密`, notes };
  }
  notes.push(`秘密文件：${file}（${fv2.why}）`);
  return { secret, source: 'private-file', persisted: true, dir, file, why: '新建并落到私有运行目录', notes };
}

/* ── 令牌 ───────────────────────────────────────────────────────────────── */

/** 签名输入（**逐字段**都在里面：少一个字段就等于少一道绑定） */
function signInput(payload) {
  return [TOKEN_VERSION, payload.pack, payload.scope, payload.origin, String(payload.exp), payload.nonce].join('\n');
}

function sign(payload, secret) {
  return b64u(crypto.createHmac('sha256', secret).update(signInput(payload)).digest());
}

/**
 * 造一个能力令牌。
 * @param {{pack:string, scope:string, origin:string, exp:number, secret:Buffer}} spec
 */
function mintToken(spec) {
  const payload = {
    pack: str(spec.pack),
    scope: str(spec.scope),
    origin: str(spec.origin),
    exp: Number(spec.exp),
    nonce: crypto.randomBytes(9).toString('hex'),
  };
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${TOKEN_VERSION}.${body}.${sign(payload, spec.secret)}`;
}

/** 解开并核验一个令牌；任何一步不过都**不给部分结论**（返回 `{ok:false, code}`） */
function openToken(token, secret, now) {
  const raw = str(token).trim();
  if (!raw) return { ok: false, code: 'CAP_MISSING', error: '没有能力令牌' };
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { ok: false, code: 'CAP_MALFORMED', error: `令牌形状不对（要 ${TOKEN_VERSION}.<载荷>.<签名>）` };
  }
  let payload;
  try { payload = JSON.parse(unb64u(parts[1]).toString('utf8')); } catch { return { ok: false, code: 'CAP_MALFORMED', error: '令牌载荷不是合法 JSON' }; }
  if (!payload || typeof payload !== 'object') return { ok: false, code: 'CAP_MALFORMED', error: '令牌载荷不是对象' };
  const expect = sign(payload, secret);
  const a = Buffer.from(expect);
  const b = Buffer.from(str(parts[2]));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, code: 'CAP_BAD_SIGNATURE', error: '令牌签名不对（不是这个服务发的，或秘密已经换过）' };
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= now) {
    return { ok: false, code: 'CAP_EXPIRED', error: '令牌过期了 —— 重新开一次会话（POST /api/session）' };
  }
  if (!SCOPES.includes(payload.scope)) return { ok: false, code: 'CAP_BAD_SCOPE', error: `令牌作用域不认识：${JSON.stringify(payload.scope)}` };
  return { ok: true, payload };
}

/* ── 能力集 ─────────────────────────────────────────────────────────────── */

/**
 * 建一份能力集（卡面接口）。
 *
 * @param {{packId?:string, adminOrigin?:string|string[], readerOrigin?:string|string[],
 *          selfScope?:'reader'|'admin', adminPaths?:string[],
 *          trustFileOrigin?:boolean, secret?:Buffer, now?:()=>number}} spec
 *   `adminOrigin` —— 管理台自己的来源（**只有它**能换到 `admin` 令牌）
 *   `readerOrigin` —— 课件 / 学生面的来源（换 `reader` 令牌）
 *   `selfScope` —— **本服务自己的来源（由 Host 推）只服务哪一个作用域**（缺省 `reader`）。
 *                 为什么必须有它：不然"本站来源"会对**任何**作用域放行 ——
 *                 课程包自己的服务（`tools/app-server.js`）也就能签发 `admin` 令牌了，
 *                 分源隔离当场失效。`tools/offline-server.js` 传 `'admin'`（它才是管理台），
 *                 课程包自己的服务保持 `'reader'`。
 *   `adminPaths` —— 管理令牌**只从这些路径的页面**换（看 `Referer` 的 pathname）。
 *                 为什么：管理台与它反代的课件页**同源**，光看来源分不出"是管理页还是课件页"；
 *                 课件页住在 `/<包名>/…` 下，管理页住在 `/`。没有 `Referer`（非浏览器调用）时放行 ——
 *                 那类调用本来就没有 CSRF 面。
 *   `trustFileOrigin` —— 显式把 `null` 放进**只读作用域**的可信来源（`file://` 那条路；
 *                        默认关，且仍然要求取数元数据是 `cors`，简单表单进不来）
 * @returns {object} capabilities（`authorize()` / `mint()` / `sessionHandler()` / `describe()`）
 */
function createCapabilities(spec = {}) {
  const packId = str(spec.packId) || 'pack';
  const secretInfo = spec.secret ? { secret: spec.secret, source: 'given', persisted: false, dir: '', file: '', why: '调用方直接给了秘密', notes: [] }
    : loadRuntimeSecret({ scope: packId });
  const secret = secretInfo.secret;
  const now = typeof spec.now === 'function' ? spec.now : () => Date.now();

  const adminOrigins = originList(spec.adminOrigin);
  const readerOrigins = originList(spec.readerOrigin);
  const trustFileOrigin = spec.trustFileOrigin === true;
  const selfScope = SCOPES.includes(str(spec.selfScope)) ? str(spec.selfScope) : 'reader';
  const adminPaths = Array.isArray(spec.adminPaths) && spec.adminPaths.length ? spec.adminPaths.map(String) : null;
  if (trustFileOrigin && !readerOrigins.includes('null')) readerOrigins.push('null');

  /** 某个来源在某个作用域下可信吗 */
  function originTrusted(origin, scope) {
    const o = normalizeOrigin(origin);
    if (!o) return false;
    if (scope === 'admin') return adminOrigins.includes(o);
    if (scope === 'reader') return readerOrigins.includes(o) || adminOrigins.includes(o);
    return false;
  }

  /** 这次请求的"来源"：`{kind:'none'|'origin'|'opaque', value, meta}` */
  function requestOrigin(req) {
    const headers = (req && req.headers) || {};
    const raw = headers.origin;
    const meta = {
      mode: str(headers['sec-fetch-mode']).toLowerCase(),
      site: str(headers['sec-fetch-site']).toLowerCase(),
      dest: str(headers['sec-fetch-dest']).toLowerCase(),
    };
    if (raw === undefined || raw === null || str(raw) === '') return { kind: 'none', value: '', meta };
    const n = normalizeOrigin(raw);
    if (!n) return { kind: 'origin', value: str(raw), meta, unparsable: true };
    if (n === 'null') return { kind: 'opaque', value: 'null', meta };
    return { kind: 'origin', value: n, meta };
  }

  /** 本站自己的来源（由 Host 推；Host 不是回环 → null） */
  function ownOrigin(req) { return ownOriginOf(req); }

  /**
   * 管理令牌的**页面**闸：`Referer` 的 pathname 要在 `adminPaths` 里。
   * 没有 `Referer`（curl / 判据驱动这类非浏览器调用）→ 放行（那类调用没有 CSRF 面）。
   */
  function adminPageOk(req) {
    if (!adminPaths) return { ok: true, how: '（没有配 adminPaths）' };
    const headers = (req && req.headers) || {};
    const ref = str(headers.referer || headers.referrer).trim();
    if (!ref) return { ok: true, how: '没有 Referer（非浏览器调用）' };
    let p = '';
    try { p = new URL(ref).pathname } catch { return { ok: false, code: 'ADMIN_REFERER_BAD', error: `Referer 读不懂：${ref}` } }
    // ⚠️ **逐字相等**，不是前缀：`'/'` 当前缀会匹配**所有**路径（课件页 `/library/…` 也会中）
    const hit = adminPaths.some((x) => p === x);
    if (!hit) {
      return { ok: false, code: 'ADMIN_REFERER_NOT_ADMIN', error: `管理令牌只发给管理页（${adminPaths.join(' / ')}），这次来自 ${p}` };
    }
    return { ok: true, how: `Referer=${p}` };
  }

  /** 这个来源（对本请求而言）可信吗 */
  function trustedFor(req, scope) {
    const info = requestOrigin(req);
    const own = ownOrigin(req);
    if (info.kind === 'none') return { ok: true, how: 'no-origin（非浏览器调用：CSRF 的前提不成立）', origin: '' };
    if (info.unparsable) return { ok: false, code: 'ORIGIN_BAD', error: `Origin 头读不懂：${JSON.stringify(info.value)}` };
    if (info.kind === 'opaque') {
      if (!trustFileOrigin) {
        return { ok: false, code: 'ORIGIN_OPAQUE_DENIED', error: 'Origin: null 默认不认（null 不专属于 file:// 页面）—— 要用 file:// 那条路请显式开 --allow-file-origin' };
      }
      // 显式开了之后**仍然**要求这是浏览器的一次取数（cors），不是简单表单（navigate）
      if (info.meta.mode !== 'cors') {
        return { ok: false, code: 'ORIGIN_OPAQUE_NOT_FETCH', error: `Origin: null 只认浏览器的取数请求（Sec-Fetch-Mode: cors），收到 ${JSON.stringify(info.meta.mode || '（没有这个头）')}` };
      }
      if (scope !== 'reader') {
        return { ok: false, code: 'ORIGIN_SCOPE_MISMATCH', error: `file:// 那条路只服务 reader 作用域，这次要 ${scope}` };
      }
      return { ok: true, how: 'file:// 显式开关 + Sec-Fetch-Mode: cors', origin: 'null' };
    }
    // 普通来源：本站自己的（Host 推出）或显式配置的
    const v = info.value;
    if (own && v === own) {
      // ⚠️ 「本站来源」**逐作用域**放行：本服务声明它服务哪个作用域（`selfScope`），
      //    另一个作用域必须走**显式配置的来源** —— 否则课程包自己的服务也能签发管理令牌。
      if (scope !== selfScope) {
        return {
          ok: false,
          code: 'ORIGIN_SCOPE_MISMATCH',
          error: `本站来源只服务 ${selfScope} 作用域，这次要 ${scope}（管理能力只给显式配置的管理来源）`,
        };
      }
      if (scope === 'admin') {
        const page = adminPageOk(req);
        if (!page.ok) return { ok: false, code: page.code, error: page.error };
        return { ok: true, how: `本站来源（Host=${str(req.headers.host)}）· ${page.how}`, origin: v };
      }
      return { ok: true, how: `本站来源（Host=${str(req.headers.host)}，selfScope=${selfScope}）`, origin: v };
    }
    if (originTrusted(v, scope) || originTrusted(v, 'reader') || originTrusted(v, 'admin')) {
      if (scope === 'admin') {
        const page = adminPageOk(req);
        if (!page.ok) return { ok: false, code: page.code, error: page.error };
        return { ok: true, how: `显式配置的可信来源 · ${page.how}`, origin: v };
      }
      return { ok: true, how: '显式配置的可信来源', origin: v };
    }
    return { ok: false, code: 'ORIGIN_UNTRUSTED', error: `来源不在可信清单里：${v}（本站是 ${own || '（Host 不是本机回环地址）'}）` };
  }

  /**
   * 授权一次请求（卡面接口）。
   *
   * @param {object} req node 的 IncomingMessage
   * @param {{scope?:string, needConfirm?:boolean, confirm?:boolean}} opts
   *   `scope`：`reader` / `admin`（缺省 `reader`）
   *   `needConfirm`：这次请求是不是"管理写口"（要 `confirm:true`）
   *   `confirm`：**调用方读体之后**判出来的确认位（先授权后读体：这里只判已读到的值）
   * @returns {{ok:boolean, status:number, code:string, error:string, scope:string, origin:string, how:string, needConfirm:boolean}}
   */
  function authorize(req, opts = {}) {
    const scope = str(opts.scope) || 'reader';
    const needConfirm = opts.needConfirm === true;
    const base = { ok: false, status: 403, code: 'DENIED', error: '拒绝', scope, origin: '', how: '', needConfirm };
    if (!SCOPES.includes(scope)) {
      return { ...base, code: 'SCOPE_UNKNOWN', error: `不认识的作用域：${JSON.stringify(opts.scope)}` };
    }
    // ① Host 必须是本机回环（挡 DNS rebinding）
    const host = str(req && req.headers ? req.headers.host : '');
    if (!isLocalHostHeader(host)) {
      return { ...base, code: 'HOST_NOT_LOCAL', error: `Host 不是本机回环地址：${JSON.stringify(host || '（没有 Host）')} —— 独立服务只服务本机` };
    }
    // ② 来源
    const trust = trustedFor(req, scope);
    if (!trust.ok) return { ...base, code: trust.code, error: trust.error };
    // ③ 能力令牌
    const headers = (req && req.headers) || {};
    const token = str(headers[CAP_HEADER] || headers[CAP_HEADER.toUpperCase()] || '');
    const info = requestOrigin(req);
    if (info.kind === 'none') {
      // 非浏览器调用：没有 Origin，也就没有 CSRF 面。仍然**记录**没带令牌这件事。
      if (needConfirm && opts.confirm !== true) {
        return { ...base, code: 'CONFIRM_REQUIRED', error: '管理操作要显式确认（confirm:true）', origin: '', how: trust.how };
      }
      return { ok: true, status: 200, code: 'OK_NO_ORIGIN', error: '', scope, origin: '', how: trust.how, needConfirm, token: null };
    }
    if (!token) {
      return { ...base, code: 'CAP_MISSING', error: '跨源请求必须带 X-Whale-Capability（先 POST /api/session 开一次会话）', origin: info.value, how: trust.how };
    }
    const opened = openToken(token, secret, now());
    if (!opened.ok) return { ...base, code: opened.code, error: opened.error, origin: info.value, how: trust.how };
    const p = opened.payload;
    if (str(p.pack) !== packId) {
      return { ...base, code: 'CAP_WRONG_PACK', error: `令牌是别的课程包发的（${p.pack} ≠ ${packId}）`, origin: info.value, how: trust.how };
    }
    if (str(p.scope) !== scope) {
      return { ...base, code: 'CAP_WRONG_SCOPE', error: `令牌作用域是 ${p.scope}，这次要 ${scope}`, origin: info.value, how: trust.how };
    }
    if (str(p.origin) !== info.value) {
      return { ...base, code: 'CAP_WRONG_ORIGIN', error: `令牌是发给 ${p.origin} 的，这次请求来自 ${info.value}（换一个来源就用不了）`, origin: info.value, how: trust.how };
    }
    if (needConfirm && opts.confirm !== true) {
      return { ...base, code: 'CONFIRM_REQUIRED', error: '管理操作要显式确认（confirm:true）', origin: info.value, how: trust.how };
    }
    return { ok: true, status: 200, code: 'OK', error: '', scope, origin: info.value, how: trust.how, needConfirm, token: { exp: p.exp, nonce: p.nonce } };
  }

  /** 按来源给这个作用域发一个令牌（来源不可信 → `{ok:false, status:403}`） */
  function mint(req, scope) {
    const s = str(scope) || 'reader';
    if (!SCOPES.includes(s)) return { ok: false, status: 400, code: 'SCOPE_UNKNOWN', error: `不认识的作用域：${JSON.stringify(scope)}（只认 ${SCOPES.join(' / ')}）` };
    const host = str(req && req.headers ? req.headers.host : '');
    if (!isLocalHostHeader(host)) {
      return { ok: false, status: 403, code: 'HOST_NOT_LOCAL', error: `Host 不是本机回环地址：${JSON.stringify(host || '（没有 Host）')}` };
    }
    const trust = trustedFor(req, s);
    if (!trust.ok) return { ok: false, status: 403, code: trust.code, error: trust.error };
    const info = requestOrigin(req);
    const exp = now() + TOKEN_TTL_MS;
    return {
      ok: true, status: 200, code: 'OK',
      token: mintToken({ pack: packId, scope: s, origin: info.value, exp, secret }),
      scope: s, origin: info.value, exp, how: trust.how,
    };
  }

  /** 这个来源能不能拿这个作用域（只判来源，不发令牌 —— 给判据用） */
  function canMint(req, scope) {
    const s = str(scope) || 'reader';
    if (!SCOPES.includes(s)) return { ok: false, code: 'SCOPE_UNKNOWN' };
    if (!isLocalHostHeader(str(req && req.headers ? req.headers.host : ''))) return { ok: false, code: 'HOST_NOT_LOCAL' };
    const t = trustedFor(req, s);
    return t.ok ? { ok: true, how: t.how, origin: t.origin } : { ok: false, code: t.code, error: t.error };
  }

  return {
    packId, adminOrigins, readerOrigins, trustFileOrigin, selfScope, adminPaths,
    authorize, mint, canMint, originTrusted, requestOrigin, ownOrigin, adminPageOk,
    describe() {
      return {
        packId, adminOrigins: [...adminOrigins], readerOrigins: [...readerOrigins],
        trustFileOrigin, selfScope, adminPaths: adminPaths ? [...adminPaths] : null,
        secret: { source: secretInfo.source, persisted: secretInfo.persisted, dir: secretInfo.dir, file: secretInfo.file, why: secretInfo.why, notes: [...secretInfo.notes] },
        header: CAP_HEADER, sessionPath: SESSION_PATH, scopes: [...SCOPES], ttlMs: TOKEN_TTL_MS,
      };
    },
  };
}

/* ── 请求体（**先授权后读体**：读体只在这一处） ───────────────────────────── */

/** 单次请求体的硬上限（管理端点：导入走原始 zip 字节，不进这里） */
const BODY_MAX = 256 * 1024;

/**
 * 读一次请求体（有上限、有错误分支）。
 * @returns {Promise<{ok:boolean, text:string, code?:string, error?:string}>}
 */
function readBody(req, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : BODY_MAX;
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { finish({ ok: false, code: 'BODY_TOO_BIG', error: `请求体超过 ${max} 字节` }); try { req.destroy(); } catch { /* 已断 */ } return; }
      chunks.push(c);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, code: 'BODY_STREAM_ERROR', error: '读请求体时断了' }));
  });
}

/**
 * 请求体 → 确认位。
 *
 * ⚠️ 这里**只认显式的 `true`**：`"true"` / `1` / 缺字段一律不算确认
 * （卡面写的是 `confirm:true`；把字符串也算上就等于把闸门放宽）。
 * `queryConfirm` 给 `?confirm=1` 那条既有写法留的口子（`/api/migrate` 在用）。
 */
function bodyConfirm(text, opts = {}) {
  let doc = null;
  const raw = str(text).trim();
  if (raw) {
    try { doc = JSON.parse(raw); } catch { doc = null; }
  }
  if (doc && typeof doc === 'object' && !Array.isArray(doc) && doc[CONFIRM_FIELD] === true) {
    return { confirm: true, doc, how: 'body.confirm===true' };
  }
  if (opts.queryConfirm === true) return { confirm: true, doc, how: 'query confirm' };
  return { confirm: false, doc, how: doc ? `body.confirm=${JSON.stringify(doc[CONFIRM_FIELD])}` : '（没有确认字段）' };
}

/* ── 会话路由（POST /api/session） ───────────────────────────────────────── */

/**
 * `POST /api/session` 的公共实现：可信来源 → 发一个该作用域的令牌。
 *
 * 请求体可选 `{ scope: 'reader' | 'admin' }`（缺省 `reader`）。
 * 响应**不带任何 CORS 头**：令牌只回给同源 / 可信来源那一屏。
 *
 * @param {object} req
 * @param {object} res
 * @param {object} capabilities `createCapabilities()` 的产物
 * @param {{readBodyImpl?:Function}} [deps] 判据可以注入一个假的读体函数
 * @returns {Promise<{status:number, body:object}>} 同时也已经把响应写出去了
 */
async function sessionHandler(req, res, capabilities, deps = {}) {
  const read = typeof deps.readBodyImpl === 'function' ? deps.readBodyImpl : readBody;
  const r = await read(req, { max: 8 * 1024 });
  let scope = 'reader';
  if (r.ok && str(r.text).trim()) {
    let doc = null;
    try { doc = JSON.parse(r.text); } catch { doc = null; }
    if (doc && typeof doc === 'object' && !Array.isArray(doc) && doc.scope !== undefined) scope = str(doc.scope);
  }
  const out = capabilities.mint(req, scope);
  const status = out.ok ? 200 : (out.status || 403);
  const body = out.ok
    ? { ok: true, scope: out.scope, origin: out.origin, token: out.token, exp: out.exp, header: CAP_HEADER, ttlMs: TOKEN_TTL_MS, how: out.how }
    : { ok: false, code: out.code, error: out.error };
  if (res && typeof res.writeHead === 'function') {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  }
  return { status, body };
}

/**
 * 统一的 403 回执（**不动盘**：拒绝路径上没有任何写操作）。
 * 形状与三个服务自己的 `json()` 一致：`{ok:false, code, error}`。
 */
function denyBody(verdict) {
  return {
    ok: false,
    code: verdict && verdict.code ? verdict.code : 'DENIED',
    error: verdict && verdict.error ? verdict.error : '拒绝',
    scope: verdict && verdict.scope ? verdict.scope : undefined,
    origin: verdict && verdict.origin ? verdict.origin : undefined,
  };
}

module.exports = {
  // 卡面接口
  createCapabilities,
  authorizeRequest: (req, opts) => {
    const caps = opts && opts.capabilities;
    if (!caps || typeof caps.authorize !== 'function') {
      throw new Error('authorizeRequest：必须给 capabilities（createCapabilities() 的产物）');
    }
    return caps.authorize(req, opts);
  },
  // 其余公共件
  CAP_HEADER,
  SCOPES,
  SESSION_PATH,
  TOKEN_TTL_MS,
  CONFIRM_FIELD,
  isLocalHostHeader,
  ownOriginOf,
  normalizeOrigin,
  originList,
  runtimeDir,
  loadRuntimeSecret,
  privateDirVerdict,
  privateFileVerdict,
  mintToken,
  openToken,
  readBody,
  bodyConfirm,
  sessionHandler,
  denyBody,
  BODY_MAX,
};
