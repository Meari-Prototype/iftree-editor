import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, parse } from 'node:path';

import { readSentences } from '../src/core/source-text.js';
import { IftreeStore } from '../src/backend/store/index.js';

const verifyDir = join(tmpdir(), 'iftree-editor-verify');
const dbPath = join(verifyDir, 'verify.sqlite');

const sourceSamples = [
  {
    file: 'sample-alpha.txt',
    text: '第一句用于验证文本导入。\n第二句用于验证节点生成。'
  },
  {
    file: 'sample-beta.txt',
    text: '入口条件成立时继续执行。\n否则记录原因并停止。'
  }
];

rmSync(verifyDir, { recursive: true, force: true });
mkdirSync(verifyDir, { recursive: true });
for (const sample of sourceSamples) {
  writeFileSync(join(verifyDir, sample.file), sample.text, 'utf8');
}

const store = new IftreeStore(dbPath);
store.init();

try {
  const rows: Array<{ file: string; sentences: number; nodes: number; firstAddress: unknown }> = [];

  for (const sample of sourceSamples) {
    const filePath = join(verifyDir, sample.file);
    const sentences = await readSentences(filePath);
    const title = parse(filePath).name.replace(/_sentences$/i, '');
    const doc = store.createDocFromSentences({ title, sourcePath: filePath, sentences });
    const loaded = store.getDoc(doc.id)!;

    rows.push({
      file: basename(filePath),
      sentences: sentences.length,
      nodes: loaded.nodes.length,
      firstAddress: loaded.tree!.children![0]?.children?.[0]?.address || ''
    });
  }

  console.table(rows);
  const docs = store.listDocs() as Array<{ node_count?: unknown }>;
  const totalNodes = docs.reduce((sum: number, doc) => sum + Number(doc.node_count || 0), 0);
  console.log(`Imported ${docs.length} docs into ${dbPath}`);
  console.log(`Total nodes: ${totalNodes}`);
} finally {
  store.close();
}
