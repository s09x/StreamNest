import { readFile } from 'node:fs/promises';
import { createContext, Script } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileUrlBindings } from '../test/helpers/nuvio-mobile-url.mjs';

// Explicit opt-in live checker. Credentials enter through stdin, never argv or files.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const values = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const provider = values.provider;
if (!['filmpalast', 'filmo', 'xtream'].includes(provider) || !values.id || !values.type) {
  throw new Error('Use --provider, --id and --type; optional --season, --episode, --limit, --redirects and --url-runtime.');
}
const redirects = values.redirects ?? 'manual';
if (!['manual', 'follow'].includes(redirects)) throw new Error('Invalid native redirect mode.');
const urlRuntime = values['url-runtime'] ?? 'standard';
if (!['standard', 'nuvio-mobile'].includes(urlRuntime)) throw new Error('Invalid URL runtime.');
let settings;
if (provider === 'xtream') {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 8192) throw new Error('Input exceeds the configuration limit.');
  }
  try { settings = JSON.parse(input); } catch { throw new Error('Invalid private configuration input.'); }
}
const limit = Number(values.limit ?? 1048576);
if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 8 * 1024 * 1024) throw new Error('Invalid native response limit.');
const stats = { requests: 0, truncated: 0, legacyRequests: 0, maximumBytes: 0 };
const operations = [];
const context = createContext({
  module: { exports: {} }, URL, URLSearchParams, SCRAPER_SETTINGS: settings,
  // Nuvio Mobile exposes secure randomness but not native P-256 key generation.
  // Keep the normal portable signing implementation inside the tested bundle.
  crypto: { getRandomValues: bytes => globalThis.crypto.getRandomValues(bytes) },
  fetch: async (url, options) => {
    stats.requests++;
    const fields = new URLSearchParams(options?.method === 'GET' ? new URL(url).search : options?.body ?? '');
    const operation = { action: fields.get('action') ?? fields.get('type') ?? (url.includes('/player_api.php') ? 'authenticate' : 'metadata'), category: fields.get('category_id') ?? fields.get('cat_id') };
    if (url.includes('/enigma2.php')) stats.legacyRequests++;
    const response = await fetch(url, { ...options, redirect: redirects === 'follow' ? 'follow' : options?.redirect,
      headers: { ...options?.headers, Connection: 'close' }, signal: AbortSignal.timeout(20_000) });
    const original = Buffer.from(await response.text());
    stats.maximumBytes = Math.max(stats.maximumBytes, original.length);
    if (original.length > limit) stats.truncated++;
    operations.push({ ...operation, status: response.status, bytes: original.length });
    const body = original.subarray(0, limit).toString('utf8');
    return { status: response.status, url: response.url, headers: { get: name => response.headers.get(name) }, text: async () => body };
  },
});
const code = await readFile(resolve(root, `providers/${provider}.js`), 'utf8');
if (urlRuntime === 'nuvio-mobile') new Script(mobileUrlBindings).runInContext(context);
new Script(code, { filename: 'native-provider.js' }).runInContext(context, { timeout: 2000 });
const start = Date.now();
try {
  const streams = await context.module.exports.getStreams(values.id, values.type,
    values.season === undefined ? undefined : Number(values.season), values.episode === undefined ? undefined : Number(values.episode));
  console.log(JSON.stringify({ ok: true, provider, redirects, urlRuntime, elapsedMs: Date.now() - start, stats,
    streams: streams.map(stream => ({ name: stream.name, quality: stream.quality, language: stream.language, subtitleCount: stream.subtitles?.length ?? 0 })) }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, provider, error: typeof error.code === 'string' ? error.code : 'request_failed',
    elapsedMs: Date.now() - start, stats, lastOperations: operations.slice(-6) }));
  process.exitCode = 1;
} finally {
  settings = null;
  context.SCRAPER_SETTINGS = undefined;
}
