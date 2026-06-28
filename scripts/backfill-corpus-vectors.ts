// 临时后台脚本：给已导入文档补建语义向量（嵌入后端由 .env 决定，这里走 ollama bge-m3）。
// 自己当一个「无超时」client，复用/拉起共享后端发 vector.ensureDoc，跑完只关闭连接。
//
// 用法（普通 node 跑本脚本即可；共享后端会使用项目解析到的 Node runtime）：
//   node scripts/backfill-corpus-vectors.mjs --missing
//   node scripts/backfill-corpus-vectors.mjs [docId]
//
// 注意：补向量是长任务；运行期间最好不要同时发起其它大规模导入/删除/向量维护。
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackendClient } from '../src/backend/llm/backend-client.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hostScriptPath = join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js');
const args = process.argv.slice(2);
const missingMode = args.includes('--missing') || args.includes('--all-missing');
const docId = args.find((arg) => !arg.startsWith('--')) || '019e8e89-e1b6-72eb-b5d7-3fdc239b6e86';

const client = createBackendClient({
  projectRoot: PROJECT_ROOT,
  hostScriptPath,
  onStatus: (text) => process.stderr.write(String(text || '')),
  onStderr: (text) => process.stderr.write(String(text || ''))
});

const startedAt = Date.now();
const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(0);
let lastLog = 0;

console.log(`[backfill] host=${hostScriptPath}`);
console.log(`[backfill] embed backend=${process.env.IFTREE_EMBED_BACKEND || '(default)'}`);
console.log(`[backfill] embed model=${process.env.IFTREE_EMBED_MODEL || '(default)'}`);
console.log(`[backfill] embed baseUrl=${process.env.IFTREE_EMBED_BASE_URL || '(default)'}`);
console.log(`[backfill] embed batch=${process.env.IFTREE_EMBED_BATCH || '(default)'}`);
console.log(`[backfill] embed fallback=${process.env.IFTREE_EMBED_FALLBACK || '(default)'}`);
console.log(`[backfill] ollama parallel=${process.env.OLLAMA_NUM_PARALLEL || '(server default)'}`);

async function finish(code: number) {
  try { client.close(); } catch { /* 兜底 kill */ }
  process.exit(code);
}

function parseMissingDocIds(indexText: unknown) {
  const docs: { docId: string; line: string }[] = [];
  for (const rawLine of String(indexText || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.includes('[semantic:missing')) continue;
    const match = line.match(/#([0-9a-fA-F-]{36})\b/);
    if (!match) continue;
    docs.push({ docId: match[1], line: line.trim() });
  }
  return docs;
}

async function ensureDoc(docIdToEnsure: string, label = '') {
  lastLog = 0;
  console.log(`[backfill] start docId=${docIdToEnsure}${label ? ` ${label}` : ''}`);
  const result = await client.request('vector.ensureDoc', { payload: { docId: docIdToEnsure } }, {
    onEvent: (event: unknown) => {
      const now = Date.now();
      if (now - lastLog > 5000) {
        lastLog = now;
        console.log(`[backfill ${elapsed()}s] ${JSON.stringify(event)}`);
      }
    }
  });
  console.log(`[backfill] DONE docId=${docIdToEnsure} result=${JSON.stringify(result)}`);
  return result;
}

try {
  if (missingMode) {
    console.log('[backfill] scan library semantic status...');
    const indexResult = await client.request('db.shell', {
      argv: ['index', '--uuid']
    }) as { text?: unknown };
    const docs = parseMissingDocIds(indexResult?.text);
    console.log(`[backfill] missing docs=${docs.length}`);
    docs.forEach((doc, index) => console.log(`[backfill] queue ${index + 1}/${docs.length} ${doc.docId} ${doc.line}`));
    let ok = 0;
    let failed = 0;
    for (const [index, doc] of docs.entries()) {
      try {
        await ensureDoc(doc.docId, `(${index + 1}/${docs.length})`);
        ok += 1;
      } catch (error: unknown) {
        failed += 1;
        console.error(`[backfill] FAILED docId=${doc.docId} ${(error as { stack?: string; message?: string } | null | undefined)?.stack || (error as { message?: string } | null | undefined)?.message || error}`);
      }
    }
    console.log(`[backfill] SUMMARY in ${elapsed()}s total=${docs.length} ok=${ok} failed=${failed}`);
    await finish(failed > 0 ? 1 : 0);
  } else {
    await ensureDoc(docId);
    console.log(`[backfill] SUMMARY in ${elapsed()}s total=1 ok=1 failed=0`);
    await finish(0);
  }
} catch (err: unknown) {
  console.error(`[backfill] FAILED in ${elapsed()}s ${(err as { stack?: string } | null | undefined)?.stack || (err as { message?: string } | null | undefined)?.message || err}`);
  await finish(1);
}
