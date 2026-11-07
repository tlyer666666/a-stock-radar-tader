'use strict';
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const unzip = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
const sizeError = () => Object.assign(new Error('响应体超过字节上限'), { code: 'RESPONSE_TOO_LARGE' });
const aborted = signal => signal.reason || new DOMException('请求已取消', 'AbortError');

// Electron 44's embedded fetch can emit an unhandled error before returning a
// Response for excessive content-encodings (GHSA-xjj6-f33q-929c). Use only Node's
// public HTTP APIs on affected versions. All callers retain http-client policy.
function requiresNativeTransport(version = process.versions.undici) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  if (!match) return true;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major === 6 ? minor >= 23 && (minor < 29 || (minor === 29 && patch < 1))
    : major === 7 ? minor >= 18 && (minor < 30 || (minor === 30 && patch < 1))
      : major === 8 && (minor < 12 || (minor === 12 && patch < 2));
}

// Market requests use string/bytes/URLSearchParams bodies, not streaming uploads.
// Buffer wire and decoded bodies under the same ceiling; attach every stream's
// error handler before checking headers, so malformed/truncated replies settle.
async function fetchNative(input, options = {}, limit = 32 * 1024 * 1024, depth = 0) {
  const url = new URL(String(input));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('不支持的行情请求地址');
  const signal = options.signal;
  if (signal?.aborted) throw aborted(signal);
  const headers = new Headers(options.headers);
  const method = String(options.method || 'GET').toUpperCase();
  let body = options.body;
  if (body instanceof URLSearchParams) { body = body.toString(); if (!headers.has('content-type')) headers.set('content-type','application/x-www-form-urlencoded;charset=UTF-8'); }
  if (body != null && typeof body !== 'string' && !ArrayBuffer.isView(body) && !(body instanceof ArrayBuffer)) throw new TypeError('不支持流式行情请求体');
  if (body instanceof ArrayBuffer) body = new Uint8Array(body);
  if (['GET','HEAD'].includes(method) && body != null) throw new TypeError('GET/HEAD不支持请求体');
  if (body != null && !headers.has('content-length')) {
    const byteLength = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
    headers.set('content-length', String(byteLength));
  }
  return new Promise((resolve, reject) => {
    let settled = false, response, decoder, failure;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finishFailure = error => { if (settled) return; settled = true; cleanup(); reject(error); };
    const fail = error => {
      if (settled || failure) return;
      failure = error; response?.destroy(); request.destroy();
      // Cancellation does not release the outer transport lease until the
      // active zlib handle actually closes.
      if (decoder && !decoder.closed) { decoder.once('close', () => finishFailure(error)); decoder.destroy(error); }
      else finishFailure(error);
    };
    const decode = (coding, bytes) => new Promise((resolveDecode, rejectDecode) => {
      const stream = unzip[coding](); decoder = stream;
      const chunks = []; let total = 0, ended = false, error;
      stream.on('error', value => { error = value; });
      stream.on('data', chunk => { total += chunk.length; if (total > limit) stream.destroy(sizeError()); else chunks.push(chunk); });
      stream.once('end', () => { ended = true; });
      stream.once('close', () => {
        if (decoder === stream) decoder = null;
        if (error || failure || !ended) rejectDecode(error || failure || new Error('行情解压中断'));
        else resolveDecode(Buffer.concat(chunks));
      });
      stream.end(bytes);
    });
    const abort = () => fail(aborted(signal));
    const request = (url.protocol === 'https:' ? https : http).request(url, { method, headers: Object.fromEntries(headers), signal }, incoming => {
      response = incoming;
      try {
      incoming.on('error', fail);
      incoming.on('aborted', () => fail(Object.assign(new Error('行情响应提前断开'), { code: 'ECONNRESET' })));
      const responseHeaders = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      const status = incoming.statusCode || 500;
      const location = responseHeaders.get('location');
      if (location && [301,302,303,307,308].includes(status) && options.redirect !== 'manual') {
        if (options.redirect === 'error' || depth >= 10) { fail(new TypeError('行情重定向失败或次数过多')); return; }
        const next = new URL(location,url);
        // 不允许从 https 降级到 http，避免令牌和请求体明文外泄。
        if (url.protocol === 'https:' && next.protocol !== 'https:') { fail(new TypeError('行情重定向被拒绝：不允许从 HTTPS 降级')); return; }
        const nextOptions = { ...options, headers: new Headers(headers) };
        const crossOrigin = next.origin !== url.origin;
        if (crossOrigin) for (const name of ['authorization','proxy-authorization','cookie','host','x-api-key','api-key','apikey','access_token','access-token','x-access-token','refresh_token','refresh-token','x-auth-token','token']) nextOptions.headers.delete(name);
        const dropsBody = ([301,302].includes(status) && method === 'POST') || (status === 303 && !['GET','HEAD'].includes(method));
        if (dropsBody) {
          nextOptions.method = 'GET'; nextOptions.body = undefined;
          for (const name of ['content-type','content-length','content-encoding','transfer-encoding']) nextOptions.headers.delete(name);
        } else if (crossOrigin && body != null) {
          // 307/308 会原样重发请求体（可能带 token），跨域时直接失败。
          fail(new TypeError('行情重定向被拒绝：不向其他站点重发请求体')); return;
        }
        settled = true; cleanup(); incoming.destroy(); request.destroy();
        fetchNative(next,nextOptions,limit,depth+1).then(resolve,reject); return;
      }
      const noBody = method === 'HEAD' || [204,205,304].includes(status);
      const codings = noBody ? [] : (responseHeaders.get('content-encoding') || '').toLowerCase().split(',').map(v=>v.trim()).filter(v=>v && v!=='identity');
      if (codings.length > 5 || codings.some(coding => !unzip[coding])) { fail(Object.assign(new Error('行情响应压缩编码不受支持'), { code: 'INVALID_CONTENT_ENCODING' })); return; }
      const declared = Number(responseHeaders.get('content-length'));
      if (!noBody && declared > limit) { fail(sizeError()); return; }
      const chunks = []; let received = 0;
      incoming.on('data', chunk => { if (settled) return; received += chunk.length; if (received > limit) fail(sizeError()); else chunks.push(chunk); });
      incoming.once('end', async () => {
        if (settled) return;
        try {
          let bytes = Buffer.concat(chunks);
          for (const coding of [...codings].reverse()) {
            if (signal?.aborted) throw aborted(signal);
            bytes = await decode(coding, bytes);
            if (bytes.length > limit) throw sizeError();
          }
          if (settled) return;
          if (signal?.aborted) throw aborted(signal);
          const result = new Response(noBody ? null : bytes, { status, statusText: incoming.statusMessage || '', headers: responseHeaders });
          Object.defineProperties(result, { url: { value: url.href }, redirected: { value: depth > 0 } });
          settled = true; cleanup(); resolve(result);
        } catch (error) { fail(error); }
      });
      } catch (error) { fail(error); }
    });
    request.on('error', fail);
    for (const event of ['upgrade','connect']) request.on(event, (_response, socket) => { socket.destroy(); fail(new TypeError('不支持行情连接升级')); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { request.end(body); } catch (error) { fail(error); }
  });
}
module.exports = { fetchNative, requiresNativeTransport };
