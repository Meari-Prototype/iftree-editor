import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const fixturePath = 'generated/IFTreeEditor数据库读写测试样例.md';
export const fixtureTitle = 'IFTreeEditor数据库读写测试样例';

export const alphaOriginalText = 'DBT_ALPHA 的初始文本是 before-alpha-value。修改测试时，可以把 before-alpha-value 改成 after-alpha-value。';
export const alphaChangedText = 'DBT_ALPHA 的初始文本是 after-alpha-value。修改测试时，可以把 before-alpha-value 改成 after-alpha-value。';
export const modifyOriginalText = 'DBT_DIFF_MODIFY 的原始正文是 old-diff-text。执行编辑分支测试时，把 old-diff-text 改成 new-diff-text，然后打开 diff 视图，应看到同地址修改。';
export const modifyChangedText = 'DBT_DIFF_MODIFY 的原始正文是 new-diff-text。执行编辑分支测试时，把 old-diff-text 改成 new-diff-text，然后打开 diff 视图，应看到同地址修改。';
export const restoredDeleteText = 'DBT_DIFF_DELETE_TARGET 是删除测试节点。执行删除测试后，diff 视图应在左侧显示删除、右侧显示缺失。';

// db 契约测试经 node 跑 scripts/db.mjs（headless 解耦：后端是 node ABI；原经 electron-as-node 跑、
// host 会因 electron ABI 加载 node ABI 的 better-sqlite3 而崩，故反转用 node、host 继承 node runtime）。
export async function runDb(dbPath, args, options = {}) {
  const env = {
    ...process.env,
    IFTREE_DB: dbPath,
    // 默认隔离 IFTREE_HOME：否则关键词/向量索引会落在用户真实 ~/.iftree 的
    // LanceDB 大库上，import 被拖到分钟级并污染真实数据
    IFTREE_HOME: options.homePath || isolatedHomeForDb(dbPath)
  };
  try {
    const result = await execFileAsync(process.execPath, ['dist/scripts/db.js', ...args], {
      cwd: process.cwd(),
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeout || 60000,
      windowsHide: true
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim()
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: error.code ?? 1,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim()
    };
  }
}

export async function runBashDb(dbPath, args, options = {}) {
  const result = await runDb(dbPath, ['shell', '--', 'db', ...args], options);
  if (options.expectFailure) {
    assert.notEqual(result.exitCode, 0, result.stdout || result.stderr);
    return result;
  }
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.ok(result.stdout, 'bash db should return an agent tool result');
  return JSON.parse(result.stdout);
}

export function stdoutOf(shellResult) {
  assert.equal(shellResult.exitCode, 0, shellResult.stderr || shellResult.stdout);
  return String(shellResult.stdout || '').trim();
}

export function parseJsonStdout(shellResult) {
  return JSON.parse(stdoutOf(shellResult));
}

export async function withTempDb(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-db-contract-'));
  const dbPath = join(dir, 'store.sqlite');
  await writeFile(dbPath, '');
  try {
    return await callback(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function importFixture(dbPath) {
  const imported = parseJsonStdout(await runBashDb(dbPath, ['import', fixturePath, '--mode', 'simple'], { timeout: 120000 }));
  assert.equal(imported.ok, true);
  assert.equal(imported.relativePath, fixturePath);
  assert.equal(imported.title, fixtureTitle);
  assert.equal(imported.nodeCount, 50);
  assert.ok(imported.docId);
  return imported;
}

export function isolatedHomeForDb(dbPath) {
  return join(dirname(dbPath), 'home');
}

export async function importFixtureWithOptions(dbPath, options = {}) {
  const imported = parseJsonStdout(await runBashDb(dbPath, ['import', fixturePath, '--mode', 'simple'], { ...options, timeout: 120000 }));
  assert.equal(imported.ok, true);
  assert.equal(imported.relativePath, fixturePath);
  assert.equal(imported.title, fixtureTitle);
  assert.equal(imported.nodeCount, 50);
  assert.ok(imported.docId);
  return imported;
}

export async function withImportedFixture(callback, options = {}) {
  return withTempDb(async (dbPath) => {
    const commandOptions = options.isolateHome ? { homePath: isolatedHomeForDb(dbPath) } : {};
    const imported = await importFixtureWithOptions(dbPath, commandOptions);
    return callback({ dbPath, docId: imported.docId, imported, commandOptions });
  });
}

export async function beginBranch(dbPath, docId, owner) {
  const result = parseJsonStdout(await runBashDb(dbPath, ['draft', 'new', docId, '--owner', owner]));
  assert.equal(result.changed, true);
  result.branchId = result.branchId ?? result.branch?.id;
  assert.ok(result.branchId);
  return result;
}

export async function editSetText(dbPath, docId, address, text, owner) {
  return parseJsonStdout(await runBashDb(dbPath, [
    'edit',
    docId,
    address,
    '--set',
    'text',
    text,
    '--base',
    docId,
    '--owner',
    owner
  ]));
}

export async function editInsert(dbPath, docId, address, mode, text, owner) {
  return parseJsonStdout(await runBashDb(dbPath, [
    'edit',
    docId,
    address,
    '--insert',
    mode,
    text,
    '--base',
    docId,
    '--owner',
    owner
  ]));
}

export async function editDelete(dbPath, docId, address, owner) {
  return parseJsonStdout(await runBashDb(dbPath, [
    'edit',
    docId,
    address,
    '--delete',
    '--base',
    docId,
    '--owner',
    owner
  ]));
}

export async function commitBranch(dbPath, docId, owner, summary) {
  const result = parseJsonStdout(await runBashDb(dbPath, [
    'commit',
    '--base',
    docId,
    '--owner',
    owner,
    '--summary',
    summary
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.history.summary, summary);
  return result;
}

export async function commitSingleTextChange(dbPath, docId, address, nextText, owner, summary) {
  await beginBranch(dbPath, docId, owner);
  await editSetText(dbPath, docId, address, nextText, owner);
  return commitBranch(dbPath, docId, owner, summary);
}
