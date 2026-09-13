import test from 'node:test';
import assert from 'node:assert/strict';
import { readPlayerLiteral, readPlayerStringExpression, unpackPlayerScripts } from '../src/native/player-data.js';
import { ProviderError } from '../src/native/errors.js';

test('player literals retain escaped Unicode, signed queries, JSON5 keys and comments without evaluating expressions', () => {
  const source = ` [ {file: 'https://media.example.invalid/\\u00fc.m3u8?token=one%2Btwo', res: 1080, /* fixture */ active:true,}, ] ; ignored()`;
  const result = readPlayerLiteral(source);
  assert.deepEqual(result.value, [{ file: 'https://media.example.invalid/ü.m3u8?token=one%2Btwo', res: 1080, active: true }]);
  assert.match(source.slice(result.end), /^ ; ignored/);
  assert.equal(readPlayerLiteral(`'a\\x2fb\\'c'`).value, "a/b'c");
  for (const expression of ['getSecret()', 'window.location', '`template`', '{file: execute()}', '[...other]', 'Infinity', 'NaN']) {
    assert.throws(() => readPlayerLiteral(expression), ProviderError);
  }
});

test('player literals reject truncated strings, mismatched containers, deep data and oversized literals', () => {
  for (const value of ["'unfinished", '[1,2', '{file: "missing"', '[}', '/* only a comment */']) assert.throws(() => readPlayerLiteral(value), ProviderError);
  assert.throws(() => readPlayerLiteral('['.repeat(34) + '0' + ']'.repeat(34)), error => error instanceof ProviderError && error.code === 'response_incomplete');
  assert.throws(() => readPlayerLiteral('"' + 'x'.repeat(1024 * 1024 + 1) + '"'), ProviderError);
});

test('packed player tables decode base36 and base62 and never run decoded code', () => {
  const body = String.raw`while(c--)if(k[c])p=p.replace(new RegExp('\\b'+c.toString(a)+'\\b','g'),k[c]);return p;`;
  const packed = `eval(function(p,a,c,k,e,d){${body}}('0(1);2=3;',36,4,'show|1080|fixtureExecuted|true'.split('|'),0,{}))`;
  assert.deepEqual(unpackPlayerScripts(packed), [packed, 'show(1080);fixtureExecuted=true;']);
  assert.equal((globalThis as Record<string, unknown>).fixtureExecuted, undefined);
  const words = Array.from({ length: 62 }, (_, index) => `word${index}`);
  const base62 = `eval(function(p,a,c,k,e,r){${body}}('a z A Z',62,62,${JSON.stringify(words.join('|'))}.split('|'),0,{}))`;
  assert.equal(unpackPlayerScripts(base62)[1], 'word10 word35 word36 word61');
});

test('packed player formats require literal parameters, valid bases and complete dictionaries', () => {
  for (const args of [`'0',1,1,'word'.split('|')`, `'0',63,1,'word'.split('|')`, `'0',36,2,'word'.split('|')`,
    `'0',36,1,readCookie().split('|')`, `'0',36,1,'word'.split(',')`]) {
    assert.throws(() => unpackPlayerScripts(`eval(function(p,a,c,k,e,d){return p;}(${args},0,{}))`), ProviderError);
  }
});

test('Streamtape string expressions support parentheses and chained substring without running code', () => {
  const expression = `'//streamtape.' + ('xcdcom/get_video?id=Fixture12345&token=one%2Btwo').substring(1).substring(2);`;
  assert.equal(readPlayerStringExpression(expression), '//streamtape.com/get_video?id=Fixture12345&token=one%2Btwo');
  assert.equal(readPlayerStringExpression(`('abcdef'.substr(1,3) + 'gh'.slice(1))`), 'bcdh');
  for (const value of [`'one'+getCookie()`, `'one'.constructor('return 1')()`, `'one'.repeat(100)`, `'x'; execute()`, '((']) {
    assert.throws(() => readPlayerStringExpression(value), ProviderError);
  }
});
