'use strict';
/** Request-local failures only: no process-wide exception handlers or restarts. */
class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requestUrl(req, validateEncoding = true) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (validateEncoding) decodeURIComponent(req.url);
    return url;
  } catch {
    throw new RequestError(400, 'BAD_URL_ENCODING', '请求 URL 编码不合法');
  }
}

/** Byte-counted, bounded transport reader. Every terminal event settles exactly once.
 * Keep the request-local error listener after settlement: a late stream error must
 * not become an unhandled EventEmitter error. No listener retains body buffers.
 */
function readBodyBytes(req, { maxBytes = 16 * 1024, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let size = 0;
    let chunks = [];
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
      chunks = [];
      if (err) { reject(err); if (!req.destroyed) req.resume(); }
      else resolve(value);
    };
    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) return finish(new RequestError(413, 'BODY_TOO_BIG', `请求体超过 ${maxBytes} 字节`));
      chunks.push(buf);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onError = () => finish(new RequestError(400, 'BODY_STREAM_ERROR', '读请求体时断了'));
    const onAborted = () => finish(new RequestError(400, 'BODY_ABORTED', '客户端已中止请求'));
    const onClose = () => { if (!req.complete) onAborted(); };
    const timer = setTimeout(() => finish(new RequestError(400, 'BODY_TIMEOUT', '读请求体超过 5 秒截止时间')), timeoutMs);
    req.on('data', onData);
    req.once('end', onEnd);
    req.on('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
    if (req.aborted || req.destroyed) onAborted();
  });
}

async function readJsonObject(req, opts = {}) {
  const bytes = await readBodyBytes(req, opts);
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  let value;
  try { value = JSON.parse(text || '{}'); }
  catch { throw new RequestError(400, 'BAD_JSON', 'JSON 解析失败'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'JSON_OBJECT_REQUIRED', '请求体必须是 JSON 对象');
  }
  return value;
}

/** Public sessionHandler dependency seam: throw before mint on invalid input. */
async function sessionReadBody(req, opts) {
  const doc = await readJsonObject(req, { maxBytes: opts.max });
  return { ok: true, text: JSON.stringify(doc) };
}

function writable(res) {
  return !res.destroyed && !res.writableEnded && !res.headersSent;
}
function respondError(res, err) {
  if (!writable(res)) return;
  const known = err instanceof RequestError;
  const status = known ? err.status : 500;
  const text = JSON.stringify({ ok: false, code: known ? err.code : 'INTERNAL_ERROR', error: known ? err.message : '服务端异常' });
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}
function withRequestBoundary(handler) {
  return function boundedRequest(req, res) {
    try {
      return Promise.resolve(handler(req, res)).catch((err) => respondError(res, err));
    } catch (err) {
      respondError(res, err);
      return Promise.resolve();
    }
  };
}
module.exports = { RequestError, requestUrl, readBodyBytes, readJsonObject, sessionReadBody, writable, respondError, withRequestBoundary };
