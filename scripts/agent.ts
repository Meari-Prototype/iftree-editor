#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackendClient } from '../src/backend/llm/backend-client.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type AgentRequest = Record<string, unknown> & {
  help?: boolean;
  type?: string;
};
type ErrorLike = { stack?: string; message?: string };

function errorLike(error: unknown): ErrorLike {
  return error && typeof error === 'object' ? error as ErrorLike : { message: String(error) };
}

function printHelp() {
  console.log([
    'Usage:',
    '  node dist/scripts/agent.js \'{"type":"agent.run","payload":{"mode":"qa","prompt":"你好"}}\'',
    '  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '  \'{"type":"agent.run","payload":{"mode":"qa","prompt":"你好"}}\' | node dist/scripts/agent.js --stdin',
    '',
    'Output:',
    '  JSON lines: agent.stream events followed by one result line.'
  ].join('\n'));
}

function parseRequest(argv: string[] = []): AgentRequest {
  if (argv.length === 0 || ['help', '--help', '-h'].includes(argv[0])) return { help: true };
  const raw = argv[0] === '--stdin' ? readFileSync(0, 'utf8') : argv.join(' ');
  const parsed = JSON.parse(String(raw || '').trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Agent request must be a JSON object');
  }
  if (!parsed.type) return { type: 'agent.run', payload: parsed };
  return parsed as AgentRequest;
}

async function exitProcess(code: number) {
  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    process.exit(code);
    return;
  }
  if (process.versions.electron) {
    const { app } = await import('electron');
    if (app?.exit) {
      app.exit(code);
      return;
    }
  }
  process.exit(code);
}

async function main() {
  const request = parseRequest(process.argv.slice(2));
  if (request.help) {
    printHelp();
    await exitProcess(0);
    return;
  }
  // 走共享后端（18-6-1 / ARCHITECTURE §1）：这条 CLI 只是把一个请求信封原样丢给后端，
  // 该由在跑的那个 host 接（GUI/MCP 见到的会话、草稿、索引都在它进程里），不该另起一个
  // 私有 host——私有 host 会以第二条可写连接打开同一主库并跑迁移。本脚本自己跑什么 runtime
  // 无所谓：host 恒由 resolveNodeExecutable 钉在真 node 上。
  const client = createBackendClient({
    projectRoot: PROJECT_ROOT,
    hostScriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    mode: 'shared',
    onStderr: (text: unknown) => { process.stderr.write(String(text ?? '')); },
    onStatus: (text: unknown) => { process.stderr.write(String(text ?? '')); }
  });
  try {
    const result = await client.request(String(request.type), request, {
      onEvent: (event: unknown) => {
        console.log(JSON.stringify({ type: 'agent.stream', event }));
      }
    });
    console.log(JSON.stringify({ type: 'result', result }));
  } finally {
    // 只断本连接：共享后端多客户端复用，不能因一条 CLI 退出而全局关停。
    // mode !== 'pipe' 才 shutdown（拉不起共享后端时回退出来的私有兜底 host 由本进程收尸）。
    if (client.mode !== 'pipe') await client.shutdown();
    client.close();
  }
}

main()
  .then(() => exitProcess(0))
  .catch(async (error: unknown) => {
    const failure = errorLike(error);
    console.error(failure.stack || failure.message || String(error));
    await exitProcess(1);
  });
