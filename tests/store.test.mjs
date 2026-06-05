import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { buildMarkdownStructureRecords, buildSourceDocument } from '../src/core/source-doc.mjs';
import { IftreeStore } from '../src/backend/store.mjs';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-store-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('creates a document with one root node and computed address', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: '需求总目标' });
    const loaded = store.getDoc(doc.id);

    assert.equal(loaded.doc.title, 'Demo');
    assert.equal(loaded.tree.text, '需求总目标');
    assert.equal(loaded.tree.address, '1');
    assert.deepEqual(loaded.tree.children, []);
  });
});

test('organizes documents in nested folders without changing document nodes', async () => {
  await withStore(async (store) => {
    const folder = store.createDocFolder({ name: 'Folder A' });
    const nested = store.createDocFolder({ name: 'Nested', parentId: folder.id });
    const doc = store.createDoc({ title: 'Foldered Doc', rootText: 'Root', folderId: nested.id });

    let loaded = store.getDoc(doc.id);
    assert.equal(loaded.tree.text, 'Root');
    assert.equal(loaded.tree.address, '1');
    assert.equal(loaded.tree.children.length, 0);

    assert.deepEqual(store.listDocFolders().map(({ id, parent_id, name }) => ({ id, parent_id, name })), [
      { id: folder.id, parent_id: null, name: 'Folder A' },
      { id: nested.id, parent_id: folder.id, name: 'Nested' }
    ]);
    assert.equal(store.listDocs().find((item) => item.id === doc.id).folder_id, nested.id);

    assert.throws(() => store.deleteDocFolder(folder.id), /not empty|non-empty|非空/);

    assert.equal(store.moveDocToFolder({ docId: doc.id, folderId: null }), true);
    assert.equal(store.listDocs().find((item) => item.id === doc.id).folder_id, null);
    loaded = store.getDoc(doc.id);
    assert.equal(loaded.tree.text, 'Root');
    assert.equal(loaded.tree.address, '1');
  });
});

test('normalizes document folder names when creating and renaming', async () => {
  await withStore(async (store) => {
    const emptyNamed = store.createDocFolder({ name: '' });
    assert.equal(emptyNamed.name, '新建文件夹');

    const whitespaceNamed = store.updateDocFolder(emptyNamed.id, { name: '   ' });
    assert.equal(whitespaceNamed.name, '新建文件夹');

    const longName = '甲'.repeat(120);
    const renamed = store.updateDocFolder(emptyNamed.id, { name: longName });
    assert.equal(Array.from(renamed.name).length, 100);
    assert.equal(renamed.name, '甲'.repeat(100));

    store.db.prepare('INSERT INTO doc_folders (name, sort_order) VALUES (?, ?)').run('   ', 99);
    store.migrateData();
    const migrated = store.listDocFolders().find((folder) => folder.sort_order === 99);
    assert.equal(migrated.name, '新建文件夹');
  });
});

test('inserts, updates, and deletes nodes while preserving sibling addresses', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: '根' });
    const first = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '第一句。', nodeType: 'IF' });
    const second = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '第二句。', nodeType: 'ELSE' });
    const child = store.insertNode({ docId: doc.id, parentId: second.id, text: '子句。' });

    store.updateNode(first.id, { text: '第一句 updated。', nodeType: 'LOOP' });
    let loaded = store.getDoc(doc.id);

    assert.equal(loaded.tree.children[0].address, '1-1');
    assert.equal(loaded.tree.children[0].nodeType, 'LOOP');
    assert.equal(loaded.tree.children[1].address, '1-2');
    assert.equal(loaded.tree.children[1].children[0].address, '1-2-1');

    store.deleteNodeSubtree(second.id);
    loaded = store.getDoc(doc.id);

    assert.equal(loaded.tree.children.length, 1);
    assert.equal(loaded.tree.children[0].id, first.id);
    assert.equal(typeof child.id, 'string');
    assert.equal(child.id.length > 0, true);
  });
});

