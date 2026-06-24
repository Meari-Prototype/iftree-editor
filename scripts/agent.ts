#!/usr/bin/env node
// @ts-nocheck
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessAgentClient } from '../src/backend/llm/headless-agent-client.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function printHelp() {
  console.log([
    'Usage:',
    '  $env:ELECTRON_RUN_AS_NODE = \'1\'',
    '  .\\node_modules\\.bin\\electron.cmd scripts/agent.mjs \'{"type":"agent.run","payload":{"mode":"qa","prompt":"你好"}}\'',
    '  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '  \'{"type":"agent.run","payload":{"mode":"qa","prompt":"你好"}}\' | .\\node_modules\\.bin\\electron.cmd scripts/agent.mjs --stdin',
    '',
    'Output:',
    '  JSON lines: agent.stream events followed by one result line.'
  ].join('\n'));
}

function parseRequest(argv = []) {
  if (argv.length === 0 || ['help', '--help', '-h'].includes(argv[0])) return { help: true };
  const raw = argv[0] === '--stdin' ? readFileSync(0, 'utf8') : argv.join(' ');
  const parsed = JSON.parse(String(raw || '').trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Agent request must be a JSON object');
  }
  if (!parsed.type) return { type: 'agent.run', payload: parsed };
  return parsed;
}

async function exitProcess(code) {
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
  const client = createHeadlessAgentClient({
    cwd: PROJECT_ROOT,
    scriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    onStderr: (text) => process.stderr.write(text)
  });
  try {
    const result = await client.request(request.type, request, {
      onEvent: (event) => {
        console.log(JSON.stringify({ type: 'agent.stream', event }));
      }
    });
    console.log(JSON.stringify({ type: 'result', result }));
  } finally {
    await client.shutdown();
    client.close();
  }
}

main()
  .then(() => exitProcess(0))
  .catch(async (error) => {
    console.error(error?.stack || error?.message || String(error));
    await exitProcess(1);
  });
