import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../dist/src/backend/store/index.js';

// 草稿 entries 拆表（edit_branch_entries）：存储真相在子表、diff 列退役为元壳、
// 行出口拼合保持 diff JSON 契约。写侧 stage/undo/redo 从整包重写 O(K) 降为单行 O(1)。

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-eb-entries-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const rawDiffColumn = (store, branchId) =>
  store.db.prepare('SELECT diff FROM edit_branches WHERE id = ?').get(branchId).diff;

const entryTableCount = (store, branchId, status = null) => (status
  ? store.db.prepare('SELECT COUNT(*) AS n FROM edit_branch_entries WHERE branch_id = ? AND status = ?').get(branchId, status).n
  : store.db.prepare('SELECT COUNT(*) AS n FROM edit_branch_entries WHERE branch_id = ?').get(branchId).n);

function buildDocWithBranch(store) {
  const doc = store.createDoc({ title: 'EB', rootText: '根' });
  const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
  const branch = store.beginEditBranch(doc.id, 'human');
  return { doc, a, branch };
}

test('stage 是 O(1) 追加：多次 stage 后 diff 列保持元壳不膨胀，拼合出口带回全部 entries', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDocWithBranch(store);
    let branch = store.findEditBranch({ baseDocId: doc.id, owner: 'human' });
    const N = 200;
    for (let i = 0; i < N; i += 1) {
      branch = store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { text: `第${i}版` } });
    }
    // 存储真相在子表；diff 列是常数大小的元壳（不随 K 增长——这正是 O(K²) 的根治点）。
    assert.equal(entryTableCount(store, branch.id), N);
    const rawColumn = rawDiffColumn(store, branch.id);
    assert.ok(rawColumn.length < 1000, `diff 列应为元壳（实测 ${rawColumn.length} 字节）`);
    assert.equal(JSON.parse(rawColumn).storage, 'entries_table');
    // 拼合出口契约：branch.diff 里 entries 完整、有序、带 status/createdAt。
    const projected = JSON.parse(branch.diff);
    assert.equal(projected.entries.length, N);
    assert.equal(projected.entries[0].patch.text, '第0版');
    assert.equal(projected.entries[N - 1].patch.text, `第${N - 1}版`);
    assert.ok(projected.entries.every((e) => e.status === 'active' && e.createdAt));
    // getDoc 投影吃到最后一版。
    const view = store.getDoc(doc.id);
    const node = view.nodes.find((n) => String(n.id) === String(a.id));
    assert.equal(node.text, `第${N - 1}版`);
  });
});

test('undo/redo 单行翻转：LIFO 语义与 redo 复活最近撤销者', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDocWithBranch(store);
    let branch = store.findEditBranch({ baseDocId: doc.id, owner: 'human' });
    branch = store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { text: '一' } });
    branch = store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { text: '二' } });
    branch = store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { text: '三' } });

    // undo×2：撤「三」再撤「二」。
    let result = store.undoEditBranchEntry({ baseDocId: doc.id, owner: 'human' });
    assert.equal(result.undoDepth, 2);
    result = store.undoEditBranchEntry({ baseDocId: doc.id, owner: 'human' });
    assert.equal(result.undoDepth, 1);
    assert.equal(result.redoDepth, 2);
    assert.equal(store.getDoc(doc.id).nodes.find((n) => String(n.id) === String(a.id)).text, '一');

    // 两次 undo 常落在同一毫秒（undoneAt 字符串相同，新旧实现都退化为按 seq 取）；
    // 手工拉开时间差还原真实操作节奏，验证 redo 的 LIFO——复活最近撤销的「二」。
    store.db.prepare(`
      UPDATE edit_branch_entries SET undone_at = '2099-01-01T00:00:00.000Z'
      WHERE branch_id = ? AND status = 'undone'
        AND json_extract(entry, '$.patch.text') = '二'
    `).run(branch.id);
    result = store.redoEditBranchEntry({ baseDocId: doc.id, owner: 'human' });
    assert.equal(result.undoDepth, 2);
    assert.equal(store.getDoc(doc.id).nodes.find((n) => String(n.id) === String(a.id)).text, '二');

    // 新 stage 销毁 redo 分支（「三」永久丢弃）。
    branch = store.findEditBranch({ baseDocId: doc.id, owner: 'human' });
    store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { text: '四' } });
    assert.equal(entryTableCount(store, branch.id, 'undone'), 0, '追加后 redo 分支清空');
    const state = store.editBranchHistoryState(store.findEditBranch({ baseDocId: doc.id, owner: 'human' }));
    assert.equal(state.undoDepth, 3);
    assert.equal(state.redoDepth, 0);
  });
});

