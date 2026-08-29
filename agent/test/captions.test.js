'use strict';

/**
 * Subtitle tidying.
 *
 * The cases below are lines YouTube actually produces on music videos, in the
 * languages this app is translated into and in a few it is not — the point of
 * matching the bracket rather than the word is that the untranslated ones have
 * to work too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanCaption, isNoiseOnly } = require('../src/lyrics/captions');

test('a line that is only a sound event comes back empty', () => {
  for (const line of [
    '[Musik]',
    '[Music]',
    '[Applaus]',
    '[Applause]',
    '[Gelächter]',
    '[Aplausos]',
    '[музыка]',
    '[音楽]',
    '[Muzyka]',
    '[Musik] [Musik]',
    '  [Musik]  ',
    '♪♪♪',
    '♪',
  ]) {
    assert.equal(cleanCaption(line), '', `nicht geleert: ${line}`);
    assert.equal(isNoiseOnly(line), true, `nicht als Geräusch erkannt: ${line}`);
  }
});

test('the words survive when a marker sits beside them', () => {
  assert.equal(cleanCaption('[Musik] Never gonna give you up'), 'Never gonna give you up');
  assert.equal(cleanCaption('Never gonna give you up [Applaus]'), 'Never gonna give you up');
  assert.equal(cleanCaption('♪ Never gonna give you up ♪'), 'Never gonna give you up');
  assert.equal(cleanCaption('>> Never gonna give you up'), 'Never gonna give you up');
});

test('parentheses are left alone, because songs use them', () => {
  // Backing vocals are part of the lyric. Losing them would be the worse error.
  assert.equal(cleanCaption('Never gonna give you up (ooh, ooh)'), 'Never gonna give you up (ooh, ooh)');
  assert.equal(cleanCaption('(Musik)'), '(Musik)');
});

test('an ordinary line is returned untouched', () => {
  const line = 'We are no strangers to love';
  assert.equal(cleanCaption(line), line);
  assert.equal(isNoiseOnly(line), false);
});

test('leftover punctuation does not count as a line', () => {
  // "[Musik] -" and "[Musik]..." both occur; neither is worth showing.
  assert.equal(cleanCaption('[Musik] -'), '');
  assert.equal(cleanCaption('[Musik]...'), '');
  assert.equal(cleanCaption('- [Musik] -'), '');
});

test('nothing in, nothing out', () => {
  for (const value of ['', '   ', null, undefined]) {
    assert.equal(cleanCaption(value), '');
    assert.equal(isNoiseOnly(value), false);
  }
});

test('an unclosed bracket does not eat the line', () => {
  // Captions arrive mid-render, so half a marker is a real state.
  assert.equal(cleanCaption('[Musik Never gonna give you up'), '[Musik Never gonna give you up');
});
