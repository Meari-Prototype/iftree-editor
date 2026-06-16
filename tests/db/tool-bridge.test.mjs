import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { runBashDb, stdoutOf, withImportedFixture } from './_helpers.mjs';

test('db shell bridge runs local bash commands and external bridge commands reject missing inputs', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const shellResult = stdoutOf(await runBashDb(dbPath, ['shell', 'echo', 'DBT_SHELL_OK']));
    assert.match(shellResult, /DBT_SHELL_OK/);

    const shellMissingCommand = await runBashDb(dbPath, ['shell'], { expectFailure: true });
    assert.match(shellMissingCommand.stderr || shellMissingCommand.stdout, /db shell requires command/);

    const askAgentMissingPrompt = await runBashDb(dbPath, ['ask_agent'], { expectFailure: true });
    assert.match(askAgentMissingPrompt.stderr || askAgentMissingPrompt.stdout, /db ask_agent requires prompt text/);

    const webMissingQuery = await runBashDb(dbPath, ['web'], { expectFailure: true });
    assert.match(webMissingQuery.stderr || webMissingQuery.stdout, /db web search requires query/);

    const vectorsMissingDoc = await runBashDb(dbPath, ['vectors'], { expectFailure: true });
    assert.match(vectorsMissingDoc.stderr || vectorsMissingDoc.stdout, /db vectors requires doc_id/);

    const webLocalhostBlocked = await runBashDb(dbPath, ['web', 'open', 'http://127.0.0.1/', '--limit', '1'], { expectFailure: true });
    assert.match(webLocalhostBlocked.stderr || webLocalhostBlocked.stdout, /web_search open 禁止访问/);

    assert.ok(docId);
  });
});
