// 公共切句模块——把一段文本切成句子，返回每句 + 段内起止偏移。
//
// 设计（见「切句 / 坐标公共化」重构）：切句是纯文本规则、和坐标正交。这里只管「在这段文本里，
// 句子边界在哪、公式块在哪」，返回相对输入文本的偏移；要不要把偏移换算成源文 / 载体坐标
// （选区高亮）是调用方的事。完整导入、智能导入、docx / epub / chm 共用这一份切句规则。
//
// 规则取完整导入原有的精细字符状态机：
// - inline code（反引号）、inline math（单 $）成对跳过，里面的标点不断句；
// - 中括号 / 圆括号深度内的 ASCII 句点不误断（链接 / 函数签名）；
// - ASCII 句点对缩写（U.S.）、小数（3.14）、省略号（...）不误断；
// - 吞掉句末右引号 / 右括号，让它们跟着上一句。
// 在此之上并入：块级公式（$$...$$ / \[...\]，成对定界符、非裸括号）整块当一个单元、不切。

const CJK_ENDINGS = '。！？';
const ASCII_ENDINGS = '!?.';
const CLOSING_PUNCT = /["'”’）」】》〉〕］）]/u;
const IGNORABLE_SPAN = /^[-_:| ]{3,}$/;
// 块级公式定界符：[开, 闭]。$$ 开闭同符，\[ 配 \]。
const MATH_DELIMITERS: [string, string][] = [['$$', '$$'], ['\\[', '\\]']];

interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

interface SentenceSplitOptions {
  splitAsciiPunctuation?: boolean;
  hardLineBreaks?: boolean;
}

// 核心：返回 [{ text, start, end }]，start / end 是相对输入 text 的字符偏移。
export function splitSentenceSpans(text: unknown, options: SentenceSplitOptions = {}): SentenceSpan[] {
  const source = String(text ?? '');
  const range = trimRange(source, 0, source.length);
  if (!range) return [];
  // 默认只认全角句末（。！？）；splitAsciiPunctuation 时并入 ASCII 的 .!?（配合缩写 / 小数 / 域名 / 括号过滤）。
  const endings = options.splitAsciiPunctuation === true ? CJK_ENDINGS + ASCII_ENDINGS : CJK_ENDINGS;
  const result: SentenceSpan[] = [];
  let sentenceStart = range.start;
  let inlineMath = false;
  let codeTicks = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = range.start; index < range.end; index += 1) {
    const char = source[index];

    // 块级公式整块：先把前面攒的内容收成一句，公式块自己单独成一句。
    if (codeTicks === 0 && !inlineMath && (char === '$' || char === '\\')) {
      const mathEnd = readBlockMathEnd(source, index, range.end);
      if (mathEnd > index) {
        pushSentence(sentenceStart, index);
        pushSentence(index, mathEnd);
        sentenceStart = mathEnd;
        index = mathEnd - 1;
        bracketDepth = 0;
        parenDepth = 0;
        continue;
      }
    }

    // inline code（反引号成对）
    if (char === '`' && !inlineMath) {
      const tickEnd = readRepeated(source, index, '`');
      const tickCount = tickEnd - index;
      if (codeTicks === 0) codeTicks = tickCount;
      else if (tickCount >= codeTicks) codeTicks = 0;
      index = tickEnd - 1;
      continue;
    }

    // inline math（单 $ 成对）
    if (codeTicks === 0 && char === '$') {
      const dollarEnd = readRepeated(source, index, '$');
      if (dollarEnd - index === 1) inlineMath = !inlineMath;
      index = dollarEnd - 1;
      continue;
    }

    if (codeTicks !== 0 || inlineMath) continue;

    if (options.hardLineBreaks === true && char === '\n') {
      pushSentence(sentenceStart, index);
      sentenceStart = index + 1;
      continue;
    }

    if (char === '[') bracketDepth += 1;
    else if (char === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (char === '(') parenDepth += 1;
    else if (char === ')' && parenDepth > 0) parenDepth -= 1;

    if (!isSentenceEnding(source, index, bracketDepth, parenDepth, endings)) continue;

    const closeEnd = consumeClosingPunctuation(source, index + 1, range.end);
    pushSentence(sentenceStart, closeEnd);
    sentenceStart = closeEnd;
    index = closeEnd - 1;
  }
  pushSentence(sentenceStart, range.end);
  return result;

  function pushSentence(partStart: number, partEnd: number) {
    const part = trimRange(source, partStart, partEnd);
    if (!part) return;
    const sentenceText = source.slice(part.start, part.end);
    if (isIgnorableSpanText(sentenceText)) return;
    result.push({ text: sentenceText, start: part.start, end: part.end });
  }
}

// 薄壳：只要句子字符串、丢偏移——给不需要坐标的调用方。
export function splitSentences(text: unknown, options: SentenceSplitOptions = {}): string[] {
  return splitSentenceSpans(text, options).map((part) => part.text);
}

// 块级公式判定（成对定界符 $$ / \[，非裸括号）——共享给各导入器，消除多份前缀拷贝。
export function isBlockMath(text: unknown): boolean {
  const trimmed = String(text ?? '').trim();
  return trimmed.startsWith('$$') || trimmed.startsWith('\\[');
}

// 若 index 处是块级公式开定界符，返回公式块结束位置（含闭定界符）；否则返回 index（无进展）。
function readBlockMathEnd(text: string, index: number, end: number): number {
  for (const [open, close] of MATH_DELIMITERS) {
    if (!text.startsWith(open, index)) continue;
    const closeAt = text.indexOf(close, index + open.length);
    return closeAt >= 0 ? Math.min(end, closeAt + close.length) : end; // 无闭则吃到段尾
  }
  return index;
}

function trimRange(text: string, start: number, end: number): { start: number; end: number } | null {
  let left = Math.max(0, start);
  let right = Math.min(text.length, end);
  while (left < right && /\s/.test(text[left])) left += 1;
  while (right > left && /\s/.test(text[right - 1])) right -= 1;
  return right > left ? { start: left, end: right } : null;
}

function readRepeated(text: string, start: number, char: string): number {
  let index = start;
  while (index < text.length && text[index] === char) index += 1;
  return index;
}

function isSentenceEnding(text: string, index: number, bracketDepth: number, parenDepth: number, endings: string): boolean {
  const char = text[index];
  if (!endings.includes(char)) return false;
  if (char === '.' && isInternalAsciiDot(text, index)) return false;
  if ((bracketDepth > 0 || parenDepth > 0) && char === '.') return false;
  if (char === '.' && text[index + 1] === '.') return false;
  return true;
}

function isInternalAsciiDot(text: string, index: number): boolean {
  const previous = index > 0 ? text[index - 1] : '';
  const next = text[index + 1] || '';
  return /[A-Za-z0-9]/.test(previous) && /[A-Za-z0-9]/.test(next);
}

function consumeClosingPunctuation(text: string, start: number, end: number): number {
  let index = start;
  while (index < end && CLOSING_PUNCT.test(text[index])) index += 1;
  return index;
}

function isIgnorableSpanText(text: unknown): boolean {
  const trimmed = String(text || '').trim();
  return trimmed === '$$' || IGNORABLE_SPAN.test(trimmed);
}
