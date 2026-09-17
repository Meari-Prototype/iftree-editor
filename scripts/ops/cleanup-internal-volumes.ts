#!/usr/bin/env node
// 一次性清理：删除内置 agent（iftree-builtin）历次自动落卷产生的无锚记忆卷（projectneed 15-10-2 修订后这些卷不应再存在）。
// 外部 agent（如 claude-code）经 memory_deliver 投递的合法卷不在此列、不删。
// 用法：node dist/scripts/ops/cleanup-internal-volumes.js        （dry-run，只报数量）
//      node dist/scripts/ops/cleanup-internal-volumes.js --yes  （执行删除）
// 目标库 = IFTREE_DB 或 database/store.sqlite；删档全程经共享后端，本进程不碰 sqlite。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackendClient } from '../../src/backend/llm/backend-client.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXECUTE = process.argv.includes('--yes');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SQL = "SELECT id FROM docs WHERE json_extract(meta,'$.memoryVolume.agent')='iftree-builtin'";

// 走共享后端（18-6-1 / ARCHITECTURE §1）：批量删档要连带清对象库/关键词/向量等派生索引，
// 只能由持库的那个 host 顺着单写队列做——私有 host 会成为同一主库上的第二个写者（它的
// IftreeStore.init() 自己就要 exec(TABLES_SQL)/ALTER TABLE/迁移）。后端不在跑时会自动拉起。
const client = createBackendClient({
  projectRoot: PROJECT_ROOT,
  hostScriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
  mode: 'shared',
  onStderr: (text: unknown) => { process.stderr.write(String(text ?? '')); },
  onStatus: (text: unknown) => { process.stderr.write(String(text ?? '')); }
});

let total = 0;
try {
  for (let round = 0; ; round += 1) {
    const res = await client.dbShell(['sql', SQL]) as { text?: unknown };
    const ids = [...new Set(String(res.text || '').match(UUID_RE) || [])];
    if (!ids.length) {
      console.log(total ? `没有更多目标，累计删除 ${total}` : '没有匹配的内置无锚记忆卷');
      break;
    }
    if (!EXECUTE) {
      console.log(`dry-run：本轮匹配 ${ids.length} 个内置记忆卷（传 --yes 执行删除）；示例 ${ids.slice(0, 3).join(', ')}`);
      break;
    }
    for (const id of ids) {
      await client.dbShell(['delete', id]);
      total += 1;
      if (total % 50 === 0) console.log(`已删除 ${total} ...`);
    }
    console.log(`本轮删除 ${ids.length}，累计 ${total}`);
  }
} finally {
  // 只断本连接：共享后端多客户端复用，一次性清理跑完不该把 GUI/MCP 也在用的它关掉。
  // mode !== 'pipe' 才 shutdown——那是拉不起共享后端时回退出来的私有兜底 host，由本进程收尸。
  if (client.mode !== 'pipe') await client.shutdown();
  client.close();
}
if (process.env.ELECTRON_RUN_AS_NODE === '1') process.exit(0);
