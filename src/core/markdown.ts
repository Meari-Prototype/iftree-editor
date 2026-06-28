interface MarkdownToken {
  type: string;
  text?: string;
  alt?: string;
  src?: string;
  href?: string;
  [key: string]: unknown;
}
interface MarkdownBlock {
  type: string;
  text?: string;
  level?: number;
  alt?: string;
  src?: string;
  children?: MarkdownToken[];
  [key: string]: unknown;
}

export function parseMarkdownBlocks(markdown: unknown) {
  const blocks: MarkdownBlock[] = [];
  const lines = String(markdown || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let paragraph: string[] = [];
  let mathLines: string[] | null = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ type: 'paragraph', children: parseInline(text) });
    paragraph = [];
  }

  function flushMath() {
    if (!mathLines) return;
    const text = mathLines.join('\n').trim();
    if (text) blocks.push({ type: 'math', text });
    mathLines = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (mathLines) {
      if (trimmed === '$$') {
        flushMath();
        continue;
      }
      mathLines.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (trimmed === '$$') {
      flushParagraph();
      mathLines = [];
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      flushParagraph();
      blocks.push({ type: 'image', alt: image[1], src: image[2] });
      continue;
    }

    const math = trimmed.match(/^\$\$([\s\S]+)\$\$$/);
    if (math) {
      flushParagraph();
      blocks.push({ type: 'math', text: math[1].trim() });
      continue;
    }

    paragraph.push(line);
  }

  flushMath();
  flushParagraph();
  return blocks;
}

export function parseInline(text: string) {
  const tokens: MarkdownToken[] = [];
  const pattern = /(!?\[[^\]]*]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\$[^$]+\$)/g;
  let index = 0;

  for (const match of text.matchAll(pattern)) {
    if (match.index > index) {
      tokens.push({ type: 'text', text: text.slice(index, match.index) });
    }

    const raw = match[0];
    if (raw.startsWith('![')) {
      const image = raw.match(/^!\[([^\]]*)]\(([^)]+)\)$/);
      tokens.push({ type: 'image', text: image?.[1] ? `[image: ${image[1]}]` : '[image]', alt: image?.[1] || '', src: image?.[2] || '' });
    } else if (raw.startsWith('[')) {
      const link = raw.match(/^\[([^\]]+)]\(([^)]+)\)$/);
      tokens.push({ type: 'link', text: link?.[1] || raw, href: link?.[2] || '' });
    } else if (raw.startsWith('**')) tokens.push({ type: 'strong', text: raw.slice(2, -2) });
    else if (raw.startsWith('`')) tokens.push({ type: 'code', text: raw.slice(1, -1) });
    else tokens.push({ type: 'math', text: raw.slice(1, -1) });

    index = match.index + raw.length;
  }

  if (index < text.length) tokens.push({ type: 'text', text: text.slice(index) });
  return tokens;
}

export function extractMarkdownImageSources(markdown: unknown) {
  const sources: string[] = [];
  for (const block of parseMarkdownBlocks(markdown)) {
    if (block.type === 'image' && block.src) sources.push(block.src);
    if (block.type !== 'paragraph') continue;
    for (const token of block.children || []) {
      if (token?.type === 'image' && token.src) sources.push(token.src);
    }
  }
  return [...new Set(sources)];
}

