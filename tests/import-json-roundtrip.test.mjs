import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../dist/src/backend/store/index.js';
import { runDatabaseWrite } from '../dist/src/backend/mutation-api.js';
import { runDatabaseRead } from '../dist/src/backend/query-api.js';
import { runImportJson } from '../dist/src/backend/import/import-json.js';
import { matchImportedDocForSourcePaths } from '../dist/src/backend/import/import-service.js';

// import-json 的正式入库路径（非 dry-run）端到端：这条路以前必定失败——runImportJson 调 stream.push
// 不带 docId，撞上首推新建守卫（新建文档无源文件锚、library_index 不可见），只有 --dry-run 能走通。
// 现在它自己先 doc.create 再往该 docId 推。本测试钉死改法的三个要害：
//   1. 地址零偏移——顶层落在新建根（address '1'）下，原样是 1-1、1-2…，句位↔节点映射不整体错一级；
//   2. 源文档层与源路径锚都落库——source_documents 有行、meta.sourcePath 写上，library_index 认得出、查重拦得住；
//   3. 失败回滚——doc.create 之后任何一步炸都不留半成品。

const SOURCE_TEXT = [
  '第一章 开端',
  '这是第一章的第一段。',
  '这是第一章的第二段。',
  '第二章 后续',
  '这是第二章的唯一一段。'
].join('\n\n');

// 与源文逐字节对应的节点树：章节标题作 text 节点、段落作它的子节点（智能导入 skill 的产物形态）。
// 不带 address（由 fillMissingAddresses 按 children 前序补），也不开 splitSentences——
// 本测试要钉的是地址与锚，不是切句子。
const TREE = {
  title: '导入样例',
  nodes: [
    {
      text: '第一章 开端',
      trustLevel: '不受控',
      children: [
        { text: '这是第一章的第一段。', trustLevel: '不受控' },
        { text: '这是第一章的第二段。', trustLevel: '不受控' }
      ]
    },
    {
      text: '第二章 后续',
      trustLevel: '不受控',
      children: [
        { text: '这是第二章的唯一一段。', trustLevel: '不受控' }
      ]
    }
  ]
};