test('旧库迁移：diff 整包 entries 的存量行启动即搬进子表、行为不变、幂等', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-eb-migrate-'));
  const dbPath = join(dir, 'store.sqlite');
  try {
    // 第一代 store：造分支后手工把行改回旧格式（entries 整包塞 diff、清空子表）。
    let store = new IftreeStore(dbPath);
    store.init();
    const doc = store.createDoc({ title: 'M', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
    const branch = store.beginEditBranch(doc.id, 'human');
    const legacyDiff = {
      kind: 'edit_branch_diff',
      storage: 'lazy_diff',
      owner: branch.owner,
      baseDocId: branch.base_doc_id,
      shadowDocId: branch.shadow_doc_id,
      entries: [
        { kind: 'node.update', node_id: a.id, patch: { text: '旧一' }, status: 'active', createdAt: '2026-01-01T00:00:00Z' },
        { kind: 'node.update', node_id: a.id, patch: { text: '旧二' }, status: 'undone', createdAt: '2026-01-02T00:00:00Z', undoneAt: '2026-01-03T00:00:00Z' }
      ]
    };
    store.db.prepare('DELETE FROM edit_branch_entries WHERE branch_id = ?').run(branch.id);
    store.db.prepare('UPDATE edit_branches SET diff = ? WHERE id = ?').run(JSON.stringify(legacyDiff), branch.id);
    store.close();

    // 第二代 store：init 迁移。
    store = new IftreeStore(dbPath);
    store.init();
    assert.equal(entryTableCount(store, branch.id), 2, '两条 entries 搬进子表');
    assert.equal(JSON.parse(rawDiffColumn(store, branch.id)).storage, 'entries_table');
    assert.equal(JSON.parse(rawDiffColumn(store, branch.id)).entries, undefined, '元壳不再含 entries');
    const fresh = store.findEditBranch({ baseDocId: doc.id, owner: 'human' });
    const projected = JSON.parse(fresh.diff);
    assert.equal(projected.entries.length, 2);
    assert.equal(projected.entries[0].patch.text, '旧一');
    assert.equal(projected.entries[1].status, 'undone');
    assert.equal(projected.entries[1].undoneAt, '2026-01-03T00:00:00Z');
    const state = store.editBranchHistoryState(fresh);
    assert.equal(state.undoDepth, 1);
    assert.equal(state.redoDepth, 1);
    // getDoc 投影吃 active 那条。
    assert.equal(store.getDoc(doc.id).nodes.find((n) => String(n.id) === String(a.id)).text, '旧一');
    store.close();

    // 第三代：再启动幂等（不重复搬运）。
    store = new IftreeStore(dbPath);
    store.init();
    assert.equal(entryTableCount(store, branch.id), 2, '迁移幂等');
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('保存/丢弃分支连带清子表（CASCADE）', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDocWithBranch(store);
    let branch = store.findEditBranch({ baseDocId: doc.id, owner: 'human' });
    branch = store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { text: '改' } });
    assert.equal(entryTableCount(store, branch.id), 1);

    const merged = store.applyThreeWayMerge({ baseDocId: doc.id, owner: 'human', summary: '保存' });
    assert.equal(merged.applied, true);
    assert.equal(entryTableCount(store, branch.id), 0, '分支行删除后子表级联清空');
    assert.equal(store.db.prepare('SELECT text FROM nodes WHERE id = ?').get(a.id).text, '改', '改动落主干');
  });
});

// ─── 编辑模式投影缓存（#3b：写代数戳失效）────────────────────────────────────

test('投影缓存：零写之间复用（引用相等），任何写后失效并反映新值', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDocWithBranch(store);
    const branch = store.findEditBranch({ baseDocId: doc.id, owner: 'human' });
    store._appendEditBranchEntry(branch, { kind: 'node.update', node_id: a.id, patch: { text: '草稿版' } });

    // 首次 miss（投影并缓存），第二次命中——投影数组是同一引用（跳过了全量 SELECT 与 replay）。
    const first = store.getDoc(doc.id);
    const second = store.getDoc(doc.id);
    assert.equal(second.nodes, first.nodes, '零写之间第二次 getDoc 复用缓存投影');

    // 分支侧写（stage）失效缓存。
    store._appendEditBranchEntry(store.findEditBranch({ baseDocId: doc.id, owner: 'human' }), {
      kind: 'node.update', node_id: a.id, patch: { text: '草稿版二' }
    });
    const afterStage = store.getDoc(doc.id);
    assert.notEqual(afterStage.nodes, first.nodes, 'stage 后缓存失效');
    assert.equal(afterStage.nodes.find((n) => String(n.id) === String(a.id)).text, '草稿版二');

    // base 侧直写（agent full 直写主干的形态）同样失效——投影输入变了。
    const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'base 新节点' });
    const afterBaseWrite = store.getDoc(doc.id);
    assert.ok(afterBaseWrite.nodes.some((n) => String(n.id) === String(b.id)), 'base 直写后投影含新节点');

    // 保存分支：读到主干；保存后的首次 getDoc 走无分支路径、顺手清缓存（内存卫生）。
    store.applyThreeWayMerge({ baseDocId: doc.id, owner: 'human', summary: '保存' });
    assert.equal(store.getDoc(doc.id).nodes.find((n) => String(n.id) === String(a.id)).text, '草稿版二');
    assert.equal(store._branchProjectionCache, null, '分支关闭后缓存清空');
  });
});
