import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readSentences } from '../src/core/source-text.mjs';
import { IftreeStore } from '../src/backend/store.mjs';
import { flattenTree, findNode } from '../src/core/tree.mjs';

// --- helpers ---

function tempStore() {
  const dir = join(tmpdir(), `iftree-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dbPath = join(dir, 'store.sqlite');
  rmSync(dbPath, { force: true });
  const store = new IftreeStore(dbPath);
  store.init();
  return { store, dbPath };
}

// ====== 1. Document CRUD (simulates UI's createDoc) ======

test('创建文档 → 列出 → 打开 → 节点操作', () => {
  const { store } = tempStore();
  try {
    // create multiple docs
    const d1 = store.createDoc({ title: '测试文档A', rootText: '根节点文本A' });
    store.createDoc({ title: '测试文档B', rootText: '根节点文本B' });

    const list = store.listDocs();
    assert.equal(list.length, 2, '应有2个文档');
    assert.equal(list[0].title, '测试文档B', '最新文档排在前面');
    assert.equal(list[0].node_count, 1, '根节点算1个节点');

    // open doc
    const loaded = store.getDoc(d1.id);
    assert.ok(loaded.tree, 'buildTree 返回根节点');
    assert.equal(loaded.tree.text, '根节点文本A');
    assert.equal(loaded.tree.address, '1');

    // insert child
    const child = store.insertNode({
      docId: d1.id,
      parentId: d1.rootNodeId,
      text: '子节点',
      nodeType: 'IF'
    });
    assert.equal(child.node_type, 'IF');

    // verify in tree
    const reloaded = store.getDoc(d1.id);
    assert.equal(reloaded.tree.children.length, 1);
    assert.equal(reloaded.tree.children[0].text, '子节点');
    assert.equal(reloaded.tree.children[0].address, '1-1');

    // update node
    store.updateNode(child.id, { text: '更新后的子节点', node_type: 'ELSE' });
    const reloaded2 = store.getDoc(d1.id);
    assert.equal(reloaded2.tree.children[0].text, '更新后的子节点');
    assert.equal(reloaded2.tree.children[0].node_type, 'ELSE');

    // delete subtree
    store.insertNode({
      docId: d1.id,
      parentId: child.id,
      text: '孙子节点',
      nodeType: 'TEXT'
    });
    store.deleteNodeSubtree(child.id);
    const afterDelete = store.getDoc(d1.id);
    assert.equal(afterDelete.tree.children.length, 0, '子树删除后无子节点');
  } finally {
    store.close();
  }
});

// ====== 2. 信任级别 / 节点类型 CHECK 约束 ======

test('trust_level 和 node_type 约束', () => {
  const { store } = tempStore();
  try {
    const doc = store.createDoc({ title: '约束测试', rootText: '测试' });

    // valid values
    store.updateNode(doc.rootNodeId, { trust_level: '受控', node_type: '人工-阻塞' });
    let loaded = store.getDoc(doc.id);
    assert.equal(loaded.tree.trust_level, '受控');
    assert.equal(loaded.tree.nodeType, 'HUMAN_BLOCK');

    store.updateNode(doc.rootNodeId, { trust_level: '不受控', node_type: '人工-汇总' });
    loaded = store.getDoc(doc.id);
    assert.equal(loaded.tree.trust_level, '不受控');
    assert.equal(loaded.tree.nodeType, 'HUMAN_SUMMARY');

    // NULL / empty strings not settable via updateNode because ?? treats null as "not provided"
    // This is expected behavior — the API uses null as "don't change"
    console.log('  ✓ trust_level/node_type 有效值写入正常');
    console.log('  ⚠ CHECK 约束仅对新建数据库生效（SQLite 限制）');
    console.log('  ⚠ 通过 updateNode 传 null 视为"不修改此字段"');
  } finally {
    store.close();
  }
});

// ====== 3. 历史保存/恢复（增量 diff） ======

test('保存版本 → diff 格式 → 恢复', () => {
  const { store } = tempStore();
  try {
    const doc = store.createDoc({ title: '历史测试', rootText: '初始文本' });
    const child = store.insertNode({
      docId: doc.id,
      parentId: doc.rootNodeId,
      text: '第一节',
      nodeType: 'TEXT'
    });

    // first save
    const h1 = store.saveHistorySnapshot({ docId: doc.id, summary: '第一版' });
    assert.ok(h1.id);
    const payload1 = JSON.parse(store.db.prepare('SELECT diff FROM commits WHERE id = ?').get(h1.id).diff);
    assert.equal(payload1.kind, 'diff');
    assert.ok(Array.isArray(payload1.entries), 'diff entries 是数组');
    assert.ok(payload1.snapshot?.nodes, '包含完整快照用于恢复');

    // modify and save again
    store.updateNode(child.id, { text: '第一节（修改后）', node_type: 'IF' });
    const h2 = store.saveHistorySnapshot({ docId: doc.id, summary: '第二版' });
    const payload2 = JSON.parse(store.db.prepare('SELECT diff FROM commits WHERE id = ?').get(h2.id).diff);
    // second save should have diff entries (comparing with first save)
    const modEntry = payload2.entries.find(e => e.node_id === child.id && e.field === 'text');
    assert.ok(modEntry, '应有 text 修改的 diff 条目');
    assert.equal(modEntry.old, '第一节');
    assert.equal(modEntry.new, '第一节（修改后）');

    // restore to first version
    store.restoreCommit(h1.id);
    const restored = store.getDoc(doc.id);
    assert.equal(restored.tree.children[0].text, '第一节', '恢复后文本回到初始值');
    assert.equal(restored.tree.children[0].node_type, 'TEXT', '恢复后类型回到初始值');
  } finally {
    store.close();
  }
});

// ====== 4. 文本文件导入 ======

test('从临时文本导入合成文档并验证节点结构', async () => {
  const { store } = tempStore();
  const sourceDir = join(tmpdir(), `iftree-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    mkdirSync(sourceDir, { recursive: true });
    const txtFiles = [
      {
        file: 'sample-alpha.txt',
        text: '第一句用于验证导入。\n第二句用于验证节点结构。'
      },
      {
        file: 'sample-beta.txt',
        text: '如果入口条件成立，那么继续执行。\n否则记录原因并停止。'
      }
    ];
    for (const sample of txtFiles) {
      writeFileSync(join(sourceDir, sample.file), sample.text, 'utf8');
    }

    let totalNodes = 0;

    for (const sample of txtFiles) {
      const base = sample.file.replace(/\.txt$/i, '');
      const filePath = join(sourceDir, sample.file);

      const sentences = await readSentences(filePath);
      assert.ok(sentences.length > 0, `${sample.file} 有句子`);

      const doc = store.createDocFromSentences({
        title: base,
        sourcePath: filePath,
        sentences
      });

      const loaded = store.getDoc(doc.id);
      assert.ok(loaded.tree, '导入后 buildTree 成功');
      assert.ok(loaded.tree.children.length > 0, '有章节节点');
      assert.equal(loaded.tree.children[0].text, '原始文本导入', '章节命名为原始文本导入');

      const nodes = flattenTree(loaded.tree);
      assert.ok(nodes.length >= sentences.length, '节点数 >= 句子数');

      // verify addresses
      for (const node of nodes) {
        assert.ok(node.address, `节点 ${node.id} 有地址`);
        assert.ok(typeof node.address === 'string');
      }

      totalNodes += nodes.length;
    }

    assert.ok(totalNodes > 0, `总共导入 ${totalNodes} 个节点`);
    console.log(`  ✓ 导入 ${txtFiles.length} 个合成文档，共 ${totalNodes} 节点`);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
    store.close();
  }
});

