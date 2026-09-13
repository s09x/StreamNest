import URLToolkit from 'url-toolkit';

/** Resolve references before passing an absolute address to Nuvio's URL bridge. */
export function resolveUrl(input: string, base?: string): URL {
  if (/[\r\n\0\\]/.test(input) || (base !== undefined && /[\r\n\0\\]/.test(base))) throw new Error('Invalid URL');
  // Mobile's bridge concatenates //host/path onto the old origin and also
  // mishandles a relative path when the base has no trailing slash.
  const absolute = base === undefined ? input : URLToolkit.buildAbsoluteURL(base, input, { alwaysNormalize: true });
  const authority = /^(?:https?:)?\/\/([^/?#]*)/i.exec(absolute)?.[1];
  // Some native URL objects omit username/password. Check the input as well.
  if (authority && (authority.includes('@') || /%40/i.test(authority))) throw new Error('Invalid URL');
  const url = new URL(absolute);
  // Ktor exposes absent components as non-null empty strings. Some Nuvio
  // bridges prepend their delimiters anyway. Match browser URL properties
  // without rewriting href or altering nonempty query/fragment values.
  if (url.search === '?') url.search = '';
  if (url.hash === '#') url.hash = '';
  return url;
}
