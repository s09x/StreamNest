import { connect, constants } from 'node:http2';
import { STATUS_CODES } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const HOP_HEADERS = /^(?:connection|keep-alive|proxy-connection|transfer-encoding|upgrade|host)$/i;

function address(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Invalid diagnostic URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || String(input).length > 16000) {
    throw new Error('Invalid diagnostic URL.');
  }
  return url;
}

function requestHttp2(url, options, signal) {
  const headers = { ':method': options.method, ':path': url.pathname + url.search };
  for (const [key, value] of new Headers(options.headers)) {
    if (!HOP_HEADERS.test(key) && (key !== 'te' || value === 'trailers')) headers[key] = value;
  }
  return new Promise((resolveResponse, reject) => {
    if (signal.aborted) { reject(new Error('Diagnostic request aborted.')); return; }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const socket = connectTls({ host: hostname, port: Number(url.port) || 443,
      servername: isIP(hostname) ? undefined : hostname, ALPNProtocols: ['h2', 'http/1.1'] });
    let session;
    let stream;
    let done = false;
    let status;
    let responseHeaders;
    let length = 0;
    const chunks = [];
    function close() {
      signal.removeEventListener('abort', abort);
      stream?.close(constants.NGHTTP2_CANCEL);
      session?.destroy(); socket.destroy();
    }
    function fail(message = 'HTTP/2 diagnostic request failed.') {
      if (done) return;
      done = true; close(); reject(new Error(message));
    }
    function abort() { fail('Diagnostic request aborted.'); }
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', () => fail());
    socket.on('close', () => { if (!done) fail(); });
    socket.once('secureConnect', () => {
      if (done) return;
      if (socket.alpnProtocol !== 'h2') {
        // Metadata endpoints such as Cinemeta can offer only HTTP/1.1. No
        // application request has been sent on this probe connection.
        done = true; close();
        fetch(url.href, { ...options, redirect: 'manual', signal }).then(response => resolveResponse({
          status: response.status, statusText: response.statusText, ok: response.ok, url: response.url,
          headers: response.headers, body: response.body, httpVersion: 'http/1.1', text: () => response.text(),
        }), () => reject(new Error('Diagnostic HTTP/1.1 fallback failed.')));
        return;
      }
      session = connect(url.origin, { createConnection: () => socket });
      session.on('error', () => fail());
      session.once('connect', startRequest);
    });
    function startRequest() {
      try { stream = session.request(headers); }
      catch { fail(); return; }
      stream.on('response', values => { status = Number(values[':status']); responseHeaders = values; });
      stream.on('error', () => fail());
      stream.on('aborted', () => fail());
      stream.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_BODY_BYTES) { fail('Diagnostic response exceeds its size limit.'); return; }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        if (done) return;
        try {
          if (!Number.isInteger(status) || status < 200 || status > 599 || !responseHeaders) throw new Error();
          let body = Buffer.concat(chunks);
          const encoding = String(responseHeaders['content-encoding'] ?? 'identity').trim().toLowerCase();
          if (encoding && encoding !== 'identity') {
            const decode = encoding === 'gzip' ? gunzipSync : encoding === 'deflate' ? inflateSync : encoding === 'br' ? brotliDecompressSync : undefined;
            if (!decode) throw new Error();
            body = decode(body, { maxOutputLength: MAX_BODY_BYTES });
          }
          const received = new Headers();
          for (const [key, value] of Object.entries(responseHeaders)) {
            if (key.startsWith(':') || value === undefined) continue;
            for (const entry of Array.isArray(value) ? value : [value]) received.append(key, String(entry));
          }
          done = true; close();
          resolveResponse({ status, statusText: STATUS_CODES[status] ?? '', ok: status >= 200 && status < 300,
            url: url.href, httpVersion: 'h2', headers: received, text: async () => body.toString('utf8') });
        } catch { fail('Invalid HTTP/2 diagnostic response.'); }
      });
      stream.end(options.body);
    }
  });
}

