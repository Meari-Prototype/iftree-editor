// 统一的文本预算/截断（projectneed 15-5-1-3：返回 ASCII 紧凑、不撑爆上下文）。
// 把散落各处的 clip 与门禁数字收口到一处，免得截断层次不一。数字对齐既有逻辑：
//   fullText 1 万字 —— read 子树门禁 READ_SUBTREE_TEXT_LIMIT(db-shell) / contentLimit max(query-api)；
//   cell 80         —— db-shell clip 默认；
//   line 100        —— write-result-text / library-service clip 默认。
// 门禁提示措辞沿用 read 分层早停文案（query-api），让 agent 见到熟悉的「加大 limit 二次突破」。
// 注：原文窗口（article 5000/50000）有自己的窗口分配逻辑，不在此收口，避免误用。

export const CHAR_LIMITS = {
  fullText: 10000, // 大文本一次性返回门禁（export 默认）
  line: 100,       // 单行正文/标题 clip
  cell: 80,        // 表格单元格 clip
  rows: 50         // 列表/表格一次渲染的行数上限
};

const ELLIPSIS = '…';

// 单行截断：归一空白后超 max 截断、缀省略号。给摘要行/标题/正文预览用。
export function clip(text: unknown, max = CHAR_LIMITS.line): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + ELLIPSIS : s;
}

// 表格单元格：NULL 显式、其余按 cell 上限 clip（不归一换行外的多余空白由 clip 处理）。
export function cell(value: unknown): string {
  if (value == null) return 'NULL';
  return clip(value, CHAR_LIMITS.cell);
}

// 冲突值对（ours/theirs）的差异感知截断：两侧都 ≤max 原样全显——冲突逐条待裁、量少，
// 从头狠截会把「差异在尾部」的两侧截成一模一样、无法凭回执裁决。超长时先算两串公共前缀，
// 从分叉点前留 lead 字符处对两侧开同一扇窗：第一处差异永远落在窗内，且两侧窗口对齐可比。
export function clipConflictPair(ours: unknown, theirs: unknown, max = 120, lead = 10): { ours: string; theirs: string } {
  const a = String(ours ?? '').replace(/\s+/g, ' ').trim();
  const b = String(theirs ?? '').replace(/\s+/g, ' ').trim();
  if (a.length <= max && b.length <= max) return { ours: a, theirs: b };
  let p = 0;
  const shared = Math.min(a.length, b.length);
  while (p < shared && a[p] === b[p]) p += 1;
  const start = Math.max(0, p - lead);
  const window = (s: string) => {
    const body = s.slice(start, start + max);
    return `${start > 0 ? ELLIPSIS : ''}${body}${s.length > start + max ? ELLIPSIS : ''}`;
  };
  return { ours: window(a), theirs: window(b) };
}

// 大文本一次性返回截断：不动原文换行，超 limit 截断并缀门禁提示（措辞对齐 read 分层早停）。
// 要全量靠调用方显式加大 limit「二次突破」，与 read 一致。
export function clipText(text: unknown, limit = CHAR_LIMITS.fullText, { label = '全文' }: { label?: string } = {}): string {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return s.slice(0, limit)
    + `\n\n— ${label} ${s.length} 字，超过 ${limit} 字门禁，已截前 ${limit}；要全量请显式把 limit 加大到所需字数（确认你真要一次拉这么多）。`;
}

// 行数截断：只取前 max 行渲染，回带总数/是否截断，文案由调用方按场景拼。
export function clipRows<T>(rows: T[] | null | undefined, max = CHAR_LIMITS.rows): { rows: T[]; total: number; truncated: boolean; max: number } {
  const arr = Array.isArray(rows) ? rows : [];
  return { rows: arr.slice(0, max), total: arr.length, truncated: arr.length > max, max };
}
