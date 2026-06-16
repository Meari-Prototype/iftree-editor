import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { runBashDb, stdoutOf, withImportedFixture } from './_helpers.mjs';

test('db find and keyword/query aliases search the fixture and reject unsupported modes', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId, commandOptions }) => {
    const scoped = stdoutOf(await runBashDb(dbPath, ['find', 'DBT_SEARCH_ONLY_ONCE', '--scope', docId, '1-1-7', '--limit', '5'], commandOptions));
    // 命中按文档分组：组头出标题一次，组内命中行缩进、省略 doc 标签（projectneed 15-5-1-3）；末尾附统计行。
    const scopedLines = scoped.split(/\r?\n/).filter(Boolean);
    assert.equal(scopedLines.length, 3);
    assert.equal(scopedLines[0], '[IFTreeEditor数据库读写测试样例]');
    // 命中行正文预览按设计截到 30 字（db-shell formatNodeLine：利于挑候选），不再断言全文。
    // 字面检索命中行末尾是命中次数 hit:N（语义检索才是相似度分数），见 docs/reference.md。
    assert.match(scopedLines[1], /^ {2}1-1-7-1 文本 DBT_SEARCH_ONLY_ONCE.*hit:1 upd:/);
    assert.match(scopedLines[2], /^— 命中 1 节点 \/ 1 文档/);

    const allDocs = stdoutOf(await runBashDb(dbPath, ['find', 'DBT_SEARCH_ONLY_ONCE', '--all-docs', '--uuid'], commandOptions));
    // --uuid：组头带 doc:UUID 消歧，命中行在组头之下缩进一格。
    assert.match(allDocs, new RegExp(`\\[doc:${docId} \\| IFTreeEditor数据库读写测试样例\\]`));
    assert.match(allDocs, /\n {2}1-1-7-1 文本 DBT_SEARCH_ONLY_ONCE/);

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

test('read/tree 接受文档标题下钻，未匹配标题报错（resolveDocRef，projectneed 15-5-1-4）', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId, commandOptions }) => {
    // fixture 根标题来自文件名（root_node 标题）；库内标题唯一时用标题即可下钻，无需 UUID。
    const title = 'IFTreeEditor数据库读写测试样例';
    const byTitle = stdoutOf(await runBashDb(dbPath, ['read', title, '1-1-7-1'], commandOptions));
    const byUuid = stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-7-1'], commandOptions));
    assert.equal(byTitle, byUuid);
    assert.match(byTitle, /DBT_SEARCH_ONLY_ONCE/);

    const treeByTitle = stdoutOf(await runBashDb(dbPath, ['tree', title, '--depth', '2'], commandOptions));
    assert.match(treeByTitle, /1-1/);

    // doc: 前缀的 UUID 也接受。
    const byPrefixed = stdoutOf(await runBashDb(dbPath, ['read', `doc:${docId}`, '1-1-7-1'], commandOptions));
    assert.equal(byPrefixed, byUuid);

    // find --scope 同样认标题。
    const scopedByTitle = stdoutOf(await runBashDb(dbPath, ['find', 'DBT_SEARCH_ONLY_ONCE', '--scope', title, '1-1-7'], commandOptions));
    assert.match(scopedByTitle, /DBT_SEARCH_ONLY_ONCE/);

    // 标题未匹配任何文档：报错并提示改用 UUID。
    const missing = await runBashDb(dbPath, ['read', '没有这个标题XYZ', '1-1-7-1'], { ...commandOptions, expectFailure: true });
    assert.match(missing.stderr || missing.stdout, /未找到文档/);
  }, { isolateHome: true });
});

test('db find --folder/--exclude-folder 按 library 文件夹圈定/排除跨文档检索范围（#3 文件夹虚拟文档）', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, commandOptions }) => {
    // fixture 落在 library/generated/ 下。folder 本身即跨文档范围，无需再给 --all-docs。
    const inFolder = stdoutOf(await runBashDb(dbPath, ['find', 'DBT_SEARCH_ONLY_ONCE', '--folder', 'generated'], commandOptions));
    assert.match(inFolder, /DBT_SEARCH_ONLY_ONCE/);
    assert.match(inFolder, /\[IFTreeEditor数据库读写测试样例\]/);

    // 换一个文件夹：fixture 不在其下，落空。
    const otherFolder = stdoutOf(await runBashDb(dbPath, ['find', 'DBT_SEARCH_ONLY_ONCE', '--folder', 'benchmark'], commandOptions));
    assert.doesNotMatch(otherFolder, /DBT_SEARCH_ONLY_ONCE/);

    // 排除 generated 子树：唯一命中被挖掉，落空。
    const excluded = stdoutOf(await runBashDb(dbPath, ['find', 'DBT_SEARCH_ONLY_ONCE', '--exclude-folder', 'generated'], commandOptions));
    assert.doesNotMatch(excluded, /DBT_SEARCH_ONLY_ONCE/);

    // 语义检索的范围过滤暂未接入：folder + --semantic 显式报错而非静默忽略。
    const semanticReject = await runBashDb(dbPath, ['find', '测试', '--folder', 'generated', '--semantic'], { ...commandOptions, expectFailure: true });
    assert.match(semanticReject.stderr || semanticReject.stdout, /只支持字面检索/);

    // --labels（opt-in）：组头标层级、命中行标信任；不加则不输出这些。
    const labeled = stdoutOf(await runBashDb(dbPath, ['find', 'DBT_SEARCH_ONLY_ONCE', '--folder', 'generated', '--labels'], commandOptions));
    assert.match(labeled, /·知识/);
    assert.match(labeled, /trust:/);
    const unlabeled = stdoutOf(await runBashDb(dbPath, ['find', 'DBT_SEARCH_ONLY_ONCE', '--folder', 'generated'], commandOptions));
    assert.doesNotMatch(unlabeled, /·知识/);
    assert.doesNotMatch(unlabeled, /trust:/);

    // 统计行：命中数 / 范围 / 可检索篇数，常驻返回。
    assert.match(unlabeled, /— 命中 \d+ 节点 .*范围内可检索 \d+ 篇/);
  }, { isolateHome: true });
});
