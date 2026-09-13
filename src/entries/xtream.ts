import { createHttpClient } from '../native/http.js';
import { createMetadataProvider } from '../native/metadata.js';
import { createXtreamProvider, xtreamSettings } from '../native/xtream.js';
import { parseRequest } from '../native/request.js';

export async function getStreams(id: string | number, type: string, season?: number, episode?: number) {
  const http = createHttpClient();
  const settings = (globalThis as unknown as { SCRAPER_SETTINGS?: unknown }).SCRAPER_SETTINGS;
  return createXtreamProvider(http, createMetadataProvider(http), settings).getStreams(parseRequest(id, type, season, episode));
}

export function onSettings() { return xtreamSettings(); }
