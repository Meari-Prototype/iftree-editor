#!/usr/bin/env node
// 运维：记忆卷校验扫除（projectneed 15-10-4「无锚的非法残留卷可被清除」）。
//
// 用法（推荐双击同目录 purge-orphaned-volumes.bat，它负责 electron ABI 那点环境）：
//   1) 在文件管理器里删掉要清的卷的实体锚文件：library/.memory/<身份>/<工作区>/<会话>.jsonl
//      —— 删哪个锚，就是要删哪个卷；这一步「删文件」本身就是你的删除指令，不需要再确认。
//   2) 跑本脚本。它扫所有记忆卷，把「锚已被删除（路径本身不存在）」的卷连带清干净。
//
// 判据只认「锚路径本身在不在」（后端用 lstat 不解引用）：
//   · 你删掉的锚 → 路径没了 → 清；
//   · 合法卷的悬空 symlink / 没带 hostAnchor 的占位文件（15-10-2 允许悬空）→ 文件还在 → 保留。
// 所以只有你亲手删过锚的卷才会被清，不会误伤需求允许悬空的真卷。
//
// 必经后端（projectneed 18-6-1 后端共用）：复用正在跑的共享后端，没有就自行拉起，
// 绝不自开 better-sqlite3 直连——这是老 purge 脚本抢锁、半删残留的病根，本脚本不再犯。
// 清理只动 SQLite 侧（连带 refs/nodes/source 行）；LanceDB 派生索引不在此碰，留给自检/reconcile 对齐。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSharedBackendClient } from '../src/backend/llm/backend-pipe-client.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const client = createSharedBackendClient({
  projectRoot: PROJECT_ROOT,
  hostScriptPath: join(PROJECT_ROOT, 'scripts', 'agent-host.mjs'),
  onStderr: (text) => process.stderr.write(text),
  onStatus: (text) => process.stderr.write(text)
});

// --dry-run：只扫描报告会清哪些卷、不实际删除（删锚前先预览，或验证连通）。
const dryRun = process.argv.includes('--dry-run');

try {
  const result = await client.request('memory.purgeOrphaned', { dryRun });
  const purged = Array.isArray(result?.purged) ? result.purged : [];
  const verb = dryRun ? '将清除' : '已清除';
  const suffix = dryRun ? '（dry-run 预览，未实际删除）' : '';
  console.log(`扫描 ${result?.scanned ?? 0} 个记忆卷，${verb} ${purged.length} 个脱锚卷${suffix}。`);
  for (const volume of purged) {
    console.log(`  - ${volume.title || '(无标题)'}  [agent=${volume.agent ?? '?'} session=${volume.sessionId ?? '?'}]  doc=${volume.docId}`);
    console.log(`    原锚：${volume.anchorPath || '(已无 source 记录)'}`);
  }
  if (!purged.length) {
    console.log('没有脱锚卷——所有记忆卷的实体锚都还在。');
    console.log('要删某卷，先在 library/.memory 下删掉它的锚文件，再跑本脚本。');
  }
} finally {
  // 共享后端是多客户端复用的：跑完只断开本连接、绝不关它（照 mcp-server 按 mode 判断），
  // 免得把 app / MCP 正用的后端误杀。私有兜底后端由本进程独占，正常 shutdown 免泄漏子进程。
  try {
    if (client.mode !== 'pipe') await client.shutdown();
  } catch { /* 后端可能已在退出 */ }
  client.close();
}

// electron 以 node 身份跑时不会自然退出（句柄未释放），显式收尾。
if (process.env.ELECTRON_RUN_AS_NODE === '1') process.exit(process.exitCode || 0);
