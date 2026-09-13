import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecureServer, type ServerHttp2Session, type ServerHttp2Stream, type IncomingHttpHeaders } from 'node:http2';
import { createServer, type RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { fetchHttp2, verifyMp4Stream } from '../scripts/diagnostic-http.mjs';

const certificatePath = fileURLToPath(new URL('./fixtures/http2/localhost-cert.pem', import.meta.url));
const certificate = await readFile(certificatePath);
const key = await readFile(new URL('./fixtures/http2/localhost-key.pem', import.meta.url));
const workerPath = fileURLToPath(new URL('../scripts/diagnostic-http.mjs', import.meta.url));
type Reply = { ok: boolean; status: number; url: string; body: string; httpVersion?: string; headers: Record<string, string> };

async function withHttp2(handler: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void, run: (origin: string) => Promise<void>) {
  const server = createSecureServer({ key, cert: certificate });
  const sessions = new Set<ServerHttp2Session>();
  server.on('session', session => {
    sessions.add(session); session.on('error', () => {}); session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => { stream.on('error', () => {}); handler(stream, headers); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try { await run(`https://127.0.0.1:${port}`); }
  finally {
    for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function worker(url: string, options: Record<string, unknown> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath } });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Diagnostic worker timed out.')); }, 10000);
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text; });
    child.stderr.resume();
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error('Diagnostic worker failed.')); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Diagnostic worker returned invalid JSON.')); }
    });
    child.stdin.end(JSON.stringify({ url, method: 'GET', headers: {}, redirect: 'manual', timeout: 5000, ...options }));
  });
}

test('HTTP/2 diagnostic worker sends native headers and POST bodies and decodes a compressed response', async () => {
  let captured: IncomingHttpHeaders | undefined;
  let body = '';
  await withHttp2((stream, headers) => {
    captured = headers;
    stream.setEncoding('utf8'); stream.on('data', data => { body += data; });
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/json', 'content-encoding': 'gzip' });
      stream.end(gzipSync(JSON.stringify({ title: 'Synthetic Ünicode' })));
    });
  }, async origin => {
    const response = await worker(origin + '/search?q=one%2Btwo', { method: 'POST', body: '{"query":"Synthetic"}',
      headers: { 'User-Agent': 'Synthetic complete browser agent', 'Content-Type': 'application/json', Connection: 'close', Referer: origin + '/movie' } });
    assert.equal(response.status, 200);
    assert.equal(response.httpVersion, 'h2');
    assert.deepEqual(JSON.parse(response.body), { title: 'Synthetic Ünicode' });
    assert.equal(response.url, origin + '/search?q=one%2Btwo');
  });
  assert.equal(captured?.[':method'], 'POST');
  assert.equal(captured?.[':path'], '/search?q=one%2Btwo');
  assert.equal(captured?.['user-agent'], 'Synthetic complete browser agent');
  assert.equal(captured?.connection, undefined);
  assert.equal(body, '{"query":"Synthetic"}');
});

test('HTTP/2 manual redirects remain observable without fetching their destination', async () => {
  const requests: string[] = [];
  await withHttp2((stream, headers) => {
    requests.push(String(headers[':path'])); stream.respond({ ':status': 301, location: '/destination' }); stream.end();
  }, async origin => {
    const response = await worker(origin + '/original');
    assert.equal(response.status, 301);
    assert.equal(response.url, origin + '/original');
    assert.equal(response.headers.location, '/destination');
  });
  assert.deepEqual(requests, ['/original']);
});