// ====== 5. Markdown 导出（章节结构） ======

test('导出 Markdown 保留章节结构', () => {
  const { store } = tempStore();
  try {
    const doc = store.createDoc({ title: '导出测试', rootText: '需求总目标文本' });
    store.insertNode({
      docId: doc.id,
      parentId: doc.rootNodeId,
      text: '入口条件树',
      nodeType: 'TEXT'
    });
    store.insertNode({
      docId: doc.id,
      parentId: doc.rootNodeId,
      text: '主流程条件树',
      nodeType: 'TEXT'
    });

    const markdown = store.exportDocMarkdown(doc.id);

    // 每个根子节点作为独立 ## 章节
    assert.match(markdown, /## 入口条件树/);
    assert.match(markdown, /## 主流程条件树/);
    assert.match(markdown, /## 需求总目标/);
    assert.match(markdown, /需求总目标文本/);
    // 旧格式用 # 主流程条件树 包裹所有章节，新格式每个章节独立 ## 标题
    assert.ok(!/^# 主流程条件树$/m.test(markdown), '不再使用旧格式一级标题包裹章节');

    console.log('  ✓ 章节导出正确');
  } finally {
    store.close();
  }
});

// ====== 6. 超节点（单链 TEXT 合并） ======

test('超节点：resolveDisplayChildren 和 collectChainText', async () => {
  const { resolveDisplayChildren, collectChainText, getChainNodeIds } = await import('../src/core/tree.mjs');
  const { store } = tempStore();
  try {
    const doc = store.createDoc({ title: '超节点测试', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'A文本', nodeType: 'TEXT' });
    const b = store.insertNode({ docId: doc.id, parentId: a.id, text: 'B文本', nodeType: 'TEXT' });
    const c = store.insertNode({ docId: doc.id, parentId: b.id, text: 'C文本', nodeType: 'TEXT' });
    // C has two children → chain ends at C
    store.insertNode({ docId: doc.id, parentId: c.id, text: 'D1', nodeType: 'TEXT' });
    store.insertNode({ docId: doc.id, parentId: c.id, text: 'D2', nodeType: 'IF' });

    const loaded = store.getDoc(doc.id);
    const nodeA = findNode(loaded.tree, a.id);

    // Chain detection
    const chainIds = getChainNodeIds(nodeA);
    assert.deepEqual(chainIds, [a.id, b.id, c.id], 'A→B→C 是连续单链');
    assert.equal(chainIds.length, 3);

    // Chain text
    const chainText = collectChainText(nodeA);
    assert.match(chainText, /A文本/);
    assert.match(chainText, /B文本/);
    assert.match(chainText, /C文本/);

    // Display children: should skip B and C, return C's actual children
    const displayKids = resolveDisplayChildren(nodeA);
    assert.equal(displayKids.length, 2, '超节点解析后应有2个实际子节点');
    const texts = displayKids.map(n => n.text);
    assert.ok(texts.includes('D1'));
    assert.ok(texts.includes('D2'));

    // Non-chain node should return its own children directly
    const nodeD2 = displayKids.find(n => n.text === 'D2');
    const d2DisplayKids = resolveDisplayChildren(nodeD2);
    assert.equal(d2DisplayKids.length, 0, 'IF 节点不参与链合并');

    console.log('  ✓ 超节点逻辑正确');
  } finally {
    store.close();
  }
});

// ====== 汇总 ======

// ====== 8. 模拟 UI 工具栏「新建文档」完整流程 ======

test('模拟 UI 工具栏按钮：prompt → createDoc → 状态刷新', () => {
  const { store } = tempStore();
  try {
    // 模拟 window.prompt 返回标题
    const title = '用户输入的新文档名称';

    // 模拟 App.jsx 中 createDoc() 的核心逻辑
    const doc = store.createDoc({ title, rootText: title });
    assert.ok(doc.id);
    assert.ok(doc.rootNodeId);
    assert.equal(doc.title, title);

    // 模拟 setCurrentDoc + refreshDocs
    const loaded = store.getDoc(doc.id);
    assert.ok(loaded.tree);
    assert.equal(loaded.tree.text, title);
    assert.equal(loaded.tree.address, '1');
    assert.equal(loaded.tree.nodeType, 'TEXT');

    // 模拟文档列表刷新
    const list = store.listDocs();
    const found = list.find(d => d.id === doc.id);
    assert.ok(found);
    assert.equal(found.title, title);
    assert.equal(found.node_count, 1);

    console.log('  ✓ 工具栏按钮完整流程正常');
  } finally {
    store.close();
  }
});

console.log('\n✅ 集成测试全部完成');
