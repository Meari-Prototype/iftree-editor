import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonStdout, runBashDb, stdoutOf, withImportedFixture } from './_helpers.mjs';

test('db sql allows read-only SELECT/WITH queries and rejects unsafe or empty queries', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath }) => {
    const countResult = parseJsonStdout(await runBashDb(dbPath, [
      'sql',
      'SELECT COUNT(*) AS count FROM nodes',
      '--limit',
      '5',
      '--json'
    ]));
    assert.equal(countResult.rowCount, 1);
    assert.equal(countResult.rows[0].count, 50);

    // 默认文本渲染（formatSqlResult）：行数头 + 每行 key=val，不再裸 JSON。
    const countText = stdoutOf(await runBashDb(dbPath, ['sql', 'SELECT COUNT(*) AS count FROM nodes']));
    assert.match(countText, /1 行/);
    assert.match(countText, /count=50/);

    // --params：数组对应 ? 占位参数（回显绑定值，不依赖数据形状）。
    // runBashDb 走真 bash 分词，JSON 参数须单引号包裹保住内层双引号。
    const paramsResult = parseJsonStdout(await runBashDb(dbPath, [
      'sql',
      'SELECT ? AS echo',
      '--params',
      '\'["dbt-params-echo"]\'',
      '--json'
    ]));
    assert.equal(paramsResult.rows[0].echo, 'dbt-params-echo');

    const withResult = parseJsonStdout(await runBashDb(dbPath, [
      'sql',
      'WITH node_count AS (SELECT COUNT(*) AS count FROM nodes) SELECT count FROM node_count',
      '--json'
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
