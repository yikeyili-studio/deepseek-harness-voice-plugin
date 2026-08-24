import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeReadableText,
  voiceButtonId,
} from '../src/client-core.js';

test('normalizes readable response text without changing punctuation', () => {
  assert.equal(
    normalizeReadableText(' 第一段。\n\n  第二段！ '),
    '第一段。 第二段！',
  );
});

test('creates a stable safe id for each assistant message key', () => {
  const first = voiceButtonId('turn:1/step:2');
  assert.equal(first, voiceButtonId('turn:1/step:2'));
  assert.notEqual(first, voiceButtonId('turn:1/step:3'));
  assert.match(first, /^dsh-edge-read-[a-z0-9]+$/);
});
