import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alphaChangedText,
  alphaOriginalText,
  commitSingleTextChange,
  modifyChangedText,
  modifyOriginalText,
  parseJsonStdout,
  runBashDb,
  stdoutOf,
  withImportedFixture
} from './_helpers.mjs';

// read 档动词的断言集中在这里：read 重构后只回正文(scope)，元信息/出处/引用/事实归 inspect、
// 原文窗口归 article、历史版本走 at 坐标。旧 --node/--meta/--source/--blame/--links/--axioms/--neighbors
// 兼容别名已删除（一套实现）。文件末尾有「全动词批量冒烟」入口，一次过一遍 read 档所有动词。

test('read：只回正文，scope=node/subtree/siblings 与 at 坐标，不带节点头', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    // 默认 subtree：整棵子树正文拼接
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1'])), alphaOriginalText);
    assert.match(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3'])), /DBT_ALPHA 的初始文本是 before-alpha-value/);

    // scope=node：只本节点正文，不含子节点；read 只回正文、不带身份头
    const nodeOnly = stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3', '--range', 'node']));
    assert.match(nodeOnly, /基础层级与稳定定位/);
    assert.doesNotMatch(nodeOnly, /DBT_ALPHA/);
    assert.doesNotMatch(nodeOnly, /trust:|\[doc/);

    // scope=siblings：同父前/中/后三条，轻量导航标、纯正文、不重复
    const siblings = stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1', '--range', 'siblings']));
    assert.match(siblings, /〈target 1-1-3-2-1〉/);
    assert.match(siblings, /〈next 1-1-3-2-2〉/);
    assert.match(siblings, /before-alpha-value/);

    // at 历史坐标：先改两次（C1=changed、C2=回到 original），读 --at C1 应得改动版、读当前应得 original
    const c1 = await commitSingleTextChange(dbPath, docId, '1-1-6-1-1', modifyChangedText, 'dbt-at-1', 'DBT_AT_1');
    await commitSingleTextChange(dbPath, docId, '1-1-6-1-1', modifyOriginalText, 'dbt-at-2', 'DBT_AT_2');
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1'])), modifyOriginalText);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1', '--at', String(c1.history.commit_id)])), modifyChangedText);

    // 错误路径：缺地址、地址不存在
    const missingArgs = await runBashDb(dbPath, ['read', docId], { expectFailure: true });
    assert.match(missingArgs.stderr || missingArgs.stdout, /db read requires <address> 或 --node-id <uuid>/);
    const missingTarget = await runBashDb(dbPath, ['read', docId, '9-9-9'], { expectFailure: true });
    assert.match(missingTarget.stderr || missingTarget.stdout, new RegExp(`db read target not found: doc ${docId} 9-9-9`));
  });
});

test('inspect：身份段 + meta/source/links/axioms 选段（吸收旧 read 镜头）', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    // 默认 meta+note：身份行 + [meta]（updated/created/sort/chars/hash 真元信息）
    const meta = stdoutOf(await runBashDb(dbPath, ['inspect', docId, '1-1-3-2-1']));
    assert.match(meta, /\[IFTreeEditor数据库读写测试样例 1-1-3-2-1 文本 trust:null/);
    // content_hash 在 simple 导入后未算（hash:null），经 commit/merkle 才有十六进制值——两者都接受。
    assert.match(meta, /\[meta\] updated:.+created:.+sort:1 chars:86 hash:\S+/);

    // --sections source：原文出处 + 该节点 source spans（原 blame）
    const source = stdoutOf(await runBashDb(dbPath, ['inspect', docId, '1-1-3-2-1', '--sections', 'source']));
    assert.match(source, /source: md .*IFTreeEditor数据库读写测试样例\.md/);
    assert.match(source, /\[source_spans\]/);
    assert.match(source, /offsets:338-374/);

    // --sections links / axioms：结构标记常驻（fixture 无 ref/axiom 时为 (无)）
    assert.match(stdoutOf(await runBashDb(dbPath, ['inspect', docId, '1-1-3-2-1', '--sections', 'links'])), /\[links\]/);
    assert.match(stdoutOf(await runBashDb(dbPath, ['inspect', docId, '1', '--sections', 'axioms'])), /\[axioms\]/);

    const missingArgs = await runBashDb(dbPath, ['inspect', docId], { expectFailure: true });
    assert.match(missingArgs.stderr || missingArgs.stdout, /db inspect requires <address> 或 --node-id <uuid>/);
  });
});

