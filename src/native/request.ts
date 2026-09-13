import { ProviderError } from './errors.js';
import type { ContentRequest, MediaType } from './types.js';

export function parseRequest(id: string | number, type: string, season?: number, episode?: number): ContentRequest {
  const mediaType: MediaType | null = type === 'movie' ? 'movie' : type === 'tv' || type === 'series' ? 'tv' : null;
  if (!mediaType) throw new ProviderError('invalid_request');
  const raw = String(id).trim().replace(/^tmdb\//, 'tmdb:');
  const match = /^(?:(?:tmdb:)?([1-9]\d*)|(tt\d+))(?::(\d+):(\d+))?$/.exec(raw);
  if (!match) throw new ProviderError('invalid_request');
  if (match[3] !== undefined) {
    if ((season != null && Number(match[3]) !== season) || (episode != null && Number(match[4]) !== episode)) throw new ProviderError('invalid_request');
    season = Number(match[3]); episode = Number(match[4]);
  }
  season = season ?? undefined; episode = episode ?? undefined;
  if (mediaType === 'movie' && (season !== undefined || episode !== undefined)) throw new ProviderError('invalid_request');
  if (mediaType === 'tv' && (!Number.isSafeInteger(season) || season! < 0 || !Number.isSafeInteger(episode) || episode! < 0)) throw new ProviderError('invalid_request');
  return { type: mediaType, id: match[2] ?? match[1]!, tmdbId: match[1], imdbId: match[2], season, episode };
}

export function parseHost(value: unknown): string {
  if (typeof value !== 'string') throw new ProviderError('configuration_required');
  const input = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(input) || /[\s?#]/.test(input) || /^https?:\/\/[^/]*@/i.test(input)) throw new ProviderError('configuration_required');
  try {
    const host = new URL(input);
    if (!host.hostname || host.username || host.password) throw new Error();
    return host.href.replace(/\/+$/, '');
  } catch { throw new ProviderError('configuration_required'); }
}
