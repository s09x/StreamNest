import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../src/native/errors.js';
import { readCompleteJsonProperty } from '../src/native/json-prefix.js';

function invalid(text: string, path = ['info']): void {
  assert.throws(() => readCompleteJsonProperty(text, path), (error: unknown) =>
    error instanceof ProviderError && error.code === 'invalid_response'
      && error.message === 'StreamNest: the source returned an unexpected response.');
}

test('returns complete object properties, nested values, null and empty containers', () => {
  const text = '{"info":{"tmdb":"70523","name":"Dark","empty":[],"nothing":null},"episodes":[]}';
  assert.deepEqual(readCompleteJsonProperty(text, ['info']), { tmdb: '70523', name: 'Dark', empty: [], nothing: null });
  assert.equal(readCompleteJsonProperty(text, ['info', 'tmdb']), '70523');
  assert.equal(readCompleteJsonProperty(text, ['info', 'nothing']), null);
  assert.deepEqual(readCompleteJsonProperty(text, ['info', 'empty']), []);
  assert.equal(readCompleteJsonProperty(text, ['missing']), undefined);
  assert.equal(readCompleteJsonProperty(text, ['info', 'tmdb', 'missing']), undefined);
  assert.deepEqual(readCompleteJsonProperty('{"info":{}}', ['info']), {});
});

test('matches decoded keys and handles quoted punctuation and JSON escapes', () => {
  const text = String.raw`{"\u0069nfo":{"na\"me":"quotes \" braces } ] and slash \\ \/","unicode":"\uD83D\uDE00","newline":"one\ntwo"}}`;
  assert.equal(readCompleteJsonProperty(text, ['info', 'na"me']), 'quotes " braces } ] and slash \\ /');
  assert.equal(readCompleteJsonProperty(text, ['info', 'unicode']), '😀');
  assert.equal(readCompleteJsonProperty(text, ['info', 'newline']), 'one\ntwo');
});

test('does not find property-looking text inside strings, arrays or other branches', () => {
  const text = '{"noise":"\\\"info\\\": {\\\"tmdb\\\": 999}","array":[{"info":{"tmdb":999}}],"nested":{"info":999},"info":{"tmdb":70523}}';
  assert.deepEqual(readCompleteJsonProperty(text, ['info']), { tmdb: 70523 });
  assert.equal(readCompleteJsonProperty(text, ['array', '0', 'info']), undefined);
  assert.equal(readCompleteJsonProperty('[{"info":123}]', ['info']), undefined);
});

test('skips complete unknown values before the requested property', () => {
  const text = '{"other":[true,false,null,-12.5e+2,{"deep":["\\u0061",{}]}],"info":{"id":"tt5753856"}}';
  assert.deepEqual(readCompleteJsonProperty(text, ['info']), { id: 'tt5753856' });
});

test('every truncation of a valid response exposes the target only after its closing token', () => {
  const value = { tmdb: '70523', title: 'A "quoted" title', values: [false, 1.25, null] };
  const start = '{"before":[{"escaped":"a\\\\b"},-1.5e+2],"info":';
  const text = start + JSON.stringify(value) + ',"episodes":[{"name":"unfinished tail"}]}';
  const completeAt = start.length + JSON.stringify(value).length;
  for (let end = 0; end <= text.length; end++) {
    assert.deepEqual(readCompleteJsonProperty(text.slice(0, end), ['info']), end >= completeAt ? value : undefined, `prefix length ${end}`);
  }
});

test('retains a complete target before a truncated later string, object or array', () => {
  for (const tail of ['"partial', '{"nested":', '[{"episode":1},', '[true,', '-12e+']) {
    assert.deepEqual(readCompleteJsonProperty('{"info":{"id":7},"episodes":' + tail, ['info']), { id: 7 });
  }
  assert.equal(readCompleteJsonProperty('{"meta":{"id":"tt123","videos":[', ['meta', 'id']), 'tt123');
  assert.equal(readCompleteJsonProperty('{"meta":{"id":"tt123","videos":[', ['meta']), undefined);
});

test('recognizes the exact native truncation suffix without treating it as source JSON', () => {
  const text = '{"info":{"id":7},"episodes":[{"title":"partial';
  assert.deepEqual(readCompleteJsonProperty(text + '\n...[truncated]', ['info']), { id: 7 });
  assert.equal(readCompleteJsonProperty('{"info":"partial\n...[truncated]', ['info']), undefined);
  assert.equal(readCompleteJsonProperty('{"info":"literal\\n...[truncated]"}', ['info']), 'literal\n...[truncated]');
  invalid('{"info":{"id":7}}...[truncated]');
});

