import { ProviderError } from './errors.js';
import { responseText } from './metadata.js';
import { httpUrl } from './voe.js';
import type { HttpClient } from './types.js';

export interface HlsMetadata { details: string[]; quality?: string; language?: string }
const MAX_MANIFEST_LENGTH = 1024 * 1024;

function shortText(value: unknown, limit = 500): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= limit && !/[\r\n\0]/.test(value)
    ? value.trim() : undefined;
}

export function normalizeDeclaredLanguage(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  // A subtitle label may explicitly name its language and a presentation role.
  // Keep that role in the display label, not in the language code.
  const unqualified = normalized.replace(/\s*(?:\((?:forced|sdh|cc|full|complete|vollständig)\)|\[(?:forced|sdh|cc|full|complete)\])\s*$/i, '').trim();
  const names: Record<string, string> = { german: 'de', deutsch: 'de', ger: 'de', deu: 'de',
    english: 'en', eng: 'en', french: 'fr', fra: 'fr', fre: 'fr', spanish: 'es', spa: 'es', italian: 'it', ita: 'it',
    dut: 'nl', nld: 'nl', por: 'pt' };
  if (names[unqualified]) return names[unqualified]!;
  const tag = /^([a-z]{2,3})((?:-[a-z0-9]{2,8})*)$/.exec(unqualified);
  return tag ? `${names[tag[1]!] ?? tag[1]}${tag[2]}` : normalized;
}

function attributes(line: string): Record<string, string> {
  const values: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) values[match[1]!] = (match[2] ?? match[3] ?? '').trim();
  return values;
}

export function parseHlsMetadata(text: string): HlsMetadata {
  if (text.length > MAX_MANIFEST_LENGTH) throw new ProviderError('response_incomplete');
  const body = text.replace(/^\uFEFF/, '').trimStart();
  if (!body.startsWith('#EXTM3U')) throw new ProviderError('invalid_response');
  const lines = body.split(/\r?\n/).map(line => line.trim());
  const variants: Array<{ width: number; height: number; fields: Record<string, string> }> = [];
  const audioGroups = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const next = lines[index + 1];
    if (!next || next.startsWith('#')) throw new ProviderError('invalid_response');
    const fields = attributes(line);
    if (fields.AUDIO) audioGroups.add(fields.AUDIO);
    const resolution = /^(\d+)x(\d+)$/i.exec(fields.RESOLUTION ?? '');
    if (!resolution) continue;
    const width = Number(resolution[1]); const height = Number(resolution[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) {
      throw new ProviderError('invalid_response');
    }
    variants.push({ width, height, fields });
  }
  if (variants.length > 256) throw new ProviderError('response_incomplete');
  const best = variants.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const details: string[] = [];
  let quality: string | undefined;
  if (best) {
    details.push(`${best.width}x${best.height}`);
    // Report nonstandard/cropped dimensions exactly instead of inventing a tier.
    quality = [4320, 2160, 1440, 1080, 720, 576, 480, 360, 240, 144].includes(best.height)
      ? `${best.height}p` : `${best.width}x${best.height}`;
    const codecs = best.fields.CODECS ?? '';
    if (/(?:^|,)\s*avc[13]/i.test(codecs)) details.push('AVC');
    else if (/(?:^|,)\s*(?:hvc1|hev1)/i.test(codecs)) details.push('HEVC');
    else if (/(?:^|,)\s*av01/i.test(codecs)) details.push('AV1');
    if (/(?:^|,)\s*mp4a/i.test(codecs)) details.push('AAC');
    else if (/(?:^|,)\s*ec-3/i.test(codecs)) details.push('EAC3');
    else if (/(?:^|,)\s*ac-3/i.test(codecs)) details.push('AC3');
    if (best.fields['VIDEO-RANGE'] === 'PQ') details.push('HDR (PQ)');
    else if (best.fields['VIDEO-RANGE'] === 'HLG') details.push('HLG');
    else if (best.fields['VIDEO-RANGE'] === 'SDR') details.push('SDR');
  }
  const languages = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const fields = attributes(line);
    if (fields.TYPE !== 'AUDIO' || !audioGroups.has(fields['GROUP-ID'] ?? '')) continue;
    const value = shortText(fields.LANGUAGE, 50);
    if (value) languages.add(normalizeDeclaredLanguage(value));
  }
  return { details, quality, ...(languages.size ? { language: [...languages].join(' / ') } : {}) };
}

export async function resolveHlsMetadata(http: HttpClient, url: string, headers: Record<string, string>): Promise<HlsMetadata> {
  const target = httpUrl(url);
  const response = await http.request(target, { headers });
  httpUrl(response.url);
  return parseHlsMetadata(responseText(response));
}
