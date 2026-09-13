import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { getQuickJS } from 'quickjs-emscripten';

// Opt-in diagnostic using the actual checked-out client's JavaScript bindings.
// Native calls are adapted to Node; this is not an iOS networking or UI emulator.
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provider = args.provider;
const mode = args.mode ?? 'streams';
const redirects = args.redirects ?? 'follow';
if (!['follow', 'manual'].includes(redirects)) throw new Error('Invalid redirect mode');
if (!['xtream', 'filmpalast', 'filmo'].includes(provider) || !['settings', 'streams'].includes(mode)
  || (mode === 'streams' && (provider === 'xtream' || !args.id))) {
  throw new Error('Use --provider xtream --mode settings, or --provider filmpalast|filmo --id TMDB_ID.');
}
const client = resolve(args['client-root'] ?? resolve(root, '../NuvioMobile-Enhanced'));
const bindings = await readFile(resolve(client,
  'composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/js/JsBindings.kt'), 'utf8');
function kotlinString(name, prefix = 'val') {
  const pattern = prefix === 'val' ? `val ${name}: String = """([\\s\\S]*?)"""`
    : `private fun ${name}\\(\\) = """([\\s\\S]*?)"""`;
  const match = new RegExp(pattern).exec(bindings);
  if (!match) throw new Error(`Client binding not found: ${name}`);
  return match[1].replace(/\$\{(\w+)\(\)\}/g, (_, functionName) => kotlinString(functionName, 'function'))
    .replace(/\$\{'\$'\}/g, '$');
}
const vm = (await getQuickJS()).newContext();
const started = Date.now();
const deadline = started + 60_000;
vm.runtime.setInterruptHandler(() => Date.now() >= deadline);
vm.runtime.setMemoryLimit(128 * 1024 * 1024);
const deferreds = [];
const pending = new Set();
const requests = [];
const errors = [];
let captured;
let queue = Promise.resolve();
let stage = 'host bindings';
function register(name, callback) {
  const handle = vm.newFunction(name, (...values) => {
    const result = callback(...values.map(value => vm.dump(value)));
    return typeof result === 'string' ? vm.newString(result) : vm.undefined;
  });
  vm.setProp(vm.global, name, handle);
  handle.dispose();
}
function evaluate(code) {
  const result = vm.evalCode(code);
  if (result.error) {
    const error = vm.dump(result.error); result.error.dispose();
    throw new Error(error.message ?? error.name ?? 'Client evaluation failed');
  }
  result.value.dispose();
}
try {
  register('__get_scraper_id', () => `streamnest-${provider}`);
  register('__get_scraper_settings', () => '{}');
  register('__get_call_args', () => JSON.stringify({ tmdbId: args.id, mediaType: args.type ?? 'movie' }));
  register('__capture_result', value => { captured = JSON.parse(value); });
  register('__parse_url', input => {
    const { protocol, host, hostname, port, pathname, search, hash } = new URL(input);
    // UrlBridge prefixes Ktor's non-null encodedQuery/encodedFragment even
    // when they are empty. Preserve that native bug in the diagnostic adapter.
    return JSON.stringify({ protocol, host, hostname, port, pathname, search: search || '?', hash: hash || '#' });
  });
  register('__crypto_get_random_values_hex', count => randomBytes(count).toString('hex'));
  register('__crypto_utf8_to_hex', value => Buffer.from(value, 'utf8').toString('hex'));
  register('__crypto_hex_to_utf8', value => Buffer.from(value, 'hex').toString('utf8'));
  register('__crypto_digest_hex_raw', (algorithm, value) => createHash(algorithm.replace(/-/g, '').toLowerCase())
    .update(Buffer.from(value, 'hex')).digest('hex'));
  register('__crypto_hmac_hex_raw', (algorithm, key, value) => createHmac(algorithm.replace(/-/g, '').toLowerCase(), Buffer.from(key, 'hex'))
    .update(Buffer.from(value, 'hex')).digest('hex'));
  register('__diagnostic_error', message => {
    // Never emit arbitrary plugin messages, settings, URLs or tokens.
    errors.push(typeof message === 'string' && /^StreamNest: [a-zA-Z .,]+$/.test(message)
      ? message : 'Client/provider JavaScript error (message omitted)');
  });
  evaluate(`var console = {log:function(){},warn:function(){},info:function(){},debug:function(){},
    error:function(label,error){__diagnostic_error(typeof error==='string'?error:error&&error.message);}};`);
  const fetchHandle = vm.newFunction('__native_fetch', (...values) => {
    const [url, method, rawHeaders, body, followRedirects] = values.map(value => vm.dump(value));
    const deferred = vm.newPromise(); deferreds.push(deferred);
    // Enhanced's native bridge performs blocking HTTP requests, so preserve its
    // serial network scheduling instead of giving the provider extra concurrency.
    const work = queue.then(async () => {
      const address = new URL(url);
      const action = /\/(details|settings|challenge|attest|captcha|verify|playback)$/.exec(address.pathname)?.[1];
      const operation = { host: address.hostname, method, ...(action ? { action } : {}) };
      requests.push(operation);
      let response;
      try {
        const result = await fetch(url, { method, headers: JSON.parse(rawHeaders),
          ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
          redirect: redirects === 'follow' || followRedirects ? 'follow' : 'manual',
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        const text = await result.text();
        operation.status = result.status; operation.bytes = Buffer.byteLength(text);
        if (action === 'captcha') {
          try {
            const challenge = JSON.parse(text);
            operation.challenge = { difficulty: challenge.pow_difficulty,
              automatic: typeof challenge.pow_nonce === 'string', expiresIn: challenge.expires_in };
          } catch { /* Only public challenge parameters are diagnostic output. */ }
        }
        response = { ok: result.ok, status: result.status, statusText: result.statusText,
          url: result.url, body: text, headers: Object.fromEntries(result.headers.entries()) };
      } catch {
        operation.status = 0;
        response = { ok: false, status: 0, statusText: 'Native request failed', url, body: '', headers: {} };
      }
      const resultHandle = vm.newString(JSON.stringify(response));
      deferred.resolve(resultHandle); resultHandle.dispose();
    });
    queue = work.catch(() => {});
    pending.add(work); work.finally(() => pending.delete(work));
    return deferred.handle;
  });
  vm.setProp(vm.global, '__native_fetch', fetchHandle); fetchHandle.dispose();
  stage = 'client polyfills'; evaluate(kotlinString('staticPolyfillCode'));
  stage = 'provider load';
  evaluate(`var module={exports:{}};var exports=module.exports;(function(){\n${await readFile(resolve(root, `providers/${provider}.js`), 'utf8')}\n})();`);
  stage = mode;
  evaluate(kotlinString(mode === 'settings' ? 'staticSettingsCallCode' : 'staticCallCode'));
  while (captured === undefined && Date.now() < deadline) {
    const jobs = vm.runtime.executePendingJobs();
    if (jobs.error) { jobs.error.dispose(); throw new Error('Client pending job failed'); }
    if (pending.size) await Promise.race(pending);
    else if (captured === undefined && jobs.value === 0) throw new Error('Client result was not delivered');
  }
  if (!Array.isArray(captured)) throw new Error('Client result timed out or was not an array');
  const summary = mode === 'settings' ? captured.filter(field => field.type === 'text').map(field => field.key)
    : captured.map(stream => ({ quality: stream.quality, language: stream.language, subtitleCount: stream.subtitles?.length ?? 0 }));
  console.log(JSON.stringify({ provider, mode, redirects, elapsedMs: Date.now() - started, count: captured.length, result: summary, errors, requests }));
  if (!captured.length || errors.length) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ provider, mode, stage, error: error.message, requests }));
  process.exitCode = 1;
} finally {
  await Promise.allSettled(pending);
  deferreds.forEach(deferred => deferred.dispose());
  vm.dispose();
}
