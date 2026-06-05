import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonStdout, runBashDb, withImportedFixture } from './_helpers.mjs';

test('db sql allows read-only SELECT/WITH queries and rejects unsafe or empty queries', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath }) => {
    const countResult = parseJsonStdout(await runBashDb(dbPath, [
      'sql',
      'SELECT COUNT(*) AS count FROM nodes',
      '--limit',
      '5'
    ]));
    assert.equal(countResult.rowCount, 1);
    assert.equal(countResult.rows[0].count, 50);

    const withResult = parseJsonStdout(await runBashDb(dbPath, [
      'sql',
      'WITH node_count AS (SELECT COUNT(*) AS count FROM nodes) SELECT count FROM node_count'
    ]));
    assert.equal(withResult.rows[0].count, 50);

    const missingSql = await runBashDb(dbPath, ['sql'], { expectFailure: true });
    assert.match(missingSql.stderr || missingSql.stdout, /db sql requires a SELECT\/WITH query/);

    const writeSql = await runBashDb(dbPath, ['sql', "UPDATE docs SET title='bad'"], { expectFailure: true });
    assert.match(writeSql.stderr || writeSql.stdout, /debug\.sql query must be read-only/);

    const unknownOption = await runBashDb(dbPath, ['sql', 'SELECT 1', '--unknown'], { expectFailure: true });
    assert.match(unknownOption.stderr || unknownOption.stdout, /Unknown db option: --unknown/);
  });
});
