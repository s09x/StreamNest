import { createHdfilmeProvider } from '../native/hdfilme.js';
import { createHttpClient } from '../native/http.js';
import { createMetadataProvider } from '../native/metadata.js';
import { parseRequest } from '../native/request.js';

export async function getStreams(id: string | number, type: string, season?: number, episode?: number) {
  const request = parseRequest(id, type, season, episode);
  if (request.type !== 'movie') return [];
  const http = createHttpClient();
  return createHdfilmeProvider(http, createMetadataProvider(http))(request);
}
