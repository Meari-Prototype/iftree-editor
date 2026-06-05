import assert from 'node:assert/strict';
import test from 'node:test';

import { alphaOriginalText, runBashDb, stdoutOf, withImportedFixture } from './_helpers.mjs';

test('db read returns text, metadata, source, blame, and lens data, and rejects missing targets', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1'])), alphaOriginalText);

    const nodeMetaText = stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1', '--node', '--meta', '--uuid']));
    assert.match(nodeMetaText, new RegExp(`\\[doc:${docId} 1-1-3-2-1 文本 trust:null \\(86\\)\\]`));
    assert.match(nodeMetaText, /before-alpha-value/);

    const subtreeText = stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3', '--meta', '--limit', '500']));
    assert.match(subtreeText, /1-1-3 文本 trust:null/);
    assert.match(subtreeText, /DBT_ALPHA 的初始文本是 before-alpha-value/);

    const sourceText = stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1', '--source', '--limit', '500']));
    assert.match(sourceText, /# IFTreeEditor 数据库读写测试样例/);
    assert.match(sourceText, /DBT_ALPHA 的初始文本是 before-alpha-value/);

    const blameText = stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1', '--blame']));
    assert.match(blameText, /source: md .*IFTreeEditor数据库读写测试样例\.md/);
    assert.match(blameText, /\[source_spans\]/);
    assert.match(blameText, /offsets:338-374/);

    const lensText = stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1', '--axioms', '--links']));
    assert.match(lensText, /\[axioms\]/);
    assert.match(lensText, /\[links\]/);

    const neighborsText = stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-7-2', '--neighbors', '--node']));
    assert.match(neighborsText, /\[previous 1-1-7-1 文本 DBT_SEARCH_ONLY_ONCE/);
    assert.match(neighborsText, /\[target 1-1-7-2 文本 DBT_CONTEXT_LEFT/);
    assert.match(neighborsText, /\[next 1-1-7-3 文本 如果 source\.getWindow/);

    const missingRead = await runBashDb(dbPath, ['read', docId, '9-9-9'], { expectFailure: true });
    assert.match(missingRead.stderr || missingRead.stdout, new RegExp(`db read target not found: doc ${docId} 9-9-9`));

    const missingArgs = await runBashDb(dbPath, ['read', docId], { expectFailure: true });
    assert.match(missingArgs.stderr || missingArgs.stdout, /db read requires <doc_id> <address>/);
  });
});
