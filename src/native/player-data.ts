import JSON5 from 'json5';
import { ProviderError } from './errors.js';

const MAX_DATA_LENGTH = 1024 * 1024;

/** Parse a bounded JavaScript data literal, never a statement or expression. */
export function readPlayerLiteral(source: string, offset = 0): { value: unknown; end: number } {
  let start = offset;
  while (/\s/.test(source[start] ?? '') && start < source.length) start++;
  let cursor = start;
  let quote = '';
  let comment = '';
  const closing: string[] = [];
  const first = source[start];
  if (first === '"' || first === "'") quote = source[cursor++]!;
  else if (first === '{' || first === '[') { closing.push(first === '{' ? '}' : ']'); cursor++; }
  else {
    const primitive = /^(?:true|false|null|[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))(?=$|[\s,;\]}])/.exec(source.slice(start, start + 128));
    if (!primitive) throw new ProviderError('invalid_response');
    return { value: JSON5.parse(primitive[0]), end: start + primitive[0].length };
  }
  for (; cursor < source.length && cursor - start <= MAX_DATA_LENGTH; cursor++) {
    const character = source[cursor]!;
    if (comment === '//') { if (character === '\n' || character === '\r') comment = ''; continue; }
    if (comment === '/*') { if (character === '*' && source[cursor + 1] === '/') { comment = ''; cursor++; } continue; }
    if (quote) {
      if (character === '\\') { cursor++; continue; }
      if (character !== quote) continue;
      quote = '';
      if (!closing.length) { cursor++; break; }
      continue;
    }
    if (character === '/' && ['/', '*'].includes(source[cursor + 1] ?? '')) { comment = character + source[++cursor]; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{' || character === '[') {
      closing.push(character === '{' ? '}' : ']');
      if (closing.length > 32) throw new ProviderError('response_incomplete');
    } else if (character === '}' || character === ']') {
      if (closing.pop() !== character) throw new ProviderError('invalid_response');
      if (!closing.length) { cursor++; break; }
    }
  }
  if (cursor - start > MAX_DATA_LENGTH || quote || closing.length || comment) throw new ProviderError('response_incomplete');
  try { return { value: JSON5.parse(source.slice(start, cursor)), end: cursor }; }
  catch { throw new ProviderError('invalid_response'); }
}

/** Dean Edwards' public string table format, decoded without executing its wrapper. */
export function unpackPlayerScripts(script: string): string[] {
  if (script.length > MAX_DATA_LENGTH) throw new ProviderError('response_incomplete');
  const result = [script];
  const seen = new Set(result);
  const wrapper = /\b(?:eval\s*\()?\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)/g;
  for (let layer = 0; layer < result.length && layer < 8; layer++) {
    const input = result[layer]!;
    wrapper.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = wrapper.exec(input))) {
      const call = /\}\s*\(\s*(?=['"])/g;
      call.lastIndex = match.index + match[0].length;
      const invocation = call.exec(input);
      if (!invocation || invocation.index - match.index > 5000) throw new ProviderError('invalid_response');
      let cursor = invocation.index + invocation[0].length;
      const payload = readPlayerLiteral(input, cursor); cursor = payload.end;
      function next(): unknown {
        const comma = /^\s*,\s*/.exec(input.slice(cursor));
        if (!comma) throw new ProviderError('invalid_response');
        const value = readPlayerLiteral(input, cursor + comma[0].length); cursor = value.end;
        return value.value;
      }
      const radix = next(); const count = next(); const dictionary = next();
      const split = /^\s*\.\s*split\s*\(\s*(['"])\|\1\s*\)/.exec(input.slice(cursor));
      if (typeof payload.value !== 'string' || typeof dictionary !== 'string' || !split
        || !Number.isSafeInteger(radix) || (radix as number) < 2 || (radix as number) > 62
        || !Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 10000) throw new ProviderError('invalid_response');
      const words = dictionary.split('|');
      if (words.length !== count && !(count === 0 && dictionary === '')) throw new ProviderError('invalid_response');
      const transform = input.slice(match.index + match[0].length, invocation.index + 1);
      if (count !== 0 && (!/while\s*\(\s*c\s*--\s*\)/.test(transform)
        || !/\bp\s*=\s*p\s*\.\s*replace\s*\(/.test(transform) || !/\breturn\s+p\b/.test(transform))) {
        throw new ProviderError('invalid_response');
      }
      const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const output = payload.value.replace(/\b[0-9A-Za-z]+\b/g, token => {
        let index = 0;
        for (const character of token) {
          const digit = alphabet.indexOf(character);
          if (digit < 0 || digit >= (radix as number)) return token;
          index = index * (radix as number) + digit;
          if (index >= words.length) return token;
        }
        return words[index] || token;
      });
      if (output.length > MAX_DATA_LENGTH) throw new ProviderError('response_incomplete');
      if (!seen.has(output)) { seen.add(output); result.push(output); }
      if (result.length > 8) throw new ProviderError('response_incomplete');
      wrapper.lastIndex = cursor + split[0].length;
    }
  }
  return result;
}

/** Only literal concatenation and the published substring operation are allowed. */
export function readPlayerStringExpression(source: string): string {
  let cursor = 0;
  let operations = 0;
  function expression(depth: number): string {
    if (depth > 8) throw new ProviderError('response_incomplete');
    let result = '';
    while (++operations <= 64) {
      cursor += /^\s*/.exec(source.slice(cursor))![0].length;
      let value: string;
      if (source[cursor] === '(') {
        cursor++; value = expression(depth + 1);
        const close = /^\s*\)/.exec(source.slice(cursor));
        if (!close) throw new ProviderError('invalid_response');
        cursor += close[0].length;
      } else {
        const literal = readPlayerLiteral(source, cursor);
        if (typeof literal.value !== 'string') throw new ProviderError('invalid_response');
        value = literal.value; cursor = literal.end;
      }
      let substring: RegExpExecArray | null;
      while ((substring = /^\s*\.\s*(substring|substr|slice)\s*\(\s*(\d{1,6})(?:\s*,\s*(\d{1,6}))?\s*\)/.exec(source.slice(cursor)))) {
        if (++operations > 64) throw new ProviderError('response_incomplete');
        const start = Number(substring[2]); const end = substring[3] === undefined ? undefined : Number(substring[3]);
        value = substring[1] === 'substr' ? value.slice(start, end === undefined ? undefined : start + end) : value.slice(start, end);
        cursor += substring[0].length;
      }
      result += value;
      if (result.length > 16000) throw new ProviderError('response_incomplete');
      const plus = /^\s*\+\s*/.exec(source.slice(cursor));
      if (!plus) return result;
      cursor += plus[0].length;
    }
    throw new ProviderError('response_incomplete');
  }
  const result = expression(0);
  if (!/^\s*;?\s*$/.test(source.slice(cursor))) throw new ProviderError('invalid_response');
  return result;
}
