export type FailureCode = 'invalid_request' | 'configuration_required' | 'authentication_failed' | 'request_failed' | 'source_blocked' | 'source_unavailable' | 'unsupported_hoster' | 'invalid_response' | 'response_incomplete' | 'ambiguous_match' | 'unsupported_runtime';
const messages: Record<FailureCode, string> = {
  invalid_request: 'StreamNest: invalid movie or episode request.',
  configuration_required: 'StreamNest: configure the provider before using it.',
  authentication_failed: 'StreamNest: the source rejected the supplied account.',
  request_failed: 'StreamNest: a source request failed.',
  source_blocked: 'StreamNest: the source requires an interactive access check.',
  source_unavailable: 'StreamNest: the source file is unavailable.',
  unsupported_hoster: 'StreamNest: this hoster does not expose a supported playback route.',
  invalid_response: 'StreamNest: the source returned an unexpected response.',
  response_incomplete: 'StreamNest: Nuvio did not return the complete source response.',
  ambiguous_match: 'StreamNest: more than one source item matches this request.',
  unsupported_runtime: 'StreamNest: this Nuvio runtime lacks a required provider feature.',
};
export class ProviderError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(messages[code]); this.name = 'ProviderError'; this.code = code; }
}
