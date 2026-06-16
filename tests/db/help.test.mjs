import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { runBashDb, stdoutOf, withTempDb } from './_helpers.mjs';

test('db help lists the bash db command surface and unknown commands fail', { timeout: 120000 }, async () => {
  await withTempDb(async (dbPath) => {
    const helpText = stdoutOf(await runBashDb(dbPath, ['help']));
    assert.match(helpText, /db index \[--folder/);
    assert.match(helpText, /db read <doc_id> <address>/);
    assert.match(helpText, /db draft new <doc_id>/);
    assert.match(helpText, /db cherry-pick --history/);
    assert.match(helpText, /db web search <query>/);
    assert.match(helpText, /db web open <url>/);

    const unknown = await runBashDb(dbPath, ['not_a_db_command'], { expectFailure: true });
    assert.match(unknown.stderr || unknown.stdout, /Unknown db command: not_a_db_command/);
  });
});
