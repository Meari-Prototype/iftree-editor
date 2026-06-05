import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeXmlEntities, recordsFromPythonSource } from '../src/core/importers.mjs';

test('decodeXmlEntities decodes named, decimal, and hex entities', () => {
  assert.equal(decodeXmlEntities('# &#36861; &#x4E66; &amp; tree'), '# 追 书 & tree');
});

test('recordsFromPythonSource emits IDE-like fold blocks', () => {
  const records = recordsFromPythonSource(`
def main():
    if ok:
        print("ok")
    else:
        raise SystemExit("bad")

for item in items:
    continue
`);

  assert.deepEqual(records.map((record) => record.address), [
    '1',
    '1-1',
    '1-2',
    '2'
  ]);
  assert.deepEqual(records.map((record) => record.nodeType), [
    'TEXT',
    'IF',
    'ELSE',
    'FOREACH'
  ]);
  assert.equal(records[0].text, 'L2\ndef main():');
  assert.equal(records[1].text, 'L3-L4\nif ok:\n  print("ok")');
  assert.equal(records[2].text, 'L5-L6\nelse:\n  raise SystemExit("bad")');
  assert.equal(records[3].text, 'L8-L9\nfor item in items:\n  continue');
});

test('recordsFromPythonSource folds multiline docstrings into one node', () => {
  const records = recordsFromPythonSource(`
"""
用法：
  py script.py
"""
def main():
    return 1
`);

  assert.equal(records.length, 2);
  assert.equal(records[0].address, '1');
  assert.equal(records[0].text.startsWith('L2-L5\n"""'), true);
  assert.equal(records[1].address, '2');
  assert.equal(records[1].text.includes('return 1'), true);
});

test('recordsFromPythonSource groups imports and multiline literals', () => {
  const records = recordsFromPythonSource(`
import os
import sys

CONFIG = {
    "mode": "test",
    "retry": 2
}

def url(code):
    return (
        "https://example.test/"
        + code
    )
`);

  assert.deepEqual(records.map((record) => record.address), ['1', '2', '3']);
  assert.equal(records[0].text, 'L2-L3\nimport os\nimport sys');
  assert.equal(records[1].text, 'L5-L8\nCONFIG = {\n    "mode": "test",\n    "retry": 2\n}');
  assert.equal(records[2].text, 'L10-L14\ndef url(code):\n  return (\n      "https://example.test/"\n      + code\n  )');
});