test('updateNode can clear nullable node labels back to unmarked', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Nullable Demo', rootText: 'Root' });
    const node = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Labelled' });

    store.updateNode(node.id, {
      trust_level: '受控',
      nodeType: 'HUMAN_BLOCK',
      source_position: 12.5
    });
    let loaded = store.getDoc(doc.id).tree.children[0];
    assert.equal(loaded.trustLevel, '受控');
    assert.equal(loaded.nodeType, 'HUMAN_BLOCK');
    assert.equal(loaded.sourcePosition, 12.5);

    store.updateNode(node.id, {
      trustLevel: null,
      nodeType: 'TEXT',
      sourcePosition: null
    });
    loaded = store.getDoc(doc.id).tree.children[0];
    assert.equal(loaded.trustLevel, null);
    assert.equal(loaded.nodeType, 'TEXT');
    assert.equal(loaded.sourcePosition, null);
  });
});


test('creates imported sentence documents with an import chapter', async () => {
  await withStore(async (store) => {
    const doc = store.createDocFromSentences({
      title: '合成样本',
      sourcePath: 'fixtures/sample-sentences.xlsx',
      sentences: ['第一句。', '第二句。']
    });

    const loaded = store.getDoc(doc.id);

    assert.equal(loaded.tree.text, '合成样本');
    assert.equal(loaded.tree.children[0].text, '原始文本导入');
    assert.equal(loaded.tree.children[0].children[0].address, '1-1-1');
    assert.equal(loaded.tree.children[0].children[1].text, '第二句。');
  });
});

test('stores markdown hierarchy metadata and maps sentence spans by explicit indexes', async () => {
  await withStore(async (store) => {
    const source = buildSourceDocument({
      sourcePath: 'sample.md',
      sourceType: 'md',
      rawMarkdown: '# Chapter\n\nFirst sentence. Second sentence!'
    });
    const records = buildMarkdownStructureRecords(source);
    const doc = store.createDocFromStructuredRecords({
      title: 'Markdown',
      sourcePath: 'sample.md',
      records
    });

    const nodeIdsBySentenceIndex = new Map();
    for (const record of records) {
      if (record.index == null) continue;
      nodeIdsBySentenceIndex.set(record.index, doc.importedNodeIdsByRecordIndex[record.index]);
    }
    store.saveSourceDocument({
      docId: doc.id,
      sourcePath: source.sourcePath,
      sourceType: source.sourceType,
      rawMarkdown: source.rawMarkdown,
      spans: source.spans,
      nodeIdsBySentenceIndex
    });

    const loaded = store.getDoc(doc.id);
    const chapter = loaded.tree.children[0];
    const paragraph = chapter.children[0];
    const firstSentence = paragraph.children[0];
    const secondSentence = paragraph.children[1];

    assert.equal(chapter.text, 'Chapter');
    assert.equal(chapter.sourcePosition, 1);
    assert.equal(paragraph.text, '');
    assert.equal(paragraph.title, '');
    assert.equal(paragraph.sourcePosition, 1.5);
    assert.equal(firstSentence.text, 'First sentence.');
    assert.equal(secondSentence.text, 'Second sentence!');
    assert.deepEqual(loaded.sourceSpans.map((span) => span.node_address), [
      chapter.address,
      firstSentence.address,
      secondSentence.address
    ]);

    store.updateNode(paragraph.id, { nodeTitle: '段落备注' });
    assert.equal(store.getDoc(doc.id).tree.children[0].children[0].title, '段落备注');
  });
});

