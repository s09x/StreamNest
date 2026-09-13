import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import { mobileUrlBindings } from './nuvio-mobile-url.mjs';

export interface FixtureRoute {
  url: string;
  method?: string;
  form?: Record<string, string>;
  status?: number;
  headers?: Record<string, string>;
  body: string;
  finalUrl?: string;
}
export interface FixtureOptions { settings?: unknown; routes?: FixtureRoute[]; provideAtob?: boolean; provideCryptoRandom?: boolean; mobileUrl?: boolean }
export type GuestResult = { ok: true; value: unknown } | { ok: false; error: { name: string; message: string; code?: string } };

/** Standard URL APIs are host-backed; fetch and all source responses remain inside the guest. */
export async function createNativeRuntime(bundle: string, options: FixtureOptions = {}) {
  const quickjs = await getQuickJS();
  const vm = quickjs.newContext();
  vm.runtime.setMemoryLimit(64 * 1024 * 1024);
  vm.runtime.setMaxStackSize(1024 * 1024);
  vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 10_000));

  const urlOperation = vm.newFunction('__urlOperation', (requestHandle) => {
    try {
      const request = JSON.parse(vm.getString(requestHandle)) as { operation: string; input: string; base?: string; property?: string; value?: string; method?: string; args?: string[] };
      if (request.operation === 'url') {
        const url = new URL(request.input, request.base || undefined);
        if (request.property) {
          if (!['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'username', 'password'].includes(request.property)) throw new Error();
          (url as unknown as Record<string, string>)[request.property] = request.value ?? '';
        }
        return vm.newString(JSON.stringify({ href: url.href, protocol: url.protocol, host: url.host, hostname: url.hostname,
          port: url.port, pathname: url.pathname, search: url.search, hash: url.hash, origin: url.origin,
          username: url.username, password: url.password }));
      }
      if (request.operation !== 'params') throw new Error();
      const params = new URLSearchParams(request.input);
      const args = request.args ?? [];
      let result: unknown;
      switch (request.method) {
        case undefined: break;
        case 'get': result = params.get(args[0]!); break;
        case 'getAll': result = params.getAll(args[0]!); break;
        case 'has': result = params.has(args[0]!); break;
        case 'set': params.set(args[0]!, args[1]!); break;
        case 'append': params.append(args[0]!, args[1]!); break;
        case 'delete': params.delete(args[0]!); break;
        case 'sort': params.sort(); break;
        default: throw new Error();
      }
      return vm.newString(JSON.stringify({ result, text: params.toString(), entries: [...params.entries()] }));
    } catch { return vm.newString(JSON.stringify({ error: 'Invalid URL' })); }
  });
  vm.setProp(vm.global, '__urlOperation', urlOperation);
  urlOperation.dispose();

  function evaluate(expression: string): unknown {
    const result = vm.evalCode(expression);
    if (result.error) {
      const error = vm.dump(result.error); result.error.dispose();
      throw new Error(`QuickJS evaluation failed: ${JSON.stringify(error)}`);
    }
    try { return vm.dump(result.value); } finally { result.value.dispose(); }
  }

  try {
    evaluate(`
      // Optional Nuvio host feature; default tests exercise the bundle fallback.
      // Mobile JsBindings.kt:146 and Smart pluginWorker.js:351 install atob.
      if (${options.provideAtob === true}) globalThis.atob = function(input) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const text = String(input).replace(/\\s/g,'').replace(/=+$/,'');
        if (text.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(text)) throw new Error('Invalid base64');
        let bits=0,count=0,result='';
        for (const letter of text) {
          bits=(bits<<6)|alphabet.indexOf(letter); count+=6;
          if (count>=8) { count-=8; result+=String.fromCharCode((bits>>count)&255); bits&=(1<<count)-1; }
        }
        return result;
      };
      globalThis.__originalAtob = globalThis.atob;
      // Deterministic test fixture for Nuvio's secure-random host interface.
      // Production providers never use this generator or Math.random for keys.
      if (${options.provideCryptoRandom === true}) {
        let fixtureRandomCall = 0;
        globalThis.crypto = { getRandomValues(values) {
          if (!(values instanceof Uint8Array)) throw new TypeError('Expected fixture byte array');
          const seed = ++fixtureRandomCall;
          for (let index = 0; index < values.length; index++) values[index] = (seed + index * 7) & 255;
          return values;
        }};
      }
      function urlOperation(request) {
        const result = JSON.parse(__urlOperation(JSON.stringify(request)));
        if (result.error) throw new TypeError(result.error);
        return result;
      }
      globalThis.URLSearchParams = class URLSearchParams {
        constructor(input = '', changed) {
          this._text = urlOperation({operation:'params',input:input instanceof URLSearchParams ? input.toString() : input}).text;
          this._changed = changed;
        }
        _call(method, args) {
          const result = urlOperation({operation:'params',input:this._text,method,args});
          this._text = result.text;
          if (this._changed) this._changed(this._text);
          return result.result;
        }
        get(key) { return this._call('get',[String(key)]); }
        getAll(key) { return this._call('getAll',[String(key)]); }
        has(key) { return this._call('has',[String(key)]); }
        set(key,value) { this._call('set',[String(key),String(value)]); }
        append(key,value) { this._call('append',[String(key),String(value)]); }
        delete(key) { this._call('delete',[String(key)]); }
        sort() { this._call('sort',[]); }
        toString() { return this._text; }
        entries() { return urlOperation({operation:'params',input:this._text}).entries[Symbol.iterator](); }
        keys() { return Array.from(this.entries(), entry => entry[0])[Symbol.iterator](); }
        values() { return Array.from(this.entries(), entry => entry[1])[Symbol.iterator](); }
        forEach(callback, thisArg) { for (const [key,value] of this.entries()) callback.call(thisArg,value,key,this); }
        [Symbol.iterator]() { return this.entries(); }
      };
      globalThis.URL = class URL {
        constructor(input,base) { this._data = urlOperation({operation:'url',input:String(input),base:base == null ? undefined : String(base)}); }
        toString() { return this.href; }
        toJSON() { return this.href; }
        get searchParams() { return new URLSearchParams(this.search, text => { this.search = text ? '?' + text : ''; }); }
      };
      for (const property of ['href','protocol','host','hostname','port','pathname','search','hash','origin','username','password']) {
        Object.defineProperty(URL.prototype, property, {
          get() { return this._data[property]; },
          set(value) { this._data = urlOperation({operation:'url',input:this.href,property,value:String(value)}); }
        });
      }
      globalThis.module = {exports:{}};
      globalThis.exports = module.exports;
      globalThis.SCRAPER_SETTINGS = ${JSON.stringify(options.settings ?? {})};
      globalThis.__routes = ${JSON.stringify(options.routes ?? [])};
      globalThis.__requests = [];
      globalThis.fetch = async function(url,options) {
        options = options || {};
        const method = options.method || 'GET';
        __requests.push({url,method,body:options.body,headers:options.headers || {}});
        const form = new URLSearchParams(options.body || '');
        const route = __routes.find(route => route.url === url && (route.method || 'GET') === method
          && Object.entries(route.form || {}).every(([key,value]) => form.get(key) === value));
        if (!route) throw new Error('No fixture response is defined for this request');
        const headers = route.headers || {};
        return {status:route.status === undefined ? 200 : route.status,url:route.finalUrl || url,
          headers:{get(name) { const key=Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase()); return key ? headers[key] : null; }},
          async text() { return route.body; }};
      };
      globalThis.__savedHostFetch = globalThis.fetch;
      globalThis.__originalHostFetch = globalThis.fetch;
    `);
    if (options.mobileUrl) evaluate(mobileUrlBindings);
    evaluate(bundle);
  } catch (error) { vm.dispose(); throw error; }

  return {
    value: evaluate,
    async run(expression: string): Promise<GuestResult> {
      const evaluated = vm.evalCode(`Promise.resolve().then(() => (${expression})).then(
        value => ({ok:true,value}), error => ({ok:false,error:{name:error.name || 'Error',message:String(error.message || error),code:error.code}}))`);
      if (evaluated.error) {
        const error = vm.dump(evaluated.error); evaluated.error.dispose();
        throw new Error(`QuickJS call failed: ${JSON.stringify(error)}`);
      }
      const promise = evaluated.value;
      try {
        for (let iteration = 0; iteration < 1000; iteration++) {
          const state = vm.getPromiseState(promise);
          if (state.type === 'fulfilled') {
            try { return vm.dump(state.value) as GuestResult; } finally { state.value.dispose(); }
          }
          if (state.type === 'rejected') {
            const error = vm.dump(state.error); state.error.dispose();
            throw new Error(`QuickJS promise wrapper rejected: ${JSON.stringify(error)}`);
          }
          const jobs = vm.runtime.executePendingJobs(1000);
          if (jobs.error) {
            const error = vm.dump(jobs.error); jobs.error.dispose();
            throw new Error(`QuickJS pending job failed: ${JSON.stringify(error)}`);
          }
          if (jobs.value === 0) throw new Error('QuickJS promise did not settle with fixture-only asynchronous work');
        }
        throw new Error('QuickJS fixture execution exceeded its job budget');
      } finally { promise.dispose(); }
    },
    dispose() { vm.dispose(); },
  };
}
