import { ProviderError } from './errors.js';
import type { NativeStream } from './types.js';

export interface Mirror {
  key: string; url?: string; quality?: string; language?: string;
  provider?: 'voe' | 'vixeo' | 'playmate' | 'flyfile' | 'firestream' | 'byse';
}

export async function resolveMirrors(
  page: { title: string; release?: string; mirrors: Mirror[] },
  resolver: (mirror: Mirror) => Promise<NativeStream>,
): Promise<NativeStream[]> {
  const streams: NativeStream[] = [];
  let failure: ProviderError | undefined;
  const seen = new Set<string>();
  const resolved: Array<NativeStream | ProviderError> = new Array(page.mirrors.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < page.mirrors.length) {
      const index = next++;
      try { resolved[index] = await resolver(page.mirrors[index]!); }
      catch (error) { resolved[index] = error instanceof ProviderError ? error : new ProviderError('request_failed'); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, page.mirrors.length) }, () => worker()));
  for (let index = 0; index < page.mirrors.length; index++) {
    const mirror = page.mirrors[index]!;
    try {
      const stream = resolved[index]!;
      if (stream instanceof ProviderError) throw stream;
      if (seen.has(stream.url)) continue;
      seen.add(stream.url);
      const label = stream.title && stream.title !== 'VOE' ? stream.title : page.release ?? page.title;
      const hoster = ({ voe: 'VOE', vixeo: 'Vixeo', playmate: 'Playmate', flyfile: 'FlyFile', firestream: 'FireStream', byse: 'Byse' })[mirror.provider ?? 'voe'];
      const pageFallback = !mirror.provider || mirror.provider === 'voe';
      streams.push({ ...stream, title: `${label} • ${hoster}`, quality: stream.quality ?? (pageFallback ? mirror.quality : undefined),
        language: stream.language ?? (pageFallback ? mirror.language : undefined) });
    } catch (error) {
      failure ??= error instanceof ProviderError ? error : new ProviderError('request_failed');
    }
  }
  if (!streams.length && failure) throw failure;
  return streams;
}
