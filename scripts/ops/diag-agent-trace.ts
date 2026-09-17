#!/usr/bin/env node
// 临时诊断脚本：跑单题 agent.run，打印完整 toolEvents（含 argsPreview/resultPreview 规模）与最终答案。
// 用法：node dist/scripts/ops/diag-agent-trace.js --doc-id <id> --query "..."
// 诊断对象是「线上那个内置 agent」，所以必须连共享后端（18-6-1 / ARCHITECTURE §1）：
// 它的上下文、会话、索引缓存都在那个 host 进程里；另起私有 host 诊的是另一个环境，
// 而且私有 host 会以第二条可写连接开同一主库（IftreeStore.init 要跑迁移）。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackendClient } from '../../src/backend/llm/backend-client.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface TraceOptions {
  contextDepth: number;
  docId?: string;
  query?: string;
}

interface ToolEvent {
  name?: unknown;
  status?: unknown;
  argsPreview?: unknown;
  error?: unknown;
  resultPreview?: unknown;
}

interface AgentRunResult {
  answer?: unknown;
  toolEvents?: ToolEvent[];
}

function parseArgs(argv: string[]): TraceOptions {
  const out: TraceOptions = { contextDepth: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--doc-id') { out.docId = argv[++i]; continue; }
    if (a === '--query') { out.query = argv[++i]; continue; }
    if (a === '--context-depth') { out.contextDepth = Number(argv[++i]); continue; }
  }
  return out;
}

function previewLen(s: unknown) {
  return typeof s === 'string' ? s.length : 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const client = createBackendClient({
    projectRoot: PROJECT_ROOT,
    hostScriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    mode: 'shared',
    onStderr: (text: unknown) => { process.stderr.write(String(text ?? '')); },
    onStatus: (text: unknown) => { process.stderr.write(String(text ?? '')); }
  });
  try {
    const result = await client.runAgent(
      { mode: 'qa', docId: opts.docId, contextDepth: opts.contextDepth, prompt: opts.query }
    ) as AgentRunResult;
    console.log('===== QUERY =====');
    console.log(opts.query);
    console.log('===== ANSWER =====');
    console.log(String(result.answer || ''));
    console.log('===== TOOL EVENTS =====');
    for (const ev of result.toolEvents || []) {
      console.log(`\n--- tool: ${ev.name} status=${ev.status || ''} ---`);
      if (ev.argsPreview) console.log(`  args: ${ev.argsPreview}`);
      if (ev.error) console.log(`  error: ${ev.error}`);
      const rp = ev.resultPreview;
      if (rp) {
        console.log(`  resultPreview(len=${previewLen(rp)}):`);
        console.log(String(rp).split('\n').map((l) => '    ' + l).join('\n').slice(0, 4000));
      }
    }
  } finally {
    // 只断本连接：诊断一题不该顺手关掉 GUI/MCP 都在用的共享后端。
    // mode !== 'pipe' 才 shutdown——那是拉不起共享后端时回退出来的私有兜底 host。
    if (client.mode !== 'pipe') await client.shutdown();
    client.close();
  }
  if (process.env.ELECTRON_RUN_AS_NODE === '1') process.exit(0);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
