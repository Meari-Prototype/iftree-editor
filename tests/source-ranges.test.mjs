import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSentenceIndexes } from '../src/core/source-ranges.mjs';

test('formatSentenceIndexes compresses contiguous and discontinuous sentence indexes', () => {
  assert.equal(formatSentenceIndexes([23, 24, 25, 27, 28, 32]), '23-25;27-28;32');
  assert.equal(formatSentenceIndexes([32, 23, 24, 24, 25, 27]), '23-25;27;32');
  assert.equal(formatSentenceIndexes([35.5, 36, 37, 39]), '35.5;36-37;39');
});