test('stores source markdown spans and resolves current node addresses', async () => {
  await withStore(async (store) => {
    const doc = store.createDocFromSentenceRecords({
      title: 'Source',
      sourcePath: 'sample.md',
      records: [
        { index: 1, text: 'First sentence.', vector: null },
        { index: 2, text: 'Second sentence!', vector: null }
      ]
    });

    store.saveSourceDocument({
      docId: doc.id,
      sourcePath: 'sample.md',
      sourceType: 'md',
      rawMarkdown: 'First sentence. Second sentence!',
      spans: [
        { sentence_index: 1, start_offset: 0, end_offset: 15, text: 'First sentence.' },
        { sentence_index: 2, start_offset: 16, end_offset: 32, text: 'Second sentence!' }
      ],
      nodeIdsBySentenceIndex: new Map([
        [1, doc.importedNodeIds[0]],
        [2, doc.importedNodeIds[1]]
      ])
    });

    let loaded = store.getDoc(doc.id);
    assert.equal(loaded.sourceDocument.raw_markdown, 'First sentence. Second sentence!');
    assert.deepEqual(loaded.sourceSpans.map((span) => span.node_address), ['1-1-1', '1-1-2']);

    store.moveNodeBeforeSibling({ nodeId: doc.importedNodeIds[1], targetNodeId: doc.importedNodeIds[0] });
    loaded = store.getDoc(doc.id);
    assert.deepEqual(loaded.sourceSpans.map((span) => span.node_address), ['1-1-2', '1-1-1']);
  });
});

test('moves source markdown span mapping when nodes are merged', async () => {
  await withStore(async (store) => {
    const doc = store.createDocFromSentenceRecords({
      title: 'Source',
      sourcePath: 'sample.md',
      records: [
        { index: 1, text: 'First sentence.', vector: null },
        { index: 2, text: 'Second sentence!', vector: null }
      ]
    });

    store.saveSourceDocument({
      docId: doc.id,
      sourcePath: 'sample.md',
      sourceType: 'md',
      rawMarkdown: 'First sentence. Second sentence!',
      spans: [
        { sentence_index: 1, start_offset: 0, end_offset: 15, text: 'First sentence.' },
        { sentence_index: 2, start_offset: 16, end_offset: 32, text: 'Second sentence!' }
      ],
      nodeIdsBySentenceIndex: new Map([
        [1, doc.importedNodeIds[0]],
        [2, doc.importedNodeIds[1]]
      ])
    });

    assert.equal(store.mergeNodeIntoPreviousSibling(doc.importedNodeIds[1]), true);
    const loaded = store.getDoc(doc.id);

    assert.deepEqual(loaded.sourceSpans.map((span) => span.node_id), [
      doc.importedNodeIds[0],
      doc.importedNodeIds[0]
    ]);
    assert.deepEqual(loaded.sourceSpans.map((span) => span.node_address), ['1-1-1', '1-1-1']);
  });
});

test('merges node titles and notes without dropping either side', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: 'Root' });
    const first = store.insertNode({
      docId: doc.id,
      parentId: doc.rootNodeId,
      text: 'First.',
      nodeTitle: 'First title'
    });
    const second = store.insertNode({
      docId: doc.id,
      parentId: doc.rootNodeId,
      text: 'Second.',
      nodeTitle: 'Second title'
    });

    store.updateNode(first.id, { nodeNote: 'First note' });
    store.updateNode(second.id, { nodeNote: 'Second note' });

    assert.equal(store.mergeNodeIntoPreviousSibling(second.id), true);

    const merged = store.getDoc(doc.id).tree.children[0];
    assert.equal(merged.text, 'First.\n\nSecond.');
    assert.equal(merged.title, 'First title\n\nSecond title');
    assert.equal(merged.note, 'First note\n\nSecond note');
  });
});

test('updates axioms associated with a document', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: '根' });

    const axiom = store.addAxiom({ docId: doc.id, content: '本地运行环境可信', status: 'pending' });
    store.updateAxiom(axiom.id, { status: 'confirmed' });

    const loaded = store.getDoc(doc.id);

    assert.equal(loaded.axioms[0].label, 'A1');
    assert.equal(loaded.axioms[0].status, 'confirmed');
  });
});

test('listDocs reports node counts without join duplication', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: '根' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '第一句。' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '第二句。' });

    const listed = store.listDocs().find((item) => item.id === doc.id);

    assert.equal(listed.node_count, 3);
  });
});