async function withFixture(fn, { onWrite } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-import-json-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  const sourcePath = join(dir, '导入样例.md');
  const jsonPath = join(dir, 'tree.json');
  // 派生索引模块在单测里不装配：maintainDerivedAfterWrite 只记账，落库本身不依赖它。
  const maintained = [];
  const ctx = { maintainDerivedAfterWrite: (docId, options) => { maintained.push([String(docId), options || {}]); } };
  // runImportJson 只认 db 契约（run(request, role)）——这里把它接到真的读写 API 上，
  // 与无头后端同一条通路，不另造 mock store。
  const database = {
    async run(request, role) {
      if (role === 'read') return runDatabaseRead(store, request.payload, {});
      if (onWrite) await onWrite(request.payload);
      return runDatabaseWrite(store, request.payload, ctx);
    }
  };
  try {
    store.init();
    await writeFile(sourcePath, SOURCE_TEXT, 'utf8');
    await writeFile(jsonPath, JSON.stringify(TREE), 'utf8');
    await fn({ store, database, sourcePath, jsonPath, maintained });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const nodesByAddress = (store, docId) => new Map(
  store.db.prepare('SELECT address, id, text, source_position FROM nodes WHERE doc_id = ? ORDER BY address').all(docId)
    .map((row) => [row.address, row])
);

test('import-json 正式入库：落库 + 地址零偏移 + 源文档层 + library 可见', async () => {
  await withFixture(async ({ store, database, sourcePath, jsonPath }) => {
    const result = await runImportJson({ database, jsonPath, sourcePath });

    assert.equal(result.ok, true, `校验应通过：${JSON.stringify(result.errors || [])}`);
    assert.equal(result.imported, true, '正式路径必须真的入库（以前会被首推守卫拒掉）');
    const docId = String(result.docId);

    // --- 地址零偏移：树里不含根，顶层就该是 1-1 / 1-2，不能因为多挂一层而整体变成 1-1-1… ---
    const byAddress = nodesByAddress(store, docId);
    assert.deepEqual(
      [...byAddress.keys()].sort(),
      ['1', '1-1', '1-1-1', '1-1-2', '1-2', '1-2-1'],
      '地址集合必须与 JSON 树前序一一对应（多/少一级即为挂载点错位）'
    );
    assert.equal(byAddress.get('1').text, '导入样例', '根节点由 doc.create 建、正文取 title');
    assert.equal(byAddress.get('1-1').text, '第一章 开端');
    assert.equal(byAddress.get('1-1-2').text, '这是第一章的第二段。');
    assert.equal(byAddress.get('1-2-1').text, '这是第二章的唯一一段。');

    // --- 源文档层：原文 + 句位 span + 句位↔节点绑定 ---
    const source = store.db.prepare('SELECT original_path, source_type, raw_markdown FROM source_documents WHERE doc_id = ?').get(docId);
    assert.ok(source, 'source_documents 必须有行（attachSource 落库）');
    assert.equal(source.original_path, sourcePath);
    assert.equal(source.source_type, 'md');
    assert.equal(source.raw_markdown, SOURCE_TEXT, '原文逐字节存档');

    const spans = store.db.prepare('SELECT sentence_index, node_id, start_offset, end_offset, text FROM source_spans WHERE doc_id = ? ORDER BY sentence_index').all(docId);
    assert.equal(spans.length, result.spanCount);
    assert.equal(spans.length, 5, '5 个正文节点各锚一个句位');
    // 每个 span 都绑到了节点，且该节点正文 = 源文对应切片。地址若整体偏一级，这里就会绑错/绑空。
    for (const span of spans) {
      assert.ok(span.node_id, `句位 ${span.sentence_index} 必须绑到节点`);
      const node = store.db.prepare('SELECT text FROM nodes WHERE id = ?').get(span.node_id);
      assert.equal(node.text, SOURCE_TEXT.slice(span.start_offset, span.end_offset), `句位 ${span.sentence_index} 的节点正文应等于源文切片`);
      assert.equal(span.text, node.text);
    }

    // --- library_index 可见 / 源路径查重的依据：meta.sourcePath 与 original_path 双锚 ---
    const doc = store.db.prepare('SELECT title, meta, edit_mode FROM docs WHERE id = ?').get(docId);
    assert.equal(doc.title, '导入样例');
    const meta = JSON.parse(doc.meta);
    assert.equal(meta.sourcePath, sourcePath, 'meta.sourcePath 是 library_index 匹配文件↔文档的键');
    assert.ok(meta.importedAt, '与普通导入同构：要有 importedAt');
    // 用与 library/查重同一个纯函数反查：按源路径能认出这篇 = library_index 会把该文件标成已导入。
    const rows = store.db.prepare(`
      SELECT docs.id, docs.title, docs.meta, docs.created_at, docs.updated_at, source_documents.original_path
      FROM docs LEFT JOIN source_documents ON source_documents.doc_id = docs.id
    `).all();
    assert.equal(matchImportedDocForSourcePaths(rows, [sourcePath])?.id, docId, '按源路径必须能反查到这篇文档');

    // --- 编辑档与基线 commit ---
    assert.equal(doc.edit_mode, 'full', 'incremental 只是 push 的通行证，推完要切回 full（产物应可正常编辑）');
    // 唯一的 commit 建在 attachSource 之后：doc.create 传了 skipInitialCommit，历史里不留那条
    // 「空文章」初始版本——否则用户回退到初始版本等于把文章删空、连 source 行一起没掉。
    const commits = store.db.prepare('SELECT id, summary, author FROM commits WHERE doc_id = ?').all(docId);
    assert.equal(commits.length, 1, '历史里只该有一条 commit（没有可以把文章回退成空的那一版）');
    assert.equal(commits[0].summary, '导入');
    assert.equal(commits[0].author, 'import');
    const head = store.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(docId);
    assert.equal(head.head_commit_id, commits[0].id, 'head 应指向这条「导入」commit');
    // 这条 commit 建在源层落库之后，快照才含 sourceDocument——否则 restore 回它会把 source 行静默删掉。
    const snapshot = store.createSnapshot(docId);
    assert.ok(snapshot.sourceDocument, '基线快照必须含源文档层');
  });
});

test('import-json 正式入库：同一源文再导一次被查重拦下', async () => {
  await withFixture(async ({ database, sourcePath, jsonPath }) => {
    const first = await runImportJson({ database, jsonPath, sourcePath });
    assert.equal(first.imported, true);
    await assert.rejects(
      () => runImportJson({ database, jsonPath, sourcePath }),
      /导入失败：该真实文本路径已对应数据库文档/,
      '第二次导入同一源路径应报与普通导入同一条查重错误，不能再产一篇'
    );
  });
});

test('import-json 正式入库：attachSource 失败则整篇回滚，不留半成品', async () => {
  await withFixture(async ({ store, database, sourcePath, jsonPath }) => {
    await assert.rejects(
      () => runImportJson({ database, jsonPath, sourcePath }),
      /attachSource 炸了/
    );
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM docs').get().n, 0, '失败后不得留下残缺文档');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, 0, '节点也应随文档一并删除');
  }, {
    onWrite: async (payload) => {
      if (payload.action === 'stream.attachSource') throw new Error('attachSource 炸了');
    }
  });
});
