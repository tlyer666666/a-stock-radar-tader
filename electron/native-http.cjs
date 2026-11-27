'use strict';
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const { isIP } = require('node:net');
const zlib = require('node:zlib');
const unzip = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
const sizeError = () => Object.assign(new Error('响应体超过字节上限'), { code: 'RESPONSE_TOO_LARGE' });
const publicIpError = (message = '拒绝访问非公网地址') => Object.assign(new Error(message), { code: 'PUBLIC_IP_REQUIRED' });
const aborted = signal => signal.reason || new DOMException('请求已取消', 'AbortError');

function expandIPv6(address) {
  let text = address;
  const lastColon = text.lastIndexOf(':');
  if (lastColon >= 0 && text.includes('.')) {
    const tail = text.slice(lastColon + 1);
    if (isIP(tail) !== 4) return null;
    const octets = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (parts.length !== 8) return null;
  const groups = parts.map(part => parseInt(part, 16));
  return groups.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null;
}

/** 仅允许公网单播 IP（拒绝回环、私网、CGNAT、链路本地、保留/基准测试、组播及 IPv4 映射地址）。 */
function isPublicUnicastIp(ip) {
  if (typeof ip !== 'string') return false;
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!addr || addr.includes('%')) return false;
  const family = isIP(addr);
  if (family === 4) {
    const [a, b, c] = addr.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (family === 6) {
    const g = expandIPv6(addr);
    if (!g) return false;
    // 仅放行 IANA 全局单播段 2000::/3，天然拦截 ::/96、::ffff:0:0/96、::ffff:0:0:0/96、
    // 64:ff9b::/96、64:ff9b:1::/48、100::/64、fc00::/7、fe80::/10、fec0::/10、ff00::/8 及未分配段。
    if ((g[0] & 0xe000) !== 0x2000) return false;
    // 剔除 2000::/3 内的保留/隧道/文档/基准测试子段：
    // 2001:0::/32（Teredo）、2001:2::/48（基准测试）、2001:10::/28 与 2001:20::/28（ORCHID/ORCHIDv2）、
    // 2001:db8::/32（文档保留）、2002::/16（6to4）、3fff::/20（RFC 9637 文档保留）。
    if (g[0] === 0x2001 && g[1] === 0x0000) return false;
    if (g[0] === 0x2001 && g[1] === 0x0002 && g[2] === 0x0000) return false;
    if (g[0] === 0x2001 && ((g[1] & 0xfff0) === 0x0010 || (g[1] & 0xfff0) === 0x0020)) return false;
    if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
    if (g[0] === 0x2002) return false;
    if (g[0] === 0x3fff && (g[1] & 0xf000) === 0x0000) return false;
    return true;
  }
  return false;
}

/** 自定义 DNS lookup：校验全部解析结果均为公网单播地址，并将已校验 IP 直接交给 Socket 防止 DNS 重绑定。 */
function createPublicLookup(lookupFn = dns.lookup) {
  return function publicLookup(hostname, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    const wantAll = Boolean(opts && opts.all);
    const requestedFamily = opts && (opts.family === 4 || opts.family === 6) ? opts.family : 0;
    lookupFn(hostname, { all: true }, (err, addresses) => {
      if (err) { callback(err); return; }
      const list = Array.isArray(addresses)
        ? addresses
        : (addresses ? [{ address: addresses, family: isIP(String(addresses)) }] : []);
      if (!list.length) { callback(publicIpError('域名未解析到有效公网地址')); return; }
      for (const item of list) {
        if (!item || !isPublicUnicastIp(item.address)) {
          callback(publicIpError());
          return;
        }
      }
      const normalized = list.map(item => ({ address: item.address, family: item.family || isIP(item.address) }));
      const filtered = requestedFamily ? normalized.filter(item => item.family === requestedFamily) : normalized;
      const chosen = filtered.length ? filtered : normalized;
      if (wantAll) callback(null, chosen);
      else callback(null, chosen[0].address, chosen[0].family);
    });
  };
}

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
  const rawHost = url.hostname.replace(/^\[|\]$/g, '');
  if (options.publicOnly && isIP(rawHost) && !isPublicUnicastIp(rawHost)) throw publicIpError();
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
    const customLookup = typeof options.lookup === 'function' ? options.lookup : undefined;
    const lookup = options.publicOnly ? createPublicLookup(customLookup || dns.lookup) : customLookup;
    const reqOptions = { method, headers: Object.fromEntries(headers), signal, ...(lookup ? { lookup } : {}) };
    const request = (url.protocol === 'https:' ? https : http).request(url, reqOptions, incoming => {
      response = incoming;
      const onIncomingError = error => fail(error);
      const onIncomingAborted = () => fail(Object.assign(new Error('行情响应提前断开'), { code: 'ECONNRESET' }));
      try {
      incoming.on('error', onIncomingError);
      incoming.on('aborted', onIncomingAborted);
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
      const contentType = String(responseHeaders.get('content-type') || '').toLowerCase();
      const wantStream = !noBody && (options.streamResponse === true || contentType.includes('text/event-stream'));
      if (wantStream) {
        incoming.pause();
        incoming.removeListener('error', onIncomingError);
        incoming.removeListener('aborted', onIncomingAborted);
        cleanup();
        const decoders = [...codings].reverse().map(coding => unzip[coding]());
        const allStreams = [incoming, ...decoders];
        const output = decoders.length ? decoders[decoders.length - 1] : incoming;
        let wireBytes = 0, decodedBytes = 0, incomingEnded = false, streamFinished = false, cancelled = false, closePromise = null;
        let streamController = null;
        const closeTransport = () => {
          if (closePromise) return closePromise;
          const pending = allStreams.filter(stream => !stream.closed && !stream.destroyed).map(stream => new Promise(done => stream.once('close', done)));
          try { request.destroy(); } catch { /* ignore */ }
          for (const stream of allStreams) { try { if (!stream.destroyed) stream.destroy(); } catch { /* ignore */ } }
          closePromise = Promise.all(pending).then(() => undefined);
          return closePromise;
        };
        const stopStream = error => {
          if (streamFinished) return;
          streamFinished = true;
          signal?.removeEventListener('abort', onStreamAbort);
          try { streamController?.error(error); } catch { /* already closed/errored */ }
          void closeTransport();
        };
        const onStreamAbort = () => stopStream(aborted(signal));
        const bodyStream = new ReadableStream({
          start(controller) {
            streamController = controller;
            signal?.addEventListener('abort', onStreamAbort, { once: true });
            let chain = incoming;
            for (const dec of decoders) {
              dec.on('error', stopStream);
              chain = chain.pipe(dec);
            }
            if (decoders.length > 0) {
              incoming.on('data', chunk => {
                wireBytes += chunk.length;
                if (wireBytes > limit) stopStream(sizeError());
              });
            }
            incoming.on('error', stopStream);
            incoming.on('aborted', () => stopStream(Object.assign(new Error('行情响应提前断开'), { code: 'ECONNRESET' })));
            incoming.once('end', () => {
              incomingEnded = true;
              if (!incoming.complete) stopStream(Object.assign(new Error('行情响应提前断开'), { code: 'ECONNRESET' }));
            });
            incoming.once('close', () => {
              if (!incomingEnded && !streamFinished && !cancelled) stopStream(Object.assign(new Error('行情响应提前断开'), { code: 'ECONNRESET' }));
            });
            output.on('data', chunk => {
              if (streamFinished || cancelled) return;
              decodedBytes += chunk.length;
              if (decodedBytes > limit) { stopStream(sizeError()); return; }
              try {
                controller.enqueue(new Uint8Array(chunk));
                if (controller.desiredSize != null && controller.desiredSize <= 0) output.pause();
              } catch (err) { stopStream(err); }
            });
            output.once('end', () => {
              if (streamFinished || cancelled) return;
              streamFinished = true;
              signal?.removeEventListener('abort', onStreamAbort);
              try { controller.close(); } catch { /* already closed */ }
            });
            if (signal?.aborted) onStreamAbort();
          },
          pull() {
            if (!streamFinished && !cancelled) output.resume();
          },
          cancel() {
            cancelled = true;
            streamFinished = true;
            signal?.removeEventListener('abort', onStreamAbort);
            return closeTransport();
          }
        });
        settled = true;
        const result = new Response(bodyStream, { status, statusText: incoming.statusMessage || '', headers: responseHeaders });
        Object.defineProperties(result, { url: { value: url.href }, redirected: { value: depth > 0 } });
        resolve(result);
        return;
      }
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
module.exports = { fetchNative, requiresNativeTransport, isPublicUnicastIp, createPublicLookup };
