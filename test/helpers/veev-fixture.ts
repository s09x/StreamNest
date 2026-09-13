export const veevCode = 'Fixture12345';
export const veevPageUrl = `https://veev.to/e/${veevCode}`;
export const veevPlan = [[1, 0, 1], [0, 1], [1]];
export const veevKey = veevPlan.map(steps => String(steps.length) + [...steps].reverse().join('')).join('') + '0fixture+nonce&suffix';

export function compressVeev(value: string): string {
  const dictionary = new Map<string, number>();
  let next = 256;
  let phrase = '';
  const result: number[] = [];
  function emit(word: string) { result.push(word.length === 1 ? word.charCodeAt(0) : dictionary.get(word)!); }
  for (const character of value) {
    const combined = phrase + character;
    if (combined.length === 1 || dictionary.has(combined)) { phrase = combined; continue; }
    emit(phrase); dictionary.set(combined, next++); phrase = character;
  }
  if (phrase) emit(phrase);
  return result.map(code => String.fromCharCode(code)).join('');
}

export function encodeVeev(value: string, plan: number[]): string {
  let output = value;
  for (const step of [...plan].reverse()) {
    output = Buffer.from(output + 'dXRmOA==', 'utf8').toString('hex');
    if (step === 1) output = [...output].reverse().join('');
  }
  return compressVeev(output);
}

export function veevPage(key = veevKey): string {
  return `<html><head><title>Veev fixture</title></head><body>
    <script>window._vvto={fc:'synthetic-decoy'}; globalThis.veevMustNotExecute=true;</script>
    <script>var __fixtureKey='fc';window._vvto[__fixtureKey]=${JSON.stringify(compressVeev(key))};</script></body></html>`;
}

export function veevInfo(sources = [
  { url: 'https://media.example.invalid/720.mp4?fixture=one%2Btwo', quality: '720', type: 'video/mp4' },
  { url: 'https://media.example.invalid/1080.mp4?fixture=one%20two', quality: '1080', type: 'video/mp4' },
]) {
  return { status: 'success', file: { file_code: veevCode, file_title: 'Upload.2160p.mkv', file_status: 'OK', disable_adb: 0, file_a: 0,
    dv: sources.map(source => ({ s: encodeVeev(source.url, veevPlan[0]!), sz: encodeVeev(source.quality, veevPlan[2]!), t: encodeVeev(source.type, veevPlan[1]!) })),
    captions_list: [{ src: '/captions/de.vtt?fixture=one%2Btwo', srcLang: 'ger', label: 'German (FORCED)' }] } };
}

export const veevApiUrl = 'https://veev.to/dl?' + new URLSearchParams({ op: 'player_api', cmd: 'gi', file_code: veevCode,
  r: 'https://huhu.to/', ch: veevKey, ie: '1' }).toString();
