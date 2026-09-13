import { createHttpClient } from '../native/http.js';
import { createMetadataProvider } from '../native/metadata.js';
import { createWebProviders } from '../native/web.js';
import { parseRequest } from '../native/request.js';

export async function getStreams(id: string | number, type: string, season?: number, episode?: number) {
  const http = createHttpClient();
  return createWebProviders(http, createMetadataProvider(http)).filmpalast(parseRequest(id, type, season, episode));
}
