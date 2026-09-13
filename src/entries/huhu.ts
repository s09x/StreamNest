import { createHttpClient } from '../native/http.js';
import { inspectHuhuStreams, type HuhuSourceReport } from '../native/huhu.js';
import { ProviderError } from '../native/errors.js';
import { parseRequest } from '../native/request.js';
import type { ContentRequest } from '../native/types.js';

let callNumber = 0;
let lastReport: { request: ContentRequest; streamCount: number; sources: HuhuSourceReport[] } | undefined;

export async function getStreams(id: string | number, type: string, season?: number, episode?: number) {
  const call = ++callNumber;
  lastReport = undefined;
  const request = parseRequest(id, type, season, episode);
  const result = await inspectHuhuStreams(createHttpClient(), request);
  if (call === callNumber) lastReport = { request, streamCount: result.streams.length, sources: result.sources };
  if (!result.streams.length && result.failure) throw new ProviderError(result.failure);
  return result.streams;
}

/** Same-runtime diagnostics do not repeat requests or retain media URLs/tokens. */
export function getSourceReport() {
  return lastReport ? { request: { ...lastReport.request }, streamCount: lastReport.streamCount,
    sources: lastReport.sources.map(source => ({ ...source, languages: source.languages?.slice(), qualities: source.qualities?.slice() })) } : null;
}