test('HTTP/2-capable diagnostics negotiate HTTP/1.1 for TLS endpoints that do not offer HTTP/2', async () => {
  const methods: string[] = [];
  const server = createHttpsServer({ key, cert: certificate, ALPNProtocols: ['http/1.1'] }, (request, response) => {
    methods.push(request.method!); response.end('Synthetic metadata');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await worker(`https://127.0.0.1:${(server.address() as { port: number }).port}/metadata`);
    assert.equal(response.status, 200);
    assert.equal(response.httpVersion, 'http/1.1');
    assert.equal(response.body, 'Synthetic metadata');
    assert.deepEqual(methods, ['GET']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('HTTP/2 followed redirects isolate private headers and convert an ordinary POST redirect to GET', async () => {
  let destinationHeaders: IncomingHttpHeaders | undefined;
  await withHttp2((stream, headers) => {
    destinationHeaders = headers; stream.respond({ ':status': 200 }); stream.end('complete');
  }, async destination => {
    await withHttp2(stream => { stream.respond({ ':status': 302, location: destination + '/final' }); stream.end(); }, async origin => {
      const response = await worker(origin + '/initial', { method: 'POST', body: 'synthetic-body', redirect: 'follow', headers: {
        'User-Agent': 'Synthetic complete agent', Authorization: 'Synthetic credential', Cookie: 'synthetic=value',
        'X-CSRF-Token': 'synthetic-csrf', Origin: origin, 'Content-Type': 'text/plain', 'Content-Length': '14',
      } });
      assert.equal(response.status, 200);
      assert.equal(response.url, destination + '/final');
      assert.equal(response.body, 'complete');
    });
  });
  assert.equal(destinationHeaders?.[':method'], 'GET');
  assert.equal(destinationHeaders?.['user-agent'], 'Synthetic complete agent');
  for (const name of ['authorization', 'cookie', 'x-csrf-token', 'origin', 'content-type', 'content-length']) assert.equal(destinationHeaders?.[name], undefined);
});

test('HTTP/2 does not replay a private POST body on a cross-origin 307 redirect', async () => {
  let destinations = 0;
  await withHttp2(stream => { destinations++; stream.respond({ ':status': 200 }); stream.end(); }, async destination => {
    await withHttp2(stream => { stream.respond({ ':status': 307, location: destination + '/other' }); stream.end(); }, async origin => {
      const response = await worker(origin + '/initial', { method: 'POST', body: 'synthetic-body', redirect: 'follow' });
      assert.equal(response.status, 0);
      assert.equal(response.body, '');
    });
  });
  assert.equal(destinations, 0);
});

test('HTTP/2 diagnostics bound redirect loops and interrupt a stalled request', async () => {
  let requests = 0;
  await withHttp2(stream => { requests++; stream.respond({ ':status': 302, location: '/loop' }); stream.end(); }, async origin => {
    assert.equal((await worker(origin + '/loop', { redirect: 'follow' })).status, 0);
  });
  assert.equal(requests, 6);
  await withHttp2(() => { requests++; }, async origin => {
    assert.equal((await worker(origin + '/hang', { timeout: 200 })).status, 0);
  });
  assert.equal(requests, 7);
});

test('HTTP/2 supports deflate and Brotli and refuses unknown encodings or an oversized decoded body', async () => {
  for (const [encoding, encode] of [['deflate', deflateSync], ['br', brotliCompressSync]] as const) {
    await withHttp2(stream => { stream.respond({ ':status': 200, 'content-encoding': encoding }); stream.end(encode('Synthetic response')); }, async origin => {
      assert.equal((await worker(origin + '/compressed')).body, 'Synthetic response');
    });
  }
  const oversized = gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1, 65));
  await withHttp2(stream => { stream.respond({ ':status': 200, 'content-encoding': 'constructor' }); stream.end('Synthetic response'); }, async origin => {
    assert.equal((await worker(origin + '/unknown-encoding')).status, 0);
  });
  await withHttp2(stream => { stream.respond({ ':status': 200, 'content-encoding': 'gzip' }); stream.end(oversized); }, async origin => {
    assert.equal((await worker(origin + '/oversized')).status, 0);
  });
});

async function withHttp(handler: RequestListener, run: (origin: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('bounded MP4 verification uses the exported headers and validates the requested start and seek ranges', async () => {
  const data = Buffer.alloc(2 * 1024 * 1024);
  data.writeUInt32BE(24, 0); data.write('ftyp', 4);
  const ranges: string[] = [];
  const agents: Array<string | undefined> = [];
  await withHttp((request, response) => {
    ranges.push(request.headers.range!); agents.push(request.headers['user-agent']);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range!)!;
    response.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${data.length}` });
    response.end(data.subarray(Number(start), Number(end) + 1));
  }, async origin => {
    const result = await verifyMp4Stream({ url: origin + '/synthetic.mp4', headers: { 'User-Agent': 'Synthetic player agent', Referer: origin + '/embed' } });
    assert.equal(result.ok, true);
    assert.equal(result.checks[0]?.mp4, true);
    assert.deepEqual(result.checks.map(check => check.bytes), [1024, 1024]);
  });
  assert.deepEqual(ranges, ['bytes=0-1023', 'bytes=1048576-1049599']);
  assert.deepEqual(agents, ['Synthetic player agent', 'Synthetic player agent']);
});

test('bounded MP4 verification fails when the server ignores Range, lies about the offset, or returns HTML', async () => {
  for (const mode of ['ignored', 'offset', 'html']) {
    let requests = 0;
    await withHttp((request, response) => {
      requests++;
      if (mode === 'ignored') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html>blocked</html>'); return; }
      response.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': mode === 'offset' ? 'bytes 1-1024/2048' : 'bytes 0-1023/2048' });
      response.end(Buffer.alloc(1024, 65));
    }, async origin => { assert.equal((await verifyMp4Stream({ url: origin + '/movie' })).ok, false); });
    assert.equal(requests, 1);
  }
});

test('HTTP/2 mode retains ordinary unencrypted probes and rejects invalid diagnostic URLs without exposing their values', async () => {
  await withHttp((request, response) => { response.writeHead(301, { Location: '/secure' }); response.end(); }, async origin => {
    const response = await fetchHttp2(origin + '/', { redirect: 'manual' });
    assert.equal(response.status, 301);
    await response.body?.cancel();
  });
  for (const url of ['invalid-synthetic-value', 'https://synthetic-user:synthetic-password@example.invalid/']) {
    await assert.rejects(() => fetchHttp2(url), error => error instanceof Error && error.message === 'Invalid diagnostic URL.');
  }
});