test('never presents an unfinished requested array or object as a complete value', () => {
  for (const text of ['{"info":[1,2', '{"info":[{"id":1}', '{"info":{"id":1', '{"info":{"id":"partial']) {
    assert.equal(readCompleteJsonProperty(text, ['info']), undefined);
  }
  assert.deepEqual(readCompleteJsonProperty('{"info":[1,2]', ['info']), [1, 2]);
});

test('requires an observed scalar boundary so cut numbers cannot become positive identities', () => {
  for (const token of ['1', '123', '-0', '12.34', '1e2', '-', '1.', '1e', '1e+', 'true', 'false', 'null']) {
    assert.equal(readCompleteJsonProperty('{"info":' + token, ['info']), undefined, token);
  }
  assert.equal(readCompleteJsonProperty('{"info":123 ', ['info']), 123);
  assert.equal(readCompleteJsonProperty('{"info":-1.25e+2}', ['info']), -125);
  assert.equal(readCompleteJsonProperty('{"info":true,', ['info']), true);
  assert.equal(readCompleteJsonProperty('{"info":false}', ['info']), false);
});

test('incomplete strings and escapes remain unavailable instead of failing valid prefixes', () => {
  for (const text of ['{"inf', '{"info"', '{"info":', '{"info":"\\', '{"info":"\\u', '{"info":"\\u12', '{"info":tru']) {
    assert.equal(readCompleteJsonProperty(text, ['info']), undefined);
  }
});

test('rejects visible malformed grammar, including malformed data after a completed target', () => {
  for (const text of [
    '<html>error</html>', '{info:1}', '{"info" 1}', '{"info":}', '{"info":01}',
    '{"info":1.}', '{"info":1e+}', '{"info":+1}', '{"info":truX}', '{"info":nulll}',
    '{"info":NaN}', '{"info":true false}', '{"info":[1,]}', '{"info":{"id":1,}}',
    '{"info":[,1]}', '{"info":[1}}', '{"info":1}false', '{"info":1,"other":2x',
    '{"info":1,"other":"bad\nescape"}', '{"info":1,"other":"\\q', '{"info":1,"other":"\\u1X',
    '{"info":1} /* comment */', '{"info":1},',
  ]) invalid(text);
});

test('rejects visible duplicate keys, including escaped spellings and incomplete duplicate values', () => {
  for (const text of [
    '{"info":1,"info":2}', '{"info":{"id":1,"id":2}}',
    '{"other":{"x":1,"x":2},"info":3}', '{"info":1,"other":{"x":1,"x":',
    '{"info":1,"\\u0069nfo":', '{"info":1,"info"',
  ]) invalid(text);
  assert.equal(readCompleteJsonProperty('{"left":{"id":1},"right":{"id":2},"info":3}', ['info']), 3);
});

test('treats special object keys as data without mutating prototypes', () => {
  assert.equal(readCompleteJsonProperty('{"__proto__":{"safe":7},"constructor":8}', ['__proto__', 'safe']), 7);
  assert.equal(readCompleteJsonProperty('{"__proto__":{"safe":7},"constructor":8}', ['constructor']), 8);
  assert.equal(Object.hasOwn(Object.prototype, 'safe'), false);
});

test('an empty path requires a complete root container and never assembles a partial root', () => {
  assert.deepEqual(readCompleteJsonProperty('{"info":1}', []), { info: 1 });
  assert.deepEqual(readCompleteJsonProperty('[1,2]', []), [1, 2]);
  assert.equal(readCompleteJsonProperty('{"info":1', []), undefined);
  assert.equal(readCompleteJsonProperty('123', []), undefined);
});

test('handles a native-sized truncated tail with bounded input and nesting', () => {
  const text = '{"info":{"tmdb":"70523"},"episodes":"' + 'x'.repeat(1024 * 1024 - 64);
  assert.deepEqual(readCompleteJsonProperty(text, ['info']), { tmdb: '70523' });
  invalid('{"info":1,"deep":' + '['.repeat(66));
  invalid(' '.repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => readCompleteJsonProperty('{}', Array(65).fill('key')), ProviderError);
});