test('article：导入原件原文窗口，按字符偏移，可附 source spans', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    // 从文档开头取窗口：窗口头 + [原文开始] + 原始 markdown（含 # 标题、解析前的标记）
    const head = stdoutOf(await runBashDb(dbPath, ['article', docId, '--limit', '500']));
    assert.match(head, /\[原文窗口 offset 0-/);
    assert.match(head, /\[原文开始\]/);
    assert.match(head, /# IFTreeEditor 数据库读写测试样例/);

    // --json：结构化 window 字段（startOffset/endOffset/totalLength/hasBefore/hasAfter）
    const headJson = parseJsonStdout(await runBashDb(dbPath, ['article', docId, '--limit', '400', '--json']));
    assert.ok(headJson.window, 'article --json 应含 window 对象');
    assert.equal(headJson.window.startOffset, 0);
    assert.ok(headJson.window.endOffset > 0, 'endOffset 应 > 0');
    assert.ok(headJson.window.totalLength > 0, 'totalLength 应 > 0');
    assert.equal(typeof headJson.text, 'string');
    assert.ok(headJson.text.length > 0);

    // --spans：附 source spans 紧凑行（默认上限 30，截断标「窗口共 N」）
    const withSpans = stdoutOf(await runBashDb(dbPath, ['article', docId, '--spans']));
    assert.match(withSpans, /\[source spans \d+/);
    assert.match(withSpans, /span:\d+ s\d+ \d+-\d+/);

    // 按节点地址锚定窗口
    assert.match(stdoutOf(await runBashDb(dbPath, ['article', docId, '1-1-7-2'])), /DBT_CONTEXT/);

    const missingDoc = await runBashDb(dbPath, ['article'], { expectFailure: true });
    assert.match(missingDoc.stderr || missingDoc.stdout, /db article requires <doc_id>/);
  });
});

// 批量入口：导一次 fixture，依次过一遍 read 档所有动词，确认各自响应且输出形态正确。
// 一处即可看出「重构后整组读动词是否还能跑」，新增/改动读动词时在此加一行即可。
test('read 档全动词批量冒烟', { timeout: 240000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId, commandOptions }) => {
    const commit = await commitSingleTextChange(dbPath, docId, '1-1-3-2-1', alphaChangedText, 'dbt-smoke', 'DBT_SMOKE');
    const commitRef = String(commit.history.commit_id);
    /** @type {Array<[string | string[], RegExp]>} */
    const calls = [
      ['index', /IFTreeEditor数据库读写测试样例/],
      [['tree', docId], /1-1 文本/],
      [['tree', docId, '--at', commitRef], /历史快照/],
      [['read', docId, '1-1-3-2-1'], /after-alpha-value/],
      [['read', docId, '1-1-3', '--range', 'node'], /基础层级与稳定定位/],
      [['read', docId, '1-1-3-2-1', '--range', 'siblings'], /〈target 1-1-3-2-1〉/],
      [['inspect', docId, '1-1-3-2-1'], /\[meta\]/],
      [['inspect', docId, '1-1-3-2-1', '--sections', 'source'], /\[source_spans\]/],
      [['article', docId, '--limit', '400'], /\[原文窗口/],
      [['article', docId, '--spans'], /\[source spans/],
      [['find', 'DBT_SEARCH_ONLY_ONCE', '--scope', docId, '1-1-7'], /1-1-7-1/],
      [['find', 'DBT_DIFF_MODIFY', '--scope', docId, '1', '--at', commitRef], /历史命中/],
      [['log', docId], /commit:/],
      [['diff', docId, commitRef], /改/],
      [['sql', 'SELECT COUNT(*) AS n FROM nodes'], /"n"/]
    ];
    for (const [argv, must] of calls) {
      const normalized = Array.isArray(argv) ? argv : [argv];
      const out = stdoutOf(await runBashDb(dbPath, normalized, commandOptions));
      assert.ok(out.length > 0, `动词无输出: ${normalized.join(' ')}`);
      assert.match(out, must, `动词输出不符: ${normalized.join(' ')}`);
    }
  }, { isolateHome: true });
});
