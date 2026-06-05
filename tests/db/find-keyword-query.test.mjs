import assert from 'node:assert/strict';
import test from 'node:test';

import { runBashDb, stdoutOf, withImportedFixture } from './_helpers.mjs';

test('db find and keyword/query aliases search the fixture and reject unsupported modes', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId, commandOptions }) => {
    const scoped = stdoutOf(await runBashDb(dbPath, ['find', 'DBT_SEARCH_ONLY_ONCE', '--scope', docId, '1-1-7', '--limit', '5'], commandOptions));
    assert.deepEqual(scoped.split(/\r?\n/).filter(Boolean), [
      'IFTreeEditor数据库读写测试样例 1-1-7-1 文本 DBT_SEARCH_ONLY_ONCE 这个关键词在全文中只出现一次，用于验证精确 keyword search 的返回数量。 1.00'
    ]);

    const allDocs = stdoutOf(await runBashDb(dbPath, ['find', 'DBT_SEARCH_ONLY_ONCE', '--all-docs', '--uuid'], commandOptions));
    assert.match(allDocs, new RegExp(`doc:${docId} 1-1-7-1 文本 DBT_SEARCH_ONLY_ONCE`));

    const keywordAlias = stdoutOf(await runBashDb(dbPath, ['keyword', 'DBT_SEARCH_ONLY_ONCE', '--scope', docId, '1-1-7'], commandOptions));
    assert.match(keywordAlias, /DBT_SEARCH_ONLY_ONCE/);

    const missingTerm = await runBashDb(dbPath, ['find'], { ...commandOptions, expectFailure: true });
    assert.match(missingTerm.stderr || missingTerm.stdout, /db find requires at least one term/);

    const orFind = await runBashDb(dbPath, ['find', 'DBT_ALPHA', '--or', '--all-docs'], { ...commandOptions, expectFailure: true });
    assert.match(orFind.stderr || orFind.stdout, /db find --or is not supported/);

    const fuzzyFind = await runBashDb(dbPath, ['find', 'DBT_ALPHA', '--fuzzy'], { ...commandOptions, expectFailure: true });
    assert.match(fuzzyFind.stderr || fuzzyFind.stdout, /db find --fuzzy is not supported/);

    const emptySemanticAlias = await runBashDb(dbPath, ['query'], { ...commandOptions, expectFailure: true });
    assert.match(emptySemanticAlias.stderr || emptySemanticAlias.stdout, /db find --semantic requires natural language text/);
  }, { isolateHome: true });
});