/** Negotiate HTTP/2 when offered; this adapter does not change a shipped provider's transport. */
export async function fetchHttp2(input, options = {}) {
  let url = address(input);
  const signal = options.signal ?? AbortSignal.timeout(20000);
  let method = (options.method ?? 'GET').toUpperCase();
  let body = options.body;
  const headers = new Headers(options.headers);
  for (let redirects = 0; redirects < 6; redirects++) {
    // An unencrypted capability probe still uses ordinary HTTP/1.1.
    const response = url.protocol === 'http:'
      ? await fetch(url, { method, headers, body, redirect: 'manual', signal })
      : await requestHttp2(url, { method, headers, body }, signal);
    const location = response.headers.get('location');
    if (options.redirect === 'manual' || !location || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (options.redirect === 'error') throw new Error('Diagnostic redirect rejected.');
    const target = address(new URL(location, url).href);
    if (target.origin !== url.origin) {
      if (body !== undefined && [307, 308].includes(response.status)) throw new Error('Diagnostic cross-origin body redirect rejected.');
      for (const key of [...headers.keys()]) if (/authorization|cookie|csrf|origin/i.test(key)) headers.delete(key);
    }
    if ((method === 'POST' && [301, 302].includes(response.status)) || (response.status === 303 && method !== 'HEAD')) {
      method = 'GET'; body = undefined; headers.delete('content-length'); headers.delete('content-type');
    }
    url = target;
  }
  throw new Error('Diagnostic redirect limit exceeded.');
}

/** Inspect at most two KiB of an exported MP4, including a separate seek range. */
export async function verifyMp4Stream(stream) {
  address(stream.url);
  const checks = [];
  let total;
  for (const index of [0, 1]) {
    const start = index === 0 ? 0 : Math.min(1048576, Math.floor(total / 2));
    const end = total === undefined ? start + 1023 : Math.min(start + 1023, total - 1);
    const headers = new Headers(stream.headers);
    headers.set('Range', `bytes=${start}-${end}`);
    let response;
    try {
      response = await fetch(stream.url, { headers, signal: AbortSignal.timeout(20000) });
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      const check = { start, status: response.status, contentType: response.headers.get('content-type'),
        contentRange: response.headers.get('content-range'), bytes: 0 };
      checks.push(check);
      const size = range && Number(range[3]);
      if (response.status !== 206 || !range || !Number.isSafeInteger(size) || size < 16 || Number(range[1]) !== start
        || Number(range[2]) !== Math.min(end, size - 1) || (total !== undefined && total !== size)) {
        await response.body?.cancel(); return { ok: false, checks };
      }
      total = size;
      const reader = response.body.getReader();
      const chunks = [];
      try {
        while (check.bytes < 1024) {
          const part = await reader.read();
          if (part.done) break;
          const data = Buffer.from(part.value).subarray(0, 1024 - check.bytes);
          chunks.push(data); check.bytes += data.length;
        }
      } finally { await reader.cancel(); }
      if (index === 0) check.mp4 = Buffer.concat(chunks).subarray(4, 8).toString('ascii') === 'ftyp';
      if (check.bytes !== Math.min(end, size - 1) - start + 1 || (index === 0 && !check.mp4)) return { ok: false, checks };
    } catch {
      await response?.body?.cancel().catch(() => {});
      return { ok: false, checks, error: 'Bounded media request failed.' };
    }
  }
  return { ok: true, checks };
}

// The Enhanced checker uses a synchronous bridge. Private request data stays on
// stdin and stdout between processes; only its caller emits redacted diagnostics.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let request;
  try {
    const input = readFileSync(0, 'utf8');
    if (input.length > 1024 * 1024) throw new Error();
    request = JSON.parse(input);
    const timeout = Number(request.timeout);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error();
    const response = await fetchHttp2(request.url, { method: request.method, headers: request.headers,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body }),
      redirect: request.redirect, signal: AbortSignal.timeout(timeout) });
    process.stdout.write(JSON.stringify({ ok: response.ok, status: response.status, statusText: response.statusText,
      url: response.url, httpVersion: response.httpVersion ?? 'http/1.1', body: await response.text(), headers: Object.fromEntries(response.headers.entries()) }));
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, status: 0, statusText: 'Native request failed', url: request?.url ?? '', body: '', headers: {} }));
  }
}
