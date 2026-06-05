import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractMarkdownImageSources,
  markdownToPlainText,
  parseMarkdownBlocks,
  renderTexMathToText
} from '../src/core/markdown.mjs';

test('parseMarkdownBlocks identifies headings, paragraphs, images, and math blocks', () => {
  const blocks = parseMarkdownBlocks('# 标题\n\n正文 **重点** `code`\n\n![图](assets/a.png)\n\n$$x^2$$');

  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'image', 'math']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[0].text, '标题');
  assert.equal(blocks[2].alt, '图');
  assert.equal(blocks[2].src, 'assets/a.png');
  assert.equal(blocks[3].text, 'x^2');
});

test('parseMarkdownBlocks parses bold and inline code spans', () => {
  const [block] = parseMarkdownBlocks('普通 **加粗** 和 `代码`');

  assert.equal(block.type, 'paragraph');
  assert.deepEqual(block.children, [
    { type: 'text', text: '普通 ' },
    { type: 'strong', text: '加粗' },
    { type: 'text', text: ' 和 ' },
    { type: 'code', text: '代码' }
  ]);
});

test('parseMarkdownBlocks handles multiline math blocks', () => {
  const blocks = parseMarkdownBlocks('Before\n\n$$\na = b + c\nx^2\n$$\n\nAfter');

  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'math', 'paragraph']);
  assert.equal(blocks[1].text, 'a = b + c\nx^2');
});

test('markdownToPlainText removes markdown markers for canvas text', () => {
  const text = markdownToPlainText('# Title\n\nBody **bold** and `code` plus $x^2$.\n\n![Alt](assets/a.png)\n\n$$\na + b\n$$');

  assert.equal(text, 'Title\nBody bold and code plus x².\n[image: Alt]\na + b');
});

test('renderTexMathToText renders common TeX math commands and scripts', () => {
  assert.equal(renderTexMathToText('K(S) = \\sum_{v \\in S} \\kappa(v)'), 'K(S) = ∑_(v ∈ S) κ(v)');
  assert.equal(renderTexMathToText('L = (s_1, s_2, \\dots, s_n)'), 'L = (s₁, s₂, …, sₙ)');
  assert.equal(renderTexMathToText('x(v) = (a(v), d(v), b(v), \\sigma(v))'), 'x(v) = (a(v), d(v), b(v), σ(v))');
});

test('markdownToPlainText renders math instead of preserving raw TeX', () => {
  const text = markdownToPlainText('正文 $K(S) = \\sum_{v \\in S} \\kappa(v)$\n\n$$ L = (s_1, s_2, \\dots, s_n) $$');

  assert.equal(text, '正文 K(S) = ∑_(v ∈ S) κ(v)\nL = (s₁, s₂, …, sₙ)');
});
test('markdownToPlainText can omit image placeholders for canvas layout text', () => {
  const text = markdownToPlainText('Body\n\n![Alt](assets/a.png)\n\nTail', { images: 'omit' });

  assert.equal(text, 'Body\nTail');
});

test('extractMarkdownImageSources returns block and inline image paths once', () => {
  const sources = extractMarkdownImageSources('![Cover](assets/a.png)\n\nBody ![Inline](assets/b.png)\n\n![Again](assets/a.png)');

  assert.deepEqual(sources, ['assets/a.png', 'assets/b.png']);
});
