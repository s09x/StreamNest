import { createHttpClient } from '../native/http.js';
import { createMetadataProvider } from '../native/metadata.js';
import { createMegakinoProvider } from '../native/megakino.js';
import { parseRequest } from '../native/request.js';

export async function getStreams(id: string | number, type: string, season?: number, episode?: number) {
  const request = parseRequest(id, type, season, episode);
  const http = createHttpClient();
  return createMegakinoProvider(http, createMetadataProvider(http)).getStreams(request);
}
