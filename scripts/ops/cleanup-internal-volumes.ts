#!/usr/bin/env node
// 一次性清理：删除内置 agent（iftree-builtin）历次自动落卷产生的无锚记忆卷（projectneed 15-10-2 修订后这些卷不应再存在）。
// 外部 agent（如 claude-code）经 memory_deliver 投递的合法卷不在此列、不删。
// 用法：electron scripts/cleanup-internal-volumes.mjs        （dry-run，只报数量）
//      electron scripts/cleanup-internal-volumes.mjs --yes  （执行删除）
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessAgentClient } from '../../src/backend/llm/headless-agent-client.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXECUTE = process.argv.includes('--yes');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SQL = "SELECT id FROM docs WHERE json_extract(meta,'$.memoryVolume.agent')='iftree-builtin'";

const client = createHeadlessAgentClient({
  cwd: PROJECT_ROOT,
  scriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
  onStderr: (text) => process.stderr.write(text)
});

let total = 0;
try {
  for (let round = 0; ; round += 1) {
    const res = await client.request('db.shell', { argv: ['sql', SQL] }) as { text?: unknown };
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
      await client.request('db.shell', { argv: ['delete', id] });
      total += 1;
      if (total % 50 === 0) console.log(`已删除 ${total} ...`);
    }
    console.log(`本轮删除 ${ids.length}，累计 ${total}`);
  }
} finally {
  await client.shutdown();
  client.close();
}
if (process.env.ELECTRON_RUN_AS_NODE === '1') process.exit(0);
