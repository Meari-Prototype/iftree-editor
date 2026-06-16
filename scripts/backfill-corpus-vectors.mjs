// 临时后台脚本：给已导入文档补建语义向量（嵌入后端由 .env 决定，这里走 ollama bge-m3）。
// 自己当一个「无超时」client，起 agent-host 子进程发 vector.ensureDoc，跑完关掉 host。
//
// 用法（普通 node 跑本脚本即可；host 子进程会用 electron-as-node 拿到 better-sqlite3 的 ABI）：
//   node scripts/backfill-corpus-vectors.mjs [docId]
//
// 注意：跑之前务必先 restart_backend 释放 MCP 持有的 headless，且补向量期间不要再调
// 任何 MCP iftree 工具——两个 host 进程会争同一个 SQLite/LanceDB 锁。
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessAgentClient } from '../src/backend/llm/headless-agent-client.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const hostScriptPath = join(PROJECT_ROOT, 'scripts', 'agent-host.mjs');
const docId = process.argv[2] || '019e8e89-e1b6-72eb-b5d7-3fdc239b6e86';

const client = createHeadlessAgentClient({
  processPath: electronPath,
  scriptPath: hostScriptPath,
  cwd: PROJECT_ROOT
});

const startedAt = Date.now();
const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(0);
let lastLog = 0;

console.log(`[backfill] start docId=${docId}`);
console.log(`[backfill] host=${hostScriptPath}`);
console.log(`[backfill] electron=${electronPath}`);

async function finish(code) {
  try { await client.shutdown(); } catch { /* 可能已在关闭 */ }
  try { client.close(); } catch { /* 兜底 kill */ }
  process.exit(code);
}

try {
  const result = await client.request('vector.ensureDoc', { payload: { docId } }, {
    onEvent: (event) => {
      const now = Date.now();
      if (now - lastLog > 5000) {
        lastLog = now;
        console.log(`[backfill ${elapsed()}s] ${JSON.stringify(event)}`);
      }
    }
  });
  console.log(`[backfill] DONE in ${elapsed()}s result=${JSON.stringify(result)}`);
  await finish(0);
} catch (err) {
  console.error(`[backfill] FAILED in ${elapsed()}s ${err?.stack || err?.message || err}`);
  await finish(1);
}