export function markdownToPlainText(markdown: unknown, options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  for (const block of parseMarkdownBlocks(markdown)) {
    const text = markdownBlockToPlainText(block, options);
    if (text) lines.push(text);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function markdownBlockToPlainText(block: Record<string, unknown>, options: Record<string, unknown> = {}) {
  if (!block) return '';
  if (block.type === 'heading') return String(block.text || '').trim();
  if (block.type === 'image') return options.images === 'omit' ? '' : (block.alt ? `[image: ${block.alt}]` : '[image]');
  if (block.type === 'math') return renderTexMathToText(block.text);
  if (block.type === 'paragraph') return markdownInlineToPlainText(block.children as MarkdownToken[] | undefined, options);
  return '';
}

export function markdownInlineToPlainText(tokens: Array<Record<string, unknown>> = [], options: Record<string, unknown> = {}) {
  return (Array.isArray(tokens) ? tokens : [])
    .map((token: Record<string, unknown>) => {
      if (token?.type === 'image' && options.images === 'omit') return '';
      if (token?.type === 'math') return renderTexMathToText(token.text);
      return String(token?.text || '');
    })
    .join('')
    .trim();
}

const TEX_SYMBOLS: Record<string, string> = Object.freeze({
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  sum: '∑',
  prod: '∏',
  in: '∈',
  notin: '∉',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  emptyset: '∅',
  forall: '∀',
  exists: '∃',
  neg: '¬',
  land: '∧',
  lor: '∨',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  mapsto: '↦',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  neq: '≠',
  approx: '≈',
  propto: '\u221d',
  sim: '∼',
  equiv: '≡',
  times: '×',
  cdot: '·',
  pm: '±',
  mp: '∓',
  div: '÷',
  partial: '∂',
  nabla: '∇',
  infinity: '∞',
  infty: '∞',
  dots: '…',
  ldots: '…',
  cdots: '⋯',
  quad: ' ',
  qquad: '  '
});

const SUBSCRIPT_CHARS: Record<string, string> = Object.freeze({
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  h: 'ₕ',
  i: 'ᵢ',
  j: 'ⱼ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  o: 'ₒ',
  p: 'ₚ',
  r: 'ᵣ',
  s: 'ₛ',
  t: 'ₜ',
  u: 'ᵤ',
  v: 'ᵥ',
  x: 'ₓ'
});

const SUPERSCRIPT_CHARS: Record<string, string> = Object.freeze({
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  a: 'ᵃ',
  b: 'ᵇ',
  c: 'ᶜ',
  d: 'ᵈ',
  e: 'ᵉ',
  f: 'ᶠ',
  g: 'ᵍ',
  h: 'ʰ',
  i: 'ⁱ',
  j: 'ʲ',
  k: 'ᵏ',
  l: 'ˡ',
  m: 'ᵐ',
  n: 'ⁿ',
  o: 'ᵒ',
  p: 'ᵖ',
  r: 'ʳ',
  s: 'ˢ',
  t: 'ᵗ',
  u: 'ᵘ',
  v: 'ᵛ',
  w: 'ʷ',
  x: 'ˣ',
  y: 'ʸ',
  z: 'ᶻ'
});

export function renderTexMathToText(tex: unknown) {
  return normalizeMathSpacing(renderTexExpression(String(tex || '').trim(), 0).text);
}

function renderTexExpression(source: string, startIndex: number = 0, stopChar: string = '') {
  let text = '';
  let index = startIndex;

  while (index < source.length) {
    const char = source[index];
    if (stopChar && char === stopChar) {
      return { text, index: index + 1 };
    }
    if (char === '\\') {
      const command = readTexCommand(source, index + 1);
      if (command.name === 'operatorname' || command.name === 'mathrm' || command.name === 'text') {
        const argument = readTexScript(source, command.index);
        text += argument.value;
        index = argument.index;
        continue;
      }
      text += TEX_SYMBOLS[command.name] ?? command.name;
      index = command.index;
      continue;
    }
    if (char === '_' || char === '^') {
      const script = readTexScript(source, index + 1);
      const rendered = renderTexMathToText(script.value);
      text += renderScriptText(rendered, char === '_' ? SUBSCRIPT_CHARS : SUPERSCRIPT_CHARS, char);
      index = script.index;
      continue;
    }
    if (char === '{') {
      const group = renderTexExpression(source, index + 1, '}');
      text += group.text;
      index = group.index;
      continue;
    }
    if (char === '}') {
      return { text, index: index + 1 };
    }
    text += char;
    index += 1;
  }

  return { text, index };
}

function readTexCommand(source: string, index: number) {
  let cursor = index;
  while (cursor < source.length && /[A-Za-z]/.test(source[cursor])) cursor += 1;
  if (cursor === index) return { name: source[index] || '', index: index + 1 };
  return { name: source.slice(index, cursor), index: cursor };
}

function readTexScript(source: string, index: number) {
  if (source[index] === '{') {
    const group = renderTexExpression(source, index + 1, '}');
    return { value: group.text, index: group.index };
  }
  if (source[index] === '\\') {
    const command = readTexCommand(source, index + 1);
    return { value: TEX_SYMBOLS[command.name] ?? command.name, index: command.index };
  }
  return { value: source[index] || '', index: index + 1 };
}

function renderScriptText(value: unknown, table: Record<string, string>, marker: string) {
  const chars = Array.from(String(value || '').trim());
  if (chars.length === 0) return '';
  if (chars.every((char) => table[char])) return chars.map((char) => table[char]).join('');
  return `${marker}(${String(value || '').trim()})`;
}

function normalizeMathSpacing(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/([(])\s+/g, '$1')
    .trim();
}
