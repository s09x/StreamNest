export type MediaType = 'movie' | 'tv';
export interface ContentRequest { type: MediaType; id: string; tmdbId?: string; imdbId?: string; season?: number; episode?: number }
export interface Identity { type: MediaType; title: string; aliases: string[]; year?: number; tmdbId?: string; imdbId?: string }
export interface NativeSubtitle { url: string; language: string; name?: string; headers?: Record<string, string> }
export interface NativeStream {
  url: string; title: string; name?: string; quality?: string; size?: string; language?: string;
  headers?: Record<string, string>; subtitles?: NativeSubtitle[];
}
export interface RequestOptions { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; redirect?: 'follow' | 'manual' }
export interface TextResponse { status: number; url: string; text: string; header(name: string): string | null }
export interface HttpClient {
  request(url: string, options?: RequestOptions): Promise<TextResponse>;
  json(url: string, options?: RequestOptions): Promise<unknown>;
  session(): HttpClient;
  cookies(url: string): Record<string, string>;
}
export interface MetadataProvider { resolve(request: ContentRequest): Promise<Identity | null> }
export interface WebProviders { filmpalast(request: ContentRequest): Promise<NativeStream[]>; filmo(request: ContentRequest): Promise<NativeStream[]> }
export interface SettingsField {
  type: 'header' | 'info' | 'text' | 'select' | 'toggle'; label: string; key?: string;
  description?: string; placeholder?: string; isPassword?: boolean; defaultValue?: string | boolean;
  options?: Array<{ label: string; value: string }>;
}
