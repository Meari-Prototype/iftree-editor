import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createConfiguredIftreeStore } from '../dist/src/backend/store-domain-adapter.js';
import { stageEntityWrite } from '../dist/src/backend/entities/write.js';

// entities 表有 UNIQUE(doc_id, normalized_literal)。分支内改名若不查重，entry 会一直留到 commit
// 重放时才以 SQLITE_CONSTRAINT 炸掉——整批 entry 一起失败，且用户看不出是哪条、也撤不掉单条 entry。
// 所以 stage 当场拒；撞的是自己（大小写变体）则照常放行。

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-entity-rename-'));
  const store = createConfiguredIftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('entity.update 改成同文档已有实体名：stage 当场拒绝；撞自己（大小写变体）放行', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'EntityRename', rootText: '根' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '正文节点' });
    store.saveHistorySnapshot({ docId: doc.id });

    // 先落两个实体到主库（stage → commit）。
    const branch = store.beginEditBranch(doc.id, 'human');
    const staged = stageEntityWrite(store, branch, { docId: doc.id, literal: 'Alpha' }, 'entity.create');
    stageEntityWrite(store, staged.editBranch, { docId: doc.id, literal: 'Beta' }, 'entity.create');
    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });

    const rows = store.db.prepare('SELECT id, literal FROM entities WHERE doc_id = ?').all(doc.id);
    assert.equal(rows.length, 2);
    const alpha = rows.find((row) => row.literal === 'Alpha');
    assert.ok(alpha);

    const renameBranch = store.beginEditBranch(doc.id, 'human');
    // 撞 Beta（normalized_literal 相同）：stage 就拒，错误里报出撞名的实体。
    assert.throws(
      () => stageEntityWrite(store, renameBranch, { entityId: alpha.id, literal: 'beta' }, 'entity.update'),
      /已存在同名实体/
    );
    // 拒绝路径不落 entry：分支条目数不变（拒之前分支是空的）。
    const entryCount = store.db
      .prepare('SELECT COUNT(*) AS c FROM edit_branch_entries WHERE branch_id = ?')
      .get(renameBranch.id).c;
    assert.equal(entryCount, 0);

    // 撞的是自己（只改大小写）：normalized 相同但 id 相同，照常放行。
    const renamed = stageEntityWrite(store, renameBranch, { entityId: alpha.id, literal: 'ALPHA' }, 'entity.update');
    assert.equal(renamed.ok, true);
    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });
    assert.equal(
      store.db.prepare('SELECT literal FROM entities WHERE id = ?').get(alpha.id).literal,
      'ALPHA'
    );
  });
});
