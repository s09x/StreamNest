import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio/slim';
import { domText } from '../src/native/dom-text.js';

test('iterative DOM text preserves decoded text, order, scripts and styles while ignoring comments', () => {
  const $ = load('<main>A &amp; B<span> Grüße <b>世界</b></span><!-- ignored --><script>code()</script><style>.x{}</style></main>');
  assert.equal(domText($('main').toArray()), 'A & B Grüße 世界code().x{}');
  assert.equal(domText($('span,script').toArray()), ' Grüße 世界code()');
  assert.equal(domText([]), '');
});

test('iterative DOM text includes XML CDATA contents', () => {
  const $ = load('<root>A<![CDATA[B & C]]><!-- ignored --><leaf> D</leaf></root>', { xmlMode: true });
  assert.equal(domText($('root').toArray()), 'AB & C D');
});

test('deeply nested HTML text does not consume a recursive JavaScript call stack', () => {
  const depth = 10_000;
  const $ = load('<main>Before' + '<div>'.repeat(depth) + 'Inside' + '</div>'.repeat(depth) + 'After</main>');
  assert.equal(domText($('main').toArray()), 'BeforeInsideAfter');
});
