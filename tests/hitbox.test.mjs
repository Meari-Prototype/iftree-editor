import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { measuredNodeHeightFromElement } from '../src/core/hitbox.mjs';

test('measuredNodeHeightFromElement ignores transformed screen height', () => {
  const element = {
    scrollHeight: 120,
    getBoundingClientRect() {
      return { height: 480 };
    }
  };

  assert.equal(measuredNodeHeightFromElement(element), 152);
});
