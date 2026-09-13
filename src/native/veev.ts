import { load } from 'cheerio/slim';
import { ProviderError } from './errors.js';
import { domText } from './dom-text.js';
import { jsonResponse, objectValue, responseText } from './metadata.js';
import { browserHttp, playerHeaders } from './hoster-http.js';
import { readPlayerLiteral } from './player-data.js';
import { declaredQuality } from './file-hosters.js';
import { normalizeDeclaredLanguage, resolveHlsMetadata } from './hls.js';
import { resolveUrl } from './url.js';
import { httpUrl } from './voe.js';
import type { HttpClient, NativeStream, NativeSubtitle } from './types.js';

const MAX_DECODED = 256 * 1024;

export function isVeevUrl(value: string): boolean {
  try {
    const url = resolveUrl(httpUrl(value));
    return /^(?:www\.)?veev\.to$/.test(url.hostname) && !url.port && !url.hash
      && /^\/(?:e\/)?[A-Za-z0-9]{8,64}\/?$/.test(url.pathname);
  } catch { return false; }
}

/** Veev publishes compressed strings, not executable media assignments. */
export function decodeVeevLzw(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > MAX_DECODED || value.charCodeAt(0) > 255) {
    throw new ProviderError('invalid_response');
  }
  const dictionary: string[] = [];
  let previous = value[0]!;
  let nextCode = 256;
  let size = previous.length;
  const output = [previous];
  for (let index = 1; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const word = code < 256 ? value[index]! : dictionary[code] ?? (code === nextCode ? previous + previous[0] : undefined);
    if (word === undefined) throw new ProviderError('invalid_response');
    size += word.length;
    if (size > MAX_DECODED || nextCode > 65535) throw new ProviderError('response_incomplete');
    output.push(word); dictionary[nextCode++] = previous + word[0]; previous = word;
  }
  return output.join('');
}

export function veevDecodePlan(key: string): number[][] {
  if (!key || key.length > 1024) throw new ProviderError('invalid_response');
  const result: number[][] = [];
  let cursor = 0;
  while (cursor < key.length) {
    const digit = key[cursor++];
    if (!digit || !/^[1-9]$/.test(digit)) break;
    const count = Number(digit);
    if (cursor + count > key.length || result.length > 8) throw new ProviderError('invalid_response');
    const steps = key.slice(cursor, cursor + count);
    if (!/^\d+$/.test(steps)) throw new ProviderError('invalid_response');
    result.push(steps.split('').map(Number).reverse()); cursor += count;
  }
  if (result.length < 3) throw new ProviderError('invalid_response');
  return result;
}

export function decodeVeevValue(value: unknown, plan: number[]): string {
  if (!plan.length || plan.length > 9 || plan.some(step => !Number.isInteger(step) || step < 0 || step > 9)) throw new ProviderError('invalid_response');
  let decoded = decodeVeevLzw(value);
  for (const step of plan) {
    if (step === 1) decoded = decoded.split('').reverse().join('');
    if (!decoded || decoded.length % 2 || !/^[0-9a-f]+$/i.test(decoded)) throw new ProviderError('invalid_response');
    let escaped = '';
    for (let index = 0; index < decoded.length; index += 2) escaped += '%' + decoded.slice(index, index + 2);
    try { decoded = decodeURIComponent(escaped).split('dXRmOA==').join(''); }
    catch { throw new ProviderError('invalid_response'); }
  }
  return decoded;
}

/** The final fc assignment replaces the page's initial decoy value. */
export function extractVeevKey(html: string): string {
  const $ = load(html);
  let key: unknown;
  for (const element of $('script:not([src])').toArray()) {
    const script = domText([element]);
    const assignments = /window\._vvto(?:\.fc|\[\s*([^\]]+)\s*\])\s*=\s*/g;
    let match: RegExpExecArray | null;
    while ((match = assignments.exec(script))) {
      if (match[1]) {
        const name = match[1].trim();
        let valid = false;
        if (/^['"]/.test(name)) valid = readPlayerLiteral(name).value === 'fc';
        else if (/^[A-Za-z_$][\w$]*$/.test(name)) {
          const assignment = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*=\\s*(['"])fc\\1`).exec(script);
          valid = !!assignment;
        }
        if (!valid) continue;
      }
      const parsed = readPlayerLiteral(script, match.index + match[0].length);
      key = parsed.value; assignments.lastIndex = parsed.end;
    }
  }
  if (typeof key !== 'string' || key.length > 1024) throw new ProviderError('invalid_response');
  const decoded = decodeVeevLzw(key);
  veevDecodePlan(decoded);
  return decoded;
}

function captions(value: unknown, pageUrl: string): NativeSubtitle[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) throw new ProviderError('invalid_response');
  const result: NativeSubtitle[] = [];
  for (const item of value) {
    const row = objectValue(item);
    const raw = row?.src ?? row?.file;
    const lang = row?.srcLang ?? row?.srclang ?? row?.language;
    if (typeof raw !== 'string' || !raw.trim() || typeof lang !== 'string' || !lang.trim()) continue;
    const language = normalizeDeclaredLanguage(lang);
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language)) continue;
    result.push({ url: httpUrl(raw, pageUrl), language,
      ...(typeof row?.label === 'string' && row.label.length <= 500 ? { name: row.label } : {}), headers: playerHeaders(pageUrl) });
  }
  return result;
}

