import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSourceDocument,
  buildMarkdownStructureRecords,
  parseSourceMarkdownBlocks,
  sourceSpansFromMarkdown
} from '../src/core/source-markdown.mjs';

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
  assert.equal(source.spans.length, 8);
  assert.deepEqual(source.spans.map((span) => span.sentence_index), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const span of source.spans) {
    assert.equal(source.rawMarkdown.slice(span.start_offset, span.end_offset), span.text);
  }
  assert.deepEqual(source.spans.map((span) => span.text), [
    'Title',
    'First sentence.',
    'Second sentence!',
    '| Name | Note |',
    '| --- | --- |',
    '| A | Table sentence one.',
    'Table sentence two!',
    '|'
  ]);
});

test('parseSourceMarkdownBlocks preserves current pipe-table line structure', () => {
  const rawMarkdown = [
    'Paragraph one. Paragraph two.',
    '',
    '| Name | Note |',
    '| --- | --- |',
    '| A | Table sentence one. Table sentence two! |'
  ].join('\n');

  const blocks = parseSourceMarkdownBlocks(rawMarkdown);

  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'heading', 'heading', 'paragraph']);
  assert.equal(blocks[0].lines.length, 1);
  assert.equal(blocks[1].text, '| Name | Note |');
  assert.equal(blocks[2].text, '| --- | --- |');
  assert.equal(blocks[3].lines.length, 1);
});

test('source spans keep soft-wrapped lines as separate sentence spans', () => {
  const rawMarkdown = [
    '# Title',
    '',
    'Soft wrapped',
    'sentence still one. Next sentence.'
  ].join('\n');

  const source = buildSourceDocument({ rawMarkdown });

  assert.deepEqual(source.spans.map((span) => span.text), [
    'Title',
    'Soft wrapped',
    'sentence still one.',
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

  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'math', 'image', 'heading', 'heading', 'paragraph']);
  assert.deepEqual(source.spans.map((span) => span.text), [
    'Lead paragraph before math continues',
    '\\mu(v) \\propto |T_v|',
    '| Item | Note |',
    '| --- | --- |',
    '| A | Table sentence one.',
    'Table sentence two!',
    '|'
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
