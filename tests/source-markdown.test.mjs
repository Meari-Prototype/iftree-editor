import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSourceDocument,
  buildMarkdownStructureRecords,
  parseSourceMarkdownBlocks,
  sourceSpansFromMarkdown
} from '../dist/src/core/source-markdown.js';

test('buildSourceDocument keeps raw markdown and emits offset sentence spans', () => {
  const rawMarkdown = [
    '# Title',
    '',
    'First sentence. Second sentence!',
    '',
    '| Name | Note |',
    '| --- | --- |',
    '| A | Table sentence one. Table sentence two! |',
    ''
  ].join('\n');

  const source = buildSourceDocument({
    sourcePath: 'sample.md',
    sourceType: 'md',
    rawMarkdown
  });

  assert.equal(source.rawMarkdown, rawMarkdown);
  assert.equal(source.spans.length, 6);
  assert.deepEqual(source.spans.map((span) => span.sentence_index), [1, 2, 3, 4, 5, 6]);
  for (const span of source.spans) {
    assert.equal(source.rawMarkdown.slice(span.start_offset, span.end_offset), span.text);
  }
  // 表格收敛成结构块：header / 分隔行不产 span，只数据 cell 的句子产 span（9913f72 导入收敛）。
  assert.deepEqual(source.spans.map((span) => span.text), [
    'Title',
    'First sentence.',
    'Second sentence!',
    'A',
    'Table sentence one.',
    'Table sentence two!'
  ]);
});

test('parseSourceMarkdownBlocks collapses a pipe-table into one table block', () => {
  const rawMarkdown = [
    'Paragraph one. Paragraph two.',
    '',
    '| Name | Note |',
    '| --- | --- |',
    '| A | Table sentence one. Table sentence two! |'
  ].join('\n');

  const blocks = parseSourceMarkdownBlocks(rawMarkdown);

  // pipe-table 收敛成一个 table 结构块，不再把表格各行当独立 heading / paragraph（9913f72 导入收敛）。
  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'table']);
  assert.equal(blocks[0].lines.length, 1);
});

test('source spans merge soft-wrapped lines into the same sentence span', () => {
  const rawMarkdown = [
    '# Title',
    '',
    'Soft wrapped',
    'sentence still one. Next sentence.'
  ].join('\n');

  const source = buildSourceDocument({ rawMarkdown });

  // 段落内软换行（单换行）按 CommonMark 算同一句的延续、跨行成句；只有显式 hardLineBreaks 才按行断。
  assert.deepEqual(source.spans.map((span) => span.text), [
    'Title',
    'Soft wrapped\nsentence still one.',
    'Next sentence.'
  ]);
});

test('sourceSpansFromMarkdown can keep hard line breaks for pdf text layers', () => {
  const spans = sourceSpansFromMarkdown('Line one\nLine two.', { hardLineBreaks: true });

  assert.deepEqual(spans.map((span) => span.text), ['Line one', 'Line two.']);
});

test('parseSourceMarkdownBlocks keeps math, images, and tables out of plain paragraphs', () => {
  const rawMarkdown = [
    'Lead paragraph before math continues',
    '$$',
    '\\mu(v) \\propto |T_v|',
    '$$',
    '',
    '![Diagram](assets/diagram.png)',
    '',
    '| Item | Note |',
    '| --- | --- |',
    '| A | Table sentence one. Table sentence two! |'
  ].join('\n');

  const blocks = parseSourceMarkdownBlocks(rawMarkdown);
  const source = buildSourceDocument({ rawMarkdown });
  const records = buildMarkdownStructureRecords(source);

  // math / image / table 各自独立成块、不混进正文段；表格收敛成一个 table 结构块。
  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'math', 'image', 'table']);
  assert.deepEqual(source.spans.map((span) => span.text), [
    'Lead paragraph before math continues',
    '\\mu(v) \\propto |T_v|',
    'A',
    'Table sentence one.',
    'Table sentence two!'
  ]);
  assert.equal(records.some((record) => record.role === 'media' && record.text.includes('assets/diagram.png')), true);
});