export async function resolveVeev(http: HttpClient, embedUrl: string, sourcePage: string, title: string): Promise<NativeStream[]> {
  if (!isVeevUrl(embedUrl)) throw new ProviderError('invalid_response');
  const client = browserHttp(http);
  const expectedId = resolveUrl(embedUrl).pathname.split('/').filter(Boolean).pop()!;
  const response = await client.request(embedUrl, { headers: { Referer: httpUrl(sourcePage) } });
  if (!isVeevUrl(response.url) || resolveUrl(response.url).pathname.split('/').filter(Boolean).pop() !== expectedId) {
    throw new ProviderError('invalid_response');
  }
  const key = extractVeevKey(responseText(response));
  const page = resolveUrl(response.url);
  const params = new URLSearchParams({ op: 'player_api', cmd: 'gi', file_code: expectedId, r: httpUrl(sourcePage), ch: key,
    ie: page.pathname.startsWith('/e/') ? '1' : '0' });
  const apiResponse = await client.request(`${page.origin}/dl?${params.toString()}`, {
    headers: { Referer: response.url, Accept: 'application/json' },
  });
  const apiAddress = resolveUrl(apiResponse.url);
  if (apiAddress.origin !== page.origin || apiAddress.pathname !== '/dl') throw new ProviderError('invalid_response');
  const data = objectValue(jsonResponse(apiResponse));
  if (data?.code === 404) throw new ProviderError('source_unavailable');
  if (data?.recaptcha || data?.hashcheck || data?.restricted || data?.premium_required) throw new ProviderError('source_blocked');
  if (!data || data.status !== 'success') throw new ProviderError('request_failed');
  const file = objectValue(data.file);
  if (!file || file.file_code !== expectedId) throw new ProviderError('invalid_response');
  if (file.file_status === 'deleted' || file.file_status === 'encoding') throw new ProviderError('source_unavailable');
  if (file.file_status !== 'OK' || file.disable_adb || file.file_a) throw new ProviderError('source_blocked');
  if (!Array.isArray(file.dv) || file.dv.length > 32) throw new ProviderError('invalid_response');
  const plan = veevDecodePlan(key);
  const subtitles = captions(file.captions_list, response.url);
  if (typeof file.captions_json === 'string' && file.captions_json.trim()) {
    try { subtitles.push(...captions(jsonResponse(await client.request(httpUrl(file.captions_json, response.url), {
      headers: playerHeaders(response.url),
    })), response.url)); }
    catch { /* A missing optional caption index must not suppress the media. */ }
  }
  const results: NativeStream[] = [];
  let failure: ProviderError | undefined;
  const seen = new Set<string>();
  for (const value of file.dv) {
    try {
      const row = objectValue(value);
      if (!row) throw new ProviderError('invalid_response');
      const url = httpUrl(decodeVeevValue(row.s, plan[0]!));
      if (seen.has(url)) continue;
      const type = decodeVeevValue(row.t, plan[1]!).split(';')[0]!.trim().toLowerCase();
      if (!['video/mp4', 'application/x-mpegurl', 'application/vnd.apple.mpegurl'].includes(type)) throw new ProviderError('invalid_response');
      const quality = declaredQuality(decodeVeevValue(row.sz, plan[2]!));
      const headers = playerHeaders(response.url);
      const technical = type === 'video/mp4' ? undefined : await resolveHlsMetadata(client, url, headers);
      results.push({ url, title: [title, ...(technical?.details ?? [])].join(' | '), quality: technical?.quality ?? quality,
        language: technical?.language, headers, ...(subtitles.length ? { subtitles } : {}) });
      seen.add(url);
    } catch (error) { failure ??= error instanceof ProviderError ? error : new ProviderError('invalid_response'); }
  }
  if (!results.length) throw failure ?? new ProviderError('source_unavailable');
  return results;
}
