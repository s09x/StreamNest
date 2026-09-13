import { ProviderError } from './errors.js';

const MAX_PREFIX_LENGTH = 2 * 1024 * 1024;
const MAX_DEPTH = 64;
const TRUNCATION_SUFFIX = '\n...[truncated]';

function invalid(): never {
  throw new ProviderError('invalid_response');
}

function whitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

function digit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

function delimiter(character: string | undefined): boolean {
  return whitespace(character) || character === ',' || character === ']' || character === '}';
}

class PrefixReader {
  private offset = 0;
  private result: unknown;

  constructor(private readonly text: string, private readonly path: readonly string[]) {}

  read(): unknown | undefined {
    const complete = this.value(0, 0);
    this.skipWhitespace();
    if (complete && this.offset !== this.text.length) invalid();
    return this.result;
  }

  private skipWhitespace(): void {
    while (whitespace(this.text[this.offset])) this.offset++;
  }

  private value(depth: number, pathIndex: number | null): boolean {
    if (depth > MAX_DEPTH) invalid();
    this.skipWhitespace();
    if (this.offset === this.text.length) return false;
    const start = this.offset;
    const character = this.text[this.offset];
    let complete: boolean;
    if (character === '{') complete = this.object(depth, pathIndex);
    else if (character === '[') complete = this.array(depth);
    else if (character === '"') complete = this.string() !== undefined;
    else if (character === '-' || digit(character)) complete = this.number();
    else if (character === 't') complete = this.literal('true');
    else if (character === 'f') complete = this.literal('false');
    else if (character === 'n') complete = this.literal('null');
    else return invalid();

    if (complete && pathIndex === this.path.length) {
      try {
        this.result = JSON.parse(this.text.slice(start, this.offset));
      } catch {
        invalid();
      }
    }
    return complete;
  }

  private object(depth: number, pathIndex: number | null): boolean {
    this.offset++;
    this.skipWhitespace();
    if (this.text[this.offset] === '}') {
      this.offset++;
      return true;
    }
    const keys = new Set<string>();
    while (this.offset < this.text.length) {
      if (this.text[this.offset] !== '"') invalid();
      const key = this.string();
      if (key === undefined) return false;
      if (keys.has(key)) invalid();
      keys.add(key);
      this.skipWhitespace();
      if (this.offset === this.text.length) return false;
      if (this.text[this.offset++] !== ':') invalid();
      const childPath = pathIndex !== null && pathIndex < this.path.length && key === this.path[pathIndex]
        ? pathIndex + 1 : null;
      if (!this.value(depth + 1, childPath)) return false;
      this.skipWhitespace();
      if (this.offset === this.text.length) return false;
      const separator = this.text[this.offset++];
      if (separator === '}') return true;
      if (separator !== ',') invalid();
      this.skipWhitespace();
    }
    return false;
  }

  private array(depth: number): boolean {
    this.offset++;
    this.skipWhitespace();
    if (this.text[this.offset] === ']') {
      this.offset++;
      return true;
    }
    while (this.offset < this.text.length) {
      // A string path identifies object properties, never array positions.
      if (!this.value(depth + 1, null)) return false;
      this.skipWhitespace();
      if (this.offset === this.text.length) return false;
      const separator = this.text[this.offset++];
      if (separator === ']') return true;
      if (separator !== ',') invalid();
      this.skipWhitespace();
    }
    return false;
  }

  private string(): string | undefined {
    const start = this.offset++;
    while (this.offset < this.text.length) {
      const character = this.text[this.offset++];
      if (character === '"') {
        try {
          return JSON.parse(this.text.slice(start, this.offset)) as string;
        } catch {
          return invalid();
        }
      }
      if (character!.charCodeAt(0) < 0x20) invalid();
      if (character !== '\\') continue;
      if (this.offset === this.text.length) return undefined;
      const escape = this.text[this.offset++];
      if (escape === 'u') {
        for (let count = 0; count < 4; count++) {
          if (this.offset === this.text.length) return undefined;
          const code = this.text[this.offset++]!;
          if (!digit(code) && !(code >= 'a' && code <= 'f') && !(code >= 'A' && code <= 'F')) invalid();
        }
      } else if (!'"\\/bfnrt'.includes(escape!)) invalid();
    }
    return undefined;
  }

  private number(): boolean {
    if (this.text[this.offset] === '-') {
      this.offset++;
      if (this.offset === this.text.length) return false;
    }
    if (this.text[this.offset] === '0') this.offset++;
    else {
      if (!digit(this.text[this.offset])) invalid();
      while (digit(this.text[this.offset])) this.offset++;
    }
    if (this.text[this.offset] === '.') {
      this.offset++;
      if (this.offset === this.text.length) return false;
      if (!digit(this.text[this.offset])) invalid();
      while (digit(this.text[this.offset])) this.offset++;
    }
    if (this.text[this.offset] === 'e' || this.text[this.offset] === 'E') {
      this.offset++;
      if (this.text[this.offset] === '+' || this.text[this.offset] === '-') this.offset++;
      if (this.offset === this.text.length) return false;
      if (!digit(this.text[this.offset])) invalid();
      while (digit(this.text[this.offset])) this.offset++;
    }
    return this.scalarBoundary();
  }

  private literal(expected: string): boolean {
    for (let index = 0; index < expected.length; index++) {
      if (this.offset === this.text.length) return false;
      if (this.text[this.offset++] !== expected[index]) invalid();
    }
    return this.scalarBoundary();
  }

  private scalarBoundary(): boolean {
    // EOF may cut 12345 into 123. Require an observed terminator for scalars.
    if (this.offset === this.text.length) return false;
    if (!delimiter(this.text[this.offset])) invalid();
    return true;
  }
}

/**
 * Read a complete value at an object-property path in a possibly truncated JSON
 * response. Missing/incomplete values return undefined; visible malformed JSON
 * and duplicate keys fail. A complete value does not establish completeness of
 * the surrounding document. Only the exact native transport suffix is removed.
 * Empty paths select the root; array-index traversal is deliberately unsupported.
 * Work is linear in the bounded input, with at most 64 levels of nesting.
 */
export function readCompleteJsonProperty(text: string, path: string[]): unknown | undefined {
  if (typeof text !== 'string' || text.length > MAX_PREFIX_LENGTH + TRUNCATION_SUFFIX.length
    || !Array.isArray(path) || path.length > MAX_DEPTH || path.some(key => typeof key !== 'string')) invalid();
  const prefix = text.endsWith(TRUNCATION_SUFFIX) ? text.slice(0, -TRUNCATION_SUFFIX.length) : text;
  if (prefix.length > MAX_PREFIX_LENGTH) invalid();
  return new PrefixReader(prefix, path).read();
}
