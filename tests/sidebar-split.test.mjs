import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { clampVerticalSplitSize } from '../src/core/sidebar-split.mjs';

test('clampVerticalSplitSize resizes a vertical split and preserves both panel minimums', () => {
  assert.equal(clampVerticalSplitSize({
    startSize: 180,
    startY: 100,
    currentY: 140,
    availableSize: 500,
    minTop: 96,
    minBottom: 150
  }), 220);

  assert.equal(clampVerticalSplitSize({
    startSize: 180,
    startY: 100,
    currentY: 0,
    availableSize: 500,
    minTop: 96,
    minBottom: 150
  }), 96);

  assert.equal(clampVerticalSplitSize({
    startSize: 180,
    startY: 100,
    currentY: 600,
    availableSize: 500,
    minTop: 96,
    minBottom: 150
  }), 350);
});
