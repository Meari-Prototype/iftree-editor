import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendGeneratedNote,
  hasGeneratedNote,
  mergeNodeNotes,
  parseNodeNote,
  plainNodeNote
} from '../src/core/node-notes.mjs';

test('generated node notes are stored in one field and parsed into display segments', () => {
  const note = appendGeneratedNote('Manual note', 'AI summary');

  assert.deepEqual(parseNodeNote(note), [
    { text: 'Manual note', generated: false },
    { text: 'AI summary', generated: true }
  ]);
  assert.equal(plainNodeNote(note), 'Manual note\n\nAI summary');
  assert.equal(hasGeneratedNote(note), true);
});

test('manual edits can strip generated markers back to normal text', () => {
  const note = appendGeneratedNote('', 'AI summary');

  assert.deepEqual(parseNodeNote(plainNodeNote(note)), [
    { text: 'AI summary', generated: false }
  ]);
  assert.equal(hasGeneratedNote(plainNodeNote(note)), false);
});

test('node note merge appends without dropping generated segments', () => {
  const generated = appendGeneratedNote('Target note', 'Target AI');
  const merged = mergeNodeNotes(generated, 'Source note');

  assert.deepEqual(parseNodeNote(merged), [
    { text: 'Target note', generated: false },
    { text: 'Target AI', generated: true },
    { text: 'Source note', generated: false }
  ]);
});
