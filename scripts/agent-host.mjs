#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessAgentHost } from '../src/backend/llm/headless-agent-host.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function writeJson(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorPayload(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || ''
  };
}

function fetchers() {
  return typeof fetch === 'function' ? [(target, init) => fetch(target, init)] : [];
}

async function main() {
  let host = null;
  let queue = Promise.resolve();
  let shuttingDown = false;
  let stdinClosed = false;
  const bufferedLines = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.stdin.resume();

  function finishIfClosed() {
    if (!stdinClosed || shuttingDown || !host) return;
    queue = queue.finally(() => {
      host.close();
      process.exit(0);
    });
  }

  async function processRequest(request) {
    try {
      const result = await host.handleRequest(request);
      writeJson({ id: request.id, type: 'result', result });
      if (request.type === 'shutdown') {
        shuttingDown = true;
        rl.close();
        host.close();
        process.exit(0);
      }
    } catch (error) {
      writeJson({ id: request.id, type: 'error', error: errorPayload(error) });
    }
  }

  function handleLine(line) {
    const raw = String(line || '').trim();
    if (!raw || shuttingDown) return;
    if (!host) {
      bufferedLines.push(raw);
      return;
    }
    let request = null;
    try {
      request = JSON.parse(raw);
    } catch (error) {
      writeJson({ id: null, type: 'error', error: errorPayload(error) });
      return;
    }
    if (request.type === 'agent.cancel' || request.type === 'summary.cancelNode' || request.type === 'summary.generateNode') {
      processRequest(request);
      return;
    }
    queue = queue.then(() => processRequest(request));
    finishIfClosed();
  }

  rl.on('line', handleLine);

  rl.on('close', () => {
    stdinClosed = true;
    finishIfClosed();
  });

  host = createHeadlessAgentHost({
    projectRoot: PROJECT_ROOT,
    fetchers,
    sendEvent: (event) => writeJson(event)
  });
  writeJson({ id: null, type: 'ready', pid: process.pid });
  for (const line of bufferedLines.splice(0)) handleLine(line);
  finishIfClosed();
}

main().catch((error) => {
  writeJson({ id: null, type: 'error', error: errorPayload(error) });
  process.exit(1);
});
