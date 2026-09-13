import { createHttpClient } from '../native/http.js';
import { getHuhuStreams } from '../native/huhu.js';
import { parseRequest } from '../native/request.js';

export async function getStreams(id: string | number, type: string, season?: number, episode?: number) {
  const request = parseRequest(id, type, season, episode);
  return getHuhuStreams(createHttpClient(), request);
}