test('parseSourceMarkdownBlocks treats html tables as table blocks', () => {
  const rawMarkdown = [
    '<table><tr><td>$$ </td><td>--------</td><td>HTML table sentence. Next.</td></tr></table>',
    '',
    'After table.'
  ].join('\n');

  const blocks = parseSourceMarkdownBlocks(rawMarkdown);
  const source = buildSourceDocument({ rawMarkdown });

  assert.deepEqual(blocks.map((block) => block.type), ['html_table', 'paragraph']);
  assert.deepEqual(source.spans.map((span) => span.text), [
    'HTML table sentence.',
    'Next.',
    'After table.'
  ]);
});

test('buildMarkdownStructureRecords groups markdown into headings, paragraphs, and sentence leaves', () => {
  const rawMarkdown = [
    '# Chapter One',
    '',
    'First sentence. Second sentence!',
    'Third sentence?',
    '',
    '## 1.1 Sub Chapter',
    'Fourth sentence.'
  ].join('\n');
  const source = buildSourceDocument({ sourcePath: 'sample.md', sourceType: 'md', rawMarkdown });

  const records = buildMarkdownStructureRecords(source);

  // Lines with no blank separator share one paragraph block (per-block grouping).
  // "Third sentence?" immediately follows "First sentence. Second sentence!" with no
  // blank line, so all three sentences share paragraph 1-1.
  assert.deepEqual(records.map((record) => ({
    address: record.address,
    text: record.text,
    index: record.index ?? null,
    role: record.role,
    skipVector: record.skipVector === true,
    sourcePosition: record.sourcePosition ?? null
  })), [
    { address: '1', text: 'Chapter One', index: 1, role: 'heading', skipVector: false, sourcePosition: 1 },
    { address: '1-1', text: '', index: 2, role: 'paragraph', skipVector: true, sourcePosition: 1.5 },
    { address: '1-1-1', text: 'First sentence.', index: 2, role: 'sentence', skipVector: false, sourcePosition: 2 },
    { address: '1-1-2', text: 'Second sentence!', index: 3, role: 'sentence', skipVector: false, sourcePosition: 3 },
    { address: '1-1-3', text: 'Third sentence?', index: 4, role: 'sentence', skipVector: false, sourcePosition: 4 },
    { address: '1-2', text: '1.1 Sub Chapter', index: 5, role: 'heading', skipVector: false, sourcePosition: 5 },
    { address: '1-2-1', text: '', index: 6, role: 'paragraph', skipVector: true, sourcePosition: 5.5 },
    { address: '1-2-1-1', text: 'Fourth sentence.', index: 6, role: 'sentence', skipVector: false, sourcePosition: 6 }
  ]);
});

import { bodyCharCount } from '../dist/src/core/char-count.js';

test('bodyCharCount 忽略全部空白（空格/制表/换行/全角空格）', () => {
  assert.equal(bodyCharCount('a b\tc\nd　e'), 5); // 　为全角空格 U+3000
  assert.equal(bodyCharCount(''), 0);
  assert.equal(bodyCharCount(null), 0);
  assert.equal(bodyCharCount(undefined), 0);
  assert.equal(bodyCharCount('  \n\t　 '), 0);
});

test('切分粒度（paragraph/sentence）不影响正文字数：忽略空白口径下两种 mode 字数一致', () => {
  // 句间用空格/换行分隔，paragraph 模式整段 slice 会保留这些空白、sentence 模式逐句 trim 会丢弃。
  // 按 bodyCharCount（忽略空白）计数，两种 mode 的正文字数必须相等——这是「切分不该改变字数」的不变量。
  const rawMarkdown = [
    '# 标题',
    '',
    '第一句。  第二句！  第三句？',
    '还有换行后的一句。',
    '',
    '第二段第一句。第二段第二句。',
    '',
    '# 第二标题 ABC def',
    '',
    '末段唯一句无句号结尾'
  ].join('\n');
  const source = buildSourceDocument({ rawMarkdown });
  const sumBody = (recs) => recs.reduce((n, r) => n + bodyCharCount(r.text), 0);
  const para = buildMarkdownStructureRecords(source, { granularity: 'paragraph' });
  const sent = buildMarkdownStructureRecords(source, { granularity: 'sentence' });
  // 旧口径（含空白）下 para > sent（差即句间空白）；新口径下必须相等。
  assert.equal(sumBody(para), sumBody(sent), 'paragraph 与 sentence 模式的忽略空白字数应相等');
  assert.ok(sumBody(para) > 0, '字数应为正');
});
