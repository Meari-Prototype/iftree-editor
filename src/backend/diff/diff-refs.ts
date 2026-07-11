// diff.refs（15-5-2）的 ref 文法解析：把一个 ref 字符串解析成 resolveRefSnapshot 认的形态。
//   ''/head/正文 → 当前正文 { head:true, docId }
//   draft        → 选中草稿（不带 id，由调用端上下文经 draftRef 补全）
//   draft:<id>   → 指定草稿 { branchId }（id 必须是正整数，否则报错，免得 Number('abc')=NaN
//                  被 findEditBranch 的真值判断当成“没给 branchId”、回退后误报“草稿未找到”）
//   其余         → 历史 commit { historyId, docId }
// draftRef 与 docId 是各前端的上下文（db 外壳与 MCP 各自的选中草稿/当前文档），故以参数注入；
// 两个前端共用这一份文法，避免各抄一遍、加 ref 种类（如 tag:）时只改一处不致分叉。
type DiffRef =
  | { head: true; docId: unknown }
  | { branchId: number }
  | { historyId: string; docId: unknown }
  | Record<string, unknown>;

interface DiffRefContext {
  docId?: unknown;
  draftRef?: () => DiffRef;
}

export function parseDiffRef(raw: unknown, { docId = null, draftRef }: DiffRefContext = {}): DiffRef {
  const s = String(raw ?? '').trim();
  const low = s.toLowerCase();
  if (s === '' || low === 'head' || s === '正文') return { head: true, docId };
  if (low === 'draft') return draftRef ? draftRef() : {};
  if (low.startsWith('draft:')) {
    const idText = s.slice(6).trim();
    const branchId = Number(idText);
    if (!idText || !Number.isInteger(branchId) || branchId <= 0) {
      throw new Error(`draft ref 非法：'${s}'。用 draft（switch 选中草稿）或 draft:<正整数 branchId>。`);
    }
    return { branchId };
  }
  return { historyId: s, docId };
}
