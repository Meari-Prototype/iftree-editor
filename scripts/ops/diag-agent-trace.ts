#!/usr/bin/env node
// 临时诊断脚本：跑单题 agent.run，打印完整 toolEvents（含 argsPreview/resultPreview 规模）与最终答案。
// 用法：electron.cmd scripts/diag-agent-trace.mjs --doc-id <id> --query "..."
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessAgentClient } from '../../src/backend/llm/headless-agent-client.js';

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
  const client = createHeadlessAgentClient({
    cwd: PROJECT_ROOT,
    scriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    onStderr: (text) => process.stderr.write(text)
  });
  try {
    const result = await client.request('agent.run', {
      payload: { mode: 'qa', docId: opts.docId, contextDepth: opts.contextDepth, prompt: opts.query }
    }) as AgentRunResult;
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
    await client.shutdown();
    client.close();
  }
  if (process.env.ELECTRON_RUN_AS_NODE === '1') process.exit(0);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
