import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getQuickJS } from 'quickjs-emscripten';
import { verifyMp4Stream } from './diagnostic-http.mjs';

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
const transport = args.transport ?? 'fetch';
if (!['fetch', 'http2'].includes(transport)) throw new Error('Invalid diagnostic transport.');
const mediaCheck = args['verify-media'] ?? 'none';
if (!['none', 'mp4'].includes(mediaCheck)) throw new Error('Invalid media verification mode.');
if (!['follow', 'manual'].includes(redirects)) throw new Error('Invalid redirect mode');
if (!['xtream', 'filmpalast', 'filmo', 'einschalten', 'hdfilme', 'megakino', 'huhu'].includes(provider) || !['settings', 'streams'].includes(mode)
  || (mode === 'streams' && (provider === 'xtream' || !args.id))) {
  throw new Error('Use --provider xtream --mode settings, or --provider filmpalast|filmo|einschalten|hdfilme|megakino|huhu --id TMDB_ID; optional --type, --season, --episode, --transport and --verify-media.');
}
if (mediaCheck !== 'none' && mode !== 'streams') throw new Error('Media verification requires stream mode.');
function episodeArgument(name) {
  if (args[name] === undefined) return undefined;
  const value = Number(args[name]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}.`);
  return value;
}
const season = episodeArgument('season');
const episode = episodeArgument('episode');
const client = resolve(args['client-root'] ?? resolve(root, '../NuvioMobile-Enhanced'));
const clientRef = args['client-ref'];
if (clientRef && !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(clientRef)) throw new Error('Invalid client Git reference');
async function clientSource(path) {
  return clientRef ? execFileSync('git', ['show', `${clientRef}:${path}`], { cwd: client, encoding: 'utf8', maxBuffer: 1024 * 1024 })
    : readFile(resolve(client, path), 'utf8');
}
const runtimeDirectory = 'composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/';
const bindings = await clientSource(runtimeDirectory + 'js/JsBindings.kt');
function expandTemplate(code) {
  return code.replace(/\$\{(\w+)\(\)\}/g, (_, functionName) => kotlinString(functionName, 'function'))
    .replace(/\$\{'\$'\}/g, '$');
}
function kotlinString(name, prefix = 'val') {
  const pattern = prefix === 'val' ? `val ${name}: String = """([\\s\\S]*?)"""`
    : `private fun ${name}\\(\\) = """([\\s\\S]*?)"""`;
  const match = new RegExp(pattern).exec(bindings);
  if (!match) throw new Error(`Client binding not found: ${name}`);
  return expandTemplate(match[1]);
}
const usesStaticBindings = /val staticPolyfillCode:/.test(bindings);
let polyfillCode;
let callCode;
if (usesStaticBindings) {
  polyfillCode = kotlinString('staticPolyfillCode');
  callCode = kotlinString(mode === 'settings' ? 'staticSettingsCallCode' : 'staticCallCode');
} else {
  // 0.4.14 generates the same bridge from Kotlin string arguments instead of
  // the host getters introduced later. Read that version's call wrapper too.
  const polyfill = /fun buildPolyfillCode[\s\S]*?return """([\s\S]*?)"""/.exec(bindings);
  const runtime = await clientSource(runtimeDirectory + 'PluginRuntime.kt');
  const calls = [...runtime.matchAll(/val callCode = """([\s\S]*?)"""/g)];
  if (!polyfill || calls.length !== 2) throw new Error('Unsupported legacy client bindings');
  polyfillCode = expandTemplate(polyfill[1]).replace(/\$scraperIdJson/g, () => JSON.stringify(`streamnest-${provider}`))
    .replace(/\$settingsJson/g, '{}');
  callCode = calls[mode === 'settings' ? 0 : 1][1]
    .replace(/\$tmdbIdArg/g, () => JSON.stringify(args.id))
    .replace(/\$mediaTypeArg/g, () => JSON.stringify(args.type ?? 'movie'))
    .replace(/\$seasonArg/g, String(season))
    .replace(/\$episodeArg/g, String(episode));
}
const vm = (await getQuickJS()).newContext();
const started = Date.now();
const deadline = started + 60_000;
vm.runtime.setInterruptHandler(() => Date.now() >= deadline);
vm.runtime.setMemoryLimit(128 * 1024 * 1024);
// quickjs-kt 1.0.5 defaults to a 256 KiB interpreter stack on iOS.
vm.runtime.setMaxStackSize(256 * 1024);
const requests = [];
const errors = [];
let captured;
let stage = 'host bindings';
// Native fetch is synchronous in 0.4.14. A child process lets the diagnostic
// block the guest in the same place while Node performs the HTTP request.
// Request data travels over stdin, never through process arguments or files.
const fetchProcess = `
import { readFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
try {
  const response = await fetch(request.url, {
    method: request.method, headers: request.headers,
    ...(request.method === 'GET' || request.method === 'HEAD' ? {} : {body: request.body}),
    redirect: request.redirect, signal: AbortSignal.timeout(request.timeout)
  });
  process.stdout.write(JSON.stringify({ok: response.ok, status: response.status, statusText: response.statusText,
    url: response.url, body: await response.text(), headers: Object.fromEntries(response.headers.entries())}));
} catch {
  process.stdout.write(JSON.stringify({ok:false,status:0,statusText:'Native request failed',url:request.url,body:'',headers:{}}));
}
`;
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
  register('__get_call_args', () => JSON.stringify({ tmdbId: args.id, mediaType: args.type ?? 'movie', season, episode }));
  register('__capture_result', value => { captured = JSON.parse(value); });
  register('__capture_settings_result', value => { captured = JSON.parse(value); });
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
    const address = new URL(url);
    const action = /\/(details|settings|challenge|attest|captcha|verify|playback)$/.exec(address.pathname)?.[1];
    const operation = { host: address.hostname, method, ...(action ? { action } : {}) };
    requests.push(operation);
    let response;
    try {
      const timeout = Math.max(1, deadline - Date.now());
      const worker = transport === 'http2' ? [resolve(root, 'scripts/diagnostic-http.mjs')] : ['--input-type=module', '-e', fetchProcess];
      response = JSON.parse(execFileSync(process.execPath, worker, {
        input: JSON.stringify({ url, method, headers: JSON.parse(rawHeaders), body,
          redirect: redirects === 'follow' || followRedirects ? 'follow' : 'manual', timeout }),
        encoding: 'utf8', timeout: timeout + 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
    } catch {
      response = { ok: false, status: 0, statusText: 'Native request failed', url, body: '', headers: {} };
    }
    operation.status = response.status; operation.bytes = Buffer.byteLength(response.body);
    if (response.httpVersion) operation.httpVersion = response.httpVersion;
    if (action === 'captcha') {
      try {
        const challenge = JSON.parse(response.body);
        operation.challenge = { difficulty: challenge.pow_difficulty,
          automatic: typeof challenge.pow_nonce === 'string', expiresIn: challenge.expires_in };
      } catch { /* Only public challenge parameters are diagnostic output. */ }
    }
    return vm.newString(JSON.stringify(response));
  });
  vm.setProp(vm.global, '__native_fetch', fetchHandle); fetchHandle.dispose();
  stage = 'client polyfills'; evaluate(polyfillCode);
  stage = 'provider load';
  evaluate(`var module={exports:{}};var exports=module.exports;(function(){\n${await readFile(resolve(root, `providers/${provider}.js`), 'utf8')}\n})();`);
  stage = mode;
  evaluate(callCode);
  while (captured === undefined && Date.now() < deadline) {
    const jobs = vm.runtime.executePendingJobs();
    if (jobs.error) { jobs.error.dispose(); throw new Error('Client pending job failed'); }
    if (captured === undefined && jobs.value === 0) throw new Error('Client result was not delivered');
  }
  if (!Array.isArray(captured)) throw new Error('Client result timed out or was not an array');
  const media = [];
  if (mediaCheck === 'mp4') for (const stream of captured) media.push(await verifyMp4Stream(stream));
  const summary = mode === 'settings' ? captured.filter(field => field.type === 'text').map(field => field.key)
    : captured.map(stream => ({ quality: stream.quality, language: stream.language, subtitleCount: stream.subtitles?.length ?? 0 }));
  console.log(JSON.stringify({ provider, mode, redirects, transport, clientRef: clientRef ?? 'working-tree', elapsedMs: Date.now() - started,
    count: captured.length, result: summary, ...(mediaCheck === 'mp4' ? { media } : {}), errors, requests }));
  if (!captured.length || errors.length || media.some(result => !result.ok)) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ provider, mode, transport, stage, error: error.message, requests }));
  process.exitCode = 1;
} finally {
  vm.dispose();
}
