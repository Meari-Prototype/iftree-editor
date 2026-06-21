import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { IftreeStore } from '../src/backend/store/index.mjs';
import { flattenTree } from '../src/core/tree.mjs';
import { importRecordsForFile } from '../src/core/import-formats/router.mjs';

// --- helpers ---

function tempStore() {
  const dir = join(tmpdir(), `iftree-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dbPath = join(dir, 'store.sqlite');
  rmSync(dbPath, { force: true });
  const store = new IftreeStore(dbPath);
  store.init();
  return { store, dbPath };
}

// 导入导出专用夹具：library/generated 下的固定文档，可反复「导入 → 校验 → 导出 → 删除重导」。
// 与「数据库读写测试样例.md」分开，避免在真实库上折腾导入导出时丢掉后者的历史 diff。
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'library',
  'generated',
  'IFTreeEditor导入导出测试夹具.md'
);

// ====== 1. 文档 CRUD（认 UUID，不数文档总数）======

test('创建文档 → 列出 → 打开 → 节点操作', () => {
  const { store } = tempStore();
  try {
    const d1 = store.createDoc({ title: '测试文档A', rootText: '根节点文本A' });
    const d2 = store.createDoc({ title: '测试文档B', rootText: '根节点文本B' });

    // 认 UUID：init 会预置虚拟文档，列表里不止自建的两篇，所以不数总数，
    // 只断言自建的两个 id 都在、且自建文档按创建顺序排列。
    const list = store.listDocs();
    const a = list.find((d) => d.id === d1.id);
    const b = list.find((d) => d.id === d2.id);
    assert.ok(a, '文档A 应在列表中（按 UUID 认）');
    assert.ok(b, '文档B 应在列表中（按 UUID 认）');
    assert.equal(b.title, '测试文档B');
    assert.equal(a.node_count, 1, '根节点算 1 个节点');
    const myOrder = list.filter((d) => d.id === d1.id || d.id === d2.id).map((d) => d.id);
    assert.deepEqual(myOrder, [d1.id, d2.id], '自建文档按创建顺序（doc_sort_order 升序）排列');

    // 打开
    const loaded = store.getDoc(d1.id);
    assert.ok(loaded.tree, 'getDoc 返回根节点');
    assert.equal(loaded.tree.text, '根节点文本A');
    assert.equal(loaded.tree.address, '1');

    // 插入子节点（getDoc 返回的树节点字段是驼峰 nodeType）
    const child = store.insertNode({ docId: d1.id, parentId: d1.rootNodeId, text: '子节点', nodeType: 'IF' });
    let reloaded = store.getDoc(d1.id);
    assert.equal(reloaded.tree.children.length, 1);
    assert.equal(reloaded.tree.children[0].text, '子节点');
    assert.equal(reloaded.tree.children[0].address, '1-1');
    assert.equal(reloaded.tree.children[0].nodeType, 'IF');

    // 更新节点（写入也用驼峰 nodeType）
    store.updateNode(child.id, { text: '更新后的子节点', nodeType: 'ELSE' });
    reloaded = store.getDoc(d1.id);
    assert.equal(reloaded.tree.children[0].text, '更新后的子节点');
    assert.equal(reloaded.tree.children[0].nodeType, 'ELSE');

    // 删除子树
    store.insertNode({ docId: d1.id, parentId: child.id, text: '孙子节点', nodeType: 'TEXT' });
    store.deleteNodeSubtree(child.id);
    const afterDelete = store.getDoc(d1.id);
    assert.equal(afterDelete.tree.children.length, 0, '子树删除后无子节点');
  } finally {
    store.close();
  }
});

// ====== 2. trust_level / node_type 写入读出（驼峰字段）======

test('trust_level 和 node_type 约束', () => {
  const { store } = tempStore();
  try {
    const doc = store.createDoc({ title: '约束测试', rootText: '测试' });

    store.updateNode(doc.rootNodeId, { trustLevel: '受控', nodeType: 'HUMAN_BLOCK' });
    let loaded = store.getDoc(doc.id);
    assert.equal(loaded.tree.trustLevel, '受控');
    assert.equal(loaded.tree.nodeType, 'HUMAN_BLOCK');

    store.updateNode(doc.rootNodeId, { trustLevel: '不受控', nodeType: 'HUMAN_SUMMARY' });
    loaded = store.getDoc(doc.id);
    assert.equal(loaded.tree.trustLevel, '不受控');
    assert.equal(loaded.tree.nodeType, 'HUMAN_SUMMARY');
  } finally {
    store.close();
  }
});

// ====== 3. 历史保存 → 快照重建 → 恢复 ======

test('保存版本 → 快照重建 → 恢复', () => {
  const { store } = tempStore();
  try {
    const doc = store.createDoc({ title: '历史测试', rootText: '初始文本' });
    const child = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '第一节', nodeType: 'TEXT' });

    // 第一版：diff 列已下线，保存返回 commit_id（UUIDv7）
    const h1 = store.saveHistorySnapshot({ docId: doc.id, summary: '第一版' });
    assert.ok(h1.id, 'saveHistorySnapshot 返回 commit id');
    assert.equal(h1.commit_id, h1.id);
    assert.match(String(h1.commit_id), /^019[a-f0-9-]+$/, 'commit id 是 UUIDv7');

    // 快照按内容寻址对象库重建（取代旧的 SELECT diff FROM commits）
    const snap1 = store.commitSnapshot(h1.id);
    assert.equal(snap1.nodes.find((n) => n.id === child.id)?.text, '第一节', '第一版快照保留初始正文');

    // 改一版再存
    store.updateNode(child.id, { text: '第一节（修改后）', nodeType: 'IF' });
    const h2 = store.saveHistorySnapshot({ docId: doc.id, summary: '第二版' });
    const snap2 = store.commitSnapshot(h2.id);
    assert.equal(snap2.nodes.find((n) => n.id === child.id)?.text, '第一节（修改后）', '第二版快照反映修改');

    // diff 不再持久化，由 computeDiff 现算两版差异
    const diff = store.computeDiff(snap1, snap2);
    assert.ok(JSON.stringify(diff).includes('第一节（修改后）'), 'diff 含修改后的文本');

    // 恢复第一版
    store.restoreCommit(h1.id);
    const restored = store.getDoc(doc.id);
    assert.equal(restored.tree.children[0].text, '第一节', '恢复后正文回到初始值');
    assert.equal(restored.tree.children[0].nodeType, 'TEXT', '恢复后类型回到初始值');
  } finally {
    store.close();
  }
});

// ====== 4. 导入专用夹具 → 校验树结构（认 UUID）======

test('导入夹具文档并校验节点结构', async () => {
  const { store } = tempStore();
  try {
    const routed = await importRecordsForFile(FIXTURE_PATH, { mode: 'complete' });
    assert.ok(Array.isArray(routed.structured) && routed.structured.length > 0, '夹具解析出结构化记录');

    const doc = store.createDocFromStructuredRecords({
      title: 'IFTreeEditor导入导出测试夹具',
      sourcePath: FIXTURE_PATH,
      records: routed.structured
    });

    // 认 UUID：不数文档总数
    assert.match(String(doc.id), /^019[a-f0-9-]+$/, '导入产生 UUIDv7 文档 id');
    assert.ok(store.listDocs().some((d) => d.id === doc.id), '导入的文档按 UUID 出现在列表');

    const loaded = store.getDoc(doc.id);
    const nodes = flattenTree(loaded.tree);
    const allText = nodes.map((n) => n.text || '').join('\n');

    // 标题层级被导入成树：两个章节标题都在
    assert.ok(nodes.some((n) => (n.text || '').includes('第一章 入口条件')), '第一章标题节点存在');
    assert.ok(nodes.some((n) => (n.text || '').includes('第二章 主流程')), '第二章标题节点存在');

    // 稳定靶子全部导入（叶子正文）
    for (const marker of ['IOFX_ALPHA', 'IOFX_BETA', 'IOFX_GAMMA', 'IOFX_DELTA', 'IOFX_END']) {
      assert.ok(allText.includes(marker), `靶子 ${marker} 已导入`);
    }

    // 每个节点都有稳定地址
    for (const node of nodes) {
      assert.ok(typeof node.address === 'string' && node.address.length > 0, `节点 ${node.id} 有地址`);
    }
  } finally {
    store.close();
  }
});

// ====== 5. 导入夹具后导出 Markdown（导入 → 导出 round-trip）======

test('导入夹具后导出 Markdown 保留层级与内容', async () => {
  const { store } = tempStore();
  try {
    const routed = await importRecordsForFile(FIXTURE_PATH, { mode: 'complete' });
    const doc = store.createDocFromStructuredRecords({
      title: 'IFTreeEditor导入导出测试夹具',
      sourcePath: FIXTURE_PATH,
      records: routed.structured
    });

    const markdown = store.exportDocMarkdown(doc.id);

    // 文档标题为一级标题
    assert.match(markdown, /^# IFTreeEditor导入导出测试夹具/m);
    // 当前导出实现：有子节点的渲染成标题、叶子原样输出正文。两个章节都有子节点，应成标题。
    assert.match(markdown, /#+ 第一章 入口条件/);
    assert.match(markdown, /#+ 第二章 主流程/);
    // 正文靶子保留、尾部未截断
    assert.match(markdown, /IOFX_ALPHA/);
    assert.match(markdown, /IOFX_END/);
  } finally {
    store.close();
  }
});

// ====== 6. 模拟 UI 工具栏「新建文档」完整流程 ======

test('模拟 UI 工具栏按钮：prompt → createDoc → 状态刷新', () => {
  const { store } = tempStore();
  try {
    // 模拟 window.prompt 返回标题
    const title = '用户输入的新文档名称';

    // 模拟 App 中 createDoc() 的核心逻辑
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

    // 模拟文档列表刷新：认 UUID（不数总数）
    const list = store.listDocs();
    const found = list.find((d) => d.id === doc.id);
    assert.ok(found);
    assert.equal(found.title, title);
    assert.equal(found.node_count, 1);

    console.log('  ✓ 工具栏按钮完整流程正常');
  } finally {
    store.close();
  }
});

console.log('\n✅ 集成测试全部完成');
