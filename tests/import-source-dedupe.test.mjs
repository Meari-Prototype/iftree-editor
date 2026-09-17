import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  importedDocMetaPathLikePattern,
  matchImportedDocForSourcePaths
} from '../dist/src/backend/import/import-service.js';

// 源路径查重的判定口径：普通导入（importFilePathsToStore，走 store）与 import-json（走 db 契约的
// 只读 action）共用同一个纯函数，两条路径不得各写一套。这里钉死判定本身。

const samplePath = resolve('generated/查重样例.md');

function docRow(extra = {}) {
  return {
    id: 'doc-1',
    title: '查重样例',
    meta: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    original_path: null,
    ...extra
  };
}

test('source_documents.original_path 命中：大小写差异不影响（pathKey 规整后比较）', () => {
  const rows = [docRow({ original_path: samplePath.toUpperCase() })];
  assert.equal(matchImportedDocForSourcePaths(rows, [samplePath])?.id, 'doc-1');
});

test('meta.sourcePath 命中：直接导入（无 source 行）的文档同样算已导入', () => {
  const rows = [docRow({ id: 'doc-direct', meta: JSON.stringify({ sourcePath: samplePath, direct: true }) })];
  assert.equal(matchImportedDocForSourcePaths(rows, [samplePath])?.id, 'doc-direct');
});

test('没绑这条源路径的文档不算命中', () => {
  const rows = [
    docRow({ id: 'other', original_path: resolve('generated/别的文件.md') }),
    docRow({ id: 'no-source' })
  ];
  assert.equal(matchImportedDocForSourcePaths(rows, [samplePath]), null);
});

test('多个命中取 updated_at 最新（同时间按 id 倒序），结果稳定', () => {
  const rows = [
    docRow({ id: 'old', original_path: samplePath, updated_at: '2026-01-01T00:00:00Z' }),
    docRow({ id: 'new', original_path: samplePath, updated_at: '2026-06-01T00:00:00Z' })
  ];
  assert.equal(matchImportedDocForSourcePaths(rows, [samplePath])?.id, 'new');
});

test('meta LIKE 模式按 JSON 转义生成：能在 meta 的 JSON 文本里命中 Windows 路径', () => {
  const windowsPath = 'D:\\WorkSpace\\library\\a b.md';
  const pattern = importedDocMetaPathLikePattern(windowsPath);
  assert.equal(pattern.startsWith('%'), true);
  assert.equal(pattern.endsWith('%'), true);
  // 关键点：库里存的是 JSON 文本（反斜杠已转义），拿原始路径直接 LIKE 是匹配不上的。
  const metaText = JSON.stringify({ sourcePath: windowsPath });
  assert.ok(metaText.includes(pattern.slice(1, -1)), 'LIKE 模式应能在 meta JSON 文本里命中');
  assert.equal(metaText.includes(windowsPath), false, '未转义的原始路径不出现在 JSON 文本里');
});