test('deletes a document and its document-scoped records', async () => {
  await withStore(async (store) => {
    const first = store.createDoc({ title: 'First', rootText: 'Root A' });
    const second = store.createDoc({ title: 'Second', rootText: 'Root B' });
    const firstChild = store.insertNode({ docId: first.id, parentId: first.rootNodeId, text: 'Child A' });
    const firstTarget = store.insertNode({ docId: first.id, parentId: first.rootNodeId, text: 'Target A' });
    store.addNodeRefToNode({
      docId: first.id,
      sourceNodeId: firstChild.id,
      targetNodeId: firstTarget.id,
      refKind: 'relates',
      note: 'internal reference'
    });
    store.addAxiom({ docId: first.id, content: 'Axiom A', status: 'pending' });
    store.saveHistorySnapshot({ docId: first.id, summary: 'Snapshot A' });

    assert.equal(store.deleteDoc(first.id), true);

    assert.equal(store.getDoc(first.id), null);
    assert.equal(store.getDoc(second.id).doc.title, 'Second');
    const remainingIds = store.listDocs().map((doc) => doc.id);
    assert.equal(remainingIds.includes(first.id), false);
    assert.equal(remainingIds.includes(second.id), true);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE doc_id = ?').get(first.id).count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM axioms WHERE doc_id = ?').get(first.id).count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM save_history WHERE doc_id = ?').get(first.id).count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM refs').get().count, 0);
    assert.equal(store.deleteDoc(first.id), false);
  });
});

test('splits a node into parent text plus child sentence nodes', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: 'Root' });
    const node = store.insertNode({
      docId: doc.id,
      parentId: doc.rootNodeId,
      text: 'First sentence. Second sentence! Third sentence?'
    });
    const existingChild = store.insertNode({ docId: doc.id, parentId: node.id, text: 'Existing child.' });

    const ok = store.splitNodeIntoChildren(node.id);
    const loaded = store.getDoc(doc.id);
    const split = loaded.tree.children[0];

    assert.equal(ok, true);
    assert.equal(split.text, 'First sentence.');
    assert.equal(split.children.length, 3);
    assert.equal(split.children[0].text, 'Second sentence!');
    assert.equal(split.children[0].address, '1-1-1');
    assert.equal(split.children[1].text, 'Third sentence?');
    assert.equal(split.children[2].id, existingChild.id);
    assert.equal(split.children[2].address, '1-1-3');
  });
});

test('merges a node into its previous sibling and preserves moved children', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: 'Root' });
    const first = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'First.' });
    const second = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Second.' });
    const child = store.insertNode({ docId: doc.id, parentId: second.id, text: 'Second child.' });
    const third = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Third.' });

    const ok = store.mergeNodeIntoPreviousSibling(second.id);
    const loaded = store.getDoc(doc.id);

    assert.equal(ok, true);
    assert.equal(loaded.tree.children.length, 2);
    assert.equal(loaded.tree.children[0].id, first.id);
    assert.equal(loaded.tree.children[0].text, 'First.\n\nSecond.');
    assert.equal(loaded.tree.children[0].children[0].id, child.id);
    assert.equal(loaded.tree.children[0].children[0].address, '1-1-1');
    assert.equal(loaded.tree.children[1].id, third.id);
    assert.equal(loaded.tree.children[1].address, '1-2');
  });
});

test('promotes nodes without persisting addresses', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: 'Root' });
    const parent = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Parent.' });
    const first = store.insertNode({ docId: doc.id, parentId: parent.id, text: 'First child.' });
    const second = store.insertNode({ docId: doc.id, parentId: parent.id, text: 'Second child.' });

    assert.equal(store.promoteNode(second.id), true);
    const loaded = store.getDoc(doc.id);
    assert.equal(loaded.tree.children[0].id, parent.id);
    assert.equal(loaded.tree.children[0].children[0].id, first.id);
    assert.equal(loaded.tree.children[1].id, second.id);
    assert.equal(loaded.tree.children[1].address, '1-2');
  });
});

