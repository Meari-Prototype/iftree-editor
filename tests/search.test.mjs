import test from 'node:test';
import assert from 'node:assert/strict';

import { buildKeywordSearchResults } from '../src/core/search.mjs';

const tree = {
  id: 1,
  address: '1',
  text: '示例文档',
  children: [
    {
      id: 2,
      address: '1-1',
      text: '调查员找到一本日记。',
      children: [
        {
          id: 3,
          address: '1-1-1',
          text: '日记里记录调查员调查书籍的线索，调查员再次确认。',
          children: []
        }
      ]
    },
    {
      id: 4,
      address: '1-2',
      text: '这里只提到另一个角色。',
      children: []
    }
  ]
};

test('buildKeywordSearchResults finds nodes by text keyword and ranks by hit count', () => {
  const results = buildKeywordSearchResults({ tree, query: '调查员' });

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((result) => result.address), ['1-1-1', '1-1']);
  assert.equal(results[0].score, 2);
});

test('buildKeywordSearchResults requires every query term to match the node text', () => {
  const results = buildKeywordSearchResults({ tree, query: '调查员 日记' });

  assert.deepEqual(results.map((result) => result.address), ['1-1-1', '1-1']);
});

test('buildKeywordSearchResults does not bubble child matches into parent nodes', () => {
  const results = buildKeywordSearchResults({ tree, query: '书籍' });

  assert.deepEqual(results.map((result) => result.address), ['1-1-1']);
});