test('adds and deletes node references resolved by stable ids', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: 'Root' });
    const source = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Source.' });
    const target = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Target.' });

    const ref = store.addNodeRefToNode({
      docId: doc.id,
      sourceNodeId: source.id,
      targetNodeId: target.id,
      refKind: 'depends',
      note: 'source depends on target'
    });
    let loaded = store.getDoc(doc.id);

    assert.equal(typeof ref.id, 'string');
    assert.equal(ref.id.length > 0, true);
    assert.equal(loaded.refs.length, 1);
    assert.equal(loaded.refs[0].source_address, '1-1');
    assert.equal(loaded.refs[0].target_address, '1-2');
    assert.equal(loaded.refs[0].ref_kind, 'depends');

    store.deleteRef(ref.id);
    loaded = store.getDoc(doc.id);
    assert.equal(loaded.refs.length, 0);
  });
});

test('saves document snapshots and restores an earlier history entry', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: 'Root' });
    const first = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'First.' });
    const history = store.saveHistorySnapshot({ docId: doc.id, summary: 'initial version' });

    store.updateNode(first.id, { text: 'Changed.' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Second.' });
    assert.equal(store.listHistory(doc.id).length, 1);

    store.restoreHistory(history.id);
    const restored = store.getDoc(doc.id);

    assert.equal(restored.tree.children.length, 1);
    assert.equal(restored.tree.children[0].text, 'First.');
    assert.equal(store.listHistory(doc.id)[0].summary, 'initial version');
  });
});

test('moves a node under a new parent for drag-and-drop reparenting', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: 'Root' });
    const first = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'First.' });
    const second = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Second.' });
    const child = store.insertNode({ docId: doc.id, parentId: second.id, text: 'Child.' });

    assert.equal(store.moveNodeToParent({ nodeId: first.id, newParentId: second.id }), true);
    const loaded = store.getDoc(doc.id);

    assert.equal(loaded.tree.children.length, 1);
    assert.equal(loaded.tree.children[0].id, second.id);
    assert.equal(loaded.tree.children[0].children[0].id, child.id);
    assert.equal(loaded.tree.children[0].children[1].id, first.id);
    assert.equal(loaded.tree.children[0].children[1].address, '1-1-2');
  });
});

test('moves a node after a target sibling for drag-and-drop ordering', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: 'Root' });
    const first = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'First.' });
    const second = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Second.' });
    const third = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Third.' });

    assert.equal(store.moveNodeAfterSibling({ nodeId: first.id, targetNodeId: third.id }), true);
    const loaded = store.getDoc(doc.id);

    assert.deepEqual(loaded.tree.children.map((node) => node.id), [second.id, third.id, first.id]);
    assert.deepEqual(loaded.tree.children.map((node) => node.address), ['1-1', '1-2', '1-3']);
  });
});

test('moves a node before a target sibling for drag-and-drop ordering', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: 'Root' });
    const first = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'First.' });
    const second = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Second.' });
    const third = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Third.' });

    assert.equal(store.moveNodeBeforeSibling({ nodeId: second.id, targetNodeId: first.id }), true);
    const loaded = store.getDoc(doc.id);

    assert.deepEqual(loaded.tree.children.map((node) => node.id), [second.id, first.id, third.id]);
    assert.deepEqual(loaded.tree.children.map((node) => node.address), ['1-1', '1-2', '1-3']);
  });
});

test('merges a node into a selected target and preserves moved children', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: 'Root' });
    const target = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Target.' });
    const source = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Source.' });
    const child = store.insertNode({ docId: doc.id, parentId: source.id, text: 'Source child.' });
    const third = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'Third.' });

    assert.equal(store.mergeNodeIntoTarget({ nodeId: source.id, targetNodeId: target.id }), true);
    const loaded = store.getDoc(doc.id);

    assert.deepEqual(loaded.tree.children.map((node) => node.id), [target.id, third.id]);
    assert.equal(loaded.tree.children[0].text, 'Target.\n\nSource.');
    assert.equal(loaded.tree.children[0].children[0].id, child.id);
    assert.equal(loaded.tree.children[0].children[0].address, '1-1-1');
    assert.equal(loaded.tree.children[1].address, '1-2');
  });
});
