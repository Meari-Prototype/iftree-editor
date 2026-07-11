// 跨轮历史的结构压缩与工具结果摘要（agent-runtime 拆分，§6-7）：轨迹账本 / 触达位置提取 /
// 预算内压缩 / 长工具结果按指针折叠。数据库是唯一权威，这里只留结构性事实与重取指针。
import { sanitize, clipText, normalizeAgentMode, agentModeText } from './agent-shared.js';
import { normalizeStableId } from '../db/ids.js';
import type { AnyRecord } from './agent-shared.js';
import type { ToolResult } from './agent-protocol.js';

﻿export function pushHistoryValue(list: string[], value: unknown, limit = 12, maxChars = 320): void {
  if (!Array.isArray(list) || list.length >= limit) return;
  const text = clipText(String(value || '').replace(/\s+/g, ' ').trim(), maxChars);
  if (!text || list.includes(text)) return;
  list.push(text);
}

// 跨轮历史压缩走「结构压缩」而非语义摘要：内置 agent 的核心目标是定位
//（把 doc/address/path 找出来），不是记住正文——正文持久化在数据库里，
// 有指针随时可以用工具重新读取。所以旧轮次只保留结构性事实（谁、调了什么
// 工具、触达了哪些位置、一句话结论），不做关键词分类，不伪造确定性。
export const HISTORY_PATH_PATTERN = /(?:[A-Za-z]:[\\/][^\s`"'，。；：)）]+|(?:src|electron|docs|tests|scripts)[\\/][\w./\\-]+|projectneed\.md|package\.json|vite\.config\.[\w.]+)/g;
export const HISTORY_TARGET_PATTERN = /\b(?:doc#?\d[0-9a-z-]*|doc id [0-9a-z][0-9a-z-]*|docId[:= ]+[0-9a-z][0-9a-z-]*|node id [0-9a-z][0-9a-z-]*|nodeId[:= ]+[0-9a-z][0-9a-z-]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+(?:-\d+)+)\b/gi;
export const HISTORY_BUDGET_CHARS = 18000;
export const HISTORY_BUDGET_CHARS_TIGHT = 10000;
export const HISTORY_TARGET_LIMIT = 24;
export const HISTORY_LEDGER_LINE_LIMIT = 40;

export function pushTurnTargetsFromText(list: string[], content: unknown): void {
  const text = String(content || '');
  if (!text) return;
  for (const match of text.matchAll(HISTORY_TARGET_PATTERN)) pushHistoryValue(list, match[0], HISTORY_TARGET_LIMIT, 120);
  for (const match of text.matchAll(HISTORY_PATH_PATTERN)) pushHistoryValue(list, match[0], HISTORY_TARGET_LIMIT, 200);
}

// argsPreview 是 jsonPreview 的产物，可能被截断导致 parse 失败——失败就退回正则。
export function pushTurnTargetsFromPreview(list: string[], preview: unknown): void {
  const text = String(preview || '');
  if (!text) return;
  let parsed: AnyRecord | null = null;
  try {
    const candidate = JSON.parse(text);
    parsed = candidate && typeof candidate === 'object' ? candidate as AnyRecord : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    pushTurnTargetsFromText(list, text);
    return;
  }
  const docId = normalizeStableId(parsed.docId ?? parsed.doc_id, null);
  const nodeId = normalizeStableId(parsed.nodeId ?? parsed.node_id, null);
  const address = String(parsed.address || '').trim();
  if (docId || nodeId || address) {
    const head = docId ? `doc ${docId}` : '';
    const at = address ? `@${address}` : (nodeId ? `node ${nodeId}` : '');
    pushHistoryValue(list, [head, at].filter(Boolean).join(' '), HISTORY_TARGET_LIMIT, 120);
  }
  const path = String(parsed.path || parsed.relativePath || '').trim();
  if (path) pushHistoryValue(list, path, HISTORY_TARGET_LIMIT, 200);
  const query = String(parsed.query || parsed.q || '').trim()
    || (Array.isArray(parsed.terms) ? (parsed.terms as unknown[]).filter(Boolean).join(' ') : '');
  if (query) pushHistoryValue(list, `q:"${clipText(query, 40)}"`, HISTORY_TARGET_LIMIT, 60);
}

export interface HistoryItem {
  role?: string;
  mode?: string;
  content?: unknown;
  answer?: unknown;
  toolEvents?: ToolEvent[];
  [extra: string]: unknown;
}

export interface ToolEvent {
  id?: string;
  name?: string;
  status?: string;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
  [extra: string]: unknown;
}

export function historyTurnTargets(item: HistoryItem = {}): string[] {
  const targets: string[] = [];
  for (const event of item.toolEvents || []) {
    pushTurnTargetsFromPreview(targets, event?.argsPreview);
  }
  pushTurnTargetsFromText(targets, item.content);
  return targets;
}

export function historyTurnToolsLine(toolEvents: ToolEvent[] = []): string {
  const counts = new Map<string, { total: number; errors: number }>();
  for (const event of toolEvents) {
    const name = String(event?.name || '').trim();
    if (!name || name === 'default_context') continue;
    const entry = counts.get(name) || { total: 0, errors: 0 };
    entry.total += 1;
    if (event?.status === 'error') entry.errors += 1;
    counts.set(name, entry);
  }
  return Array.from(counts.entries())
    .map(([name, { total, errors }]) => `${name}×${total}${errors > 0 ? `(err${errors})` : ''}`)
    .join(', ');
}

export function historyLedgerLine(item: HistoryItem, turn: number, targets: string[] = []): string {
  const head = clipText(String(item.content || '').replace(/\s+/g, ' ').trim(), 2000);
  if (item.role === 'user') return `T${turn} Master：${head}`;
  const parts = [`T${turn} assistant(${item.mode})：${head}`];
  const tools = historyTurnToolsLine(item.toolEvents);
  if (tools) parts.push(`tools: ${tools}`);
  if (targets.length > 0) parts.push(`targets: ${targets.slice(0, 8).join('，')}`);
  return parts.join(' | ');
}

export function buildHistoryLedger(items: HistoryItem[] = []): string {
  const lines: string[] = [];
  const touched: string[] = [];
  let turn = 0;
  for (const item of items) {
    if (item.role === 'user') turn += 1;
    const targets = historyTurnTargets(item);
    for (const target of targets) pushHistoryValue(touched, target, HISTORY_TARGET_LIMIT, 200);
    lines.push(historyLedgerLine(item, turn, targets));
  }
  // 极端长会话下逐行轨迹自身也会膨胀：只保留最近若干行，更早的触达位置
  // 已并入聚合（targets 是全量扫的），逐行细节按激进压缩原则放弃。
  const visibleLines = lines.length > HISTORY_LEDGER_LINE_LIMIT
    ? [`（更早 ${lines.length - HISTORY_LEDGER_LINE_LIMIT} 条消息的逐行轨迹已省略，其触达位置已并入下方聚合。）`, ...lines.slice(-HISTORY_LEDGER_LINE_LIMIT)]
    : lines;
  return [
    `以下是旧轮次的结构化轨迹（共 ${items.length} 条消息，正文已省略）。数据库是唯一权威：需要旧轮次涉及的内容时，按 docId/address/path 用工具重新读取，不要凭记忆引用旧正文。更早轮次若有范围或禁止类指令，此处未保留——以最近消息和本轮指令为准，不确定时先问 Master。`,
    ...visibleLines,
    touched.length > 0 ? `已触达位置：${touched.join('；')}` : ''
  ].filter(Boolean).join('\n');
}

export interface CompactedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export function compactAgentHistory(history: HistoryItem[] = [], contextUsage: { ratio?: unknown } = {}): CompactedMessage[] {
  if (!Array.isArray(history) || history.length === 0) return [];
  const ratio = Number(contextUsage?.ratio) || 0;
  const clean = history
    .map((item) => ({
      role: (item?.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      mode: agentModeText(normalizeAgentMode(item?.mode)),
      content: String(item?.content || item?.answer || '').trim(),
      toolEvents: Array.isArray(item?.toolEvents) ? item.toolEvents : []
    }))
    .filter((item) => item.content);
  if (clean.length === 0) return [];
  // 触发看本次 history 自身的体量；上一轮的 ratio 只用来收紧（首轮 ratio 恒 0，
  // 不能拿它当放行依据）。
  const tight = ratio > 0.75;
  const budget = tight ? HISTORY_BUDGET_CHARS_TIGHT : HISTORY_BUDGET_CHARS;
  const totalChars = clean.reduce((sum, item) => sum + item.content.length, 0);
  if (totalChars <= budget) {
    return clean.map((item): CompactedMessage => ({
      role: item.role,
      content: item.content
    }));
  }
  const keepCount = tight ? 4 : 6;
  const recent = clean.slice(-keepCount);
  const older = clean.slice(0, Math.max(0, clean.length - keepCount));
  const messages: CompactedMessage[] = [];
  if (older.length > 0) {
    messages.push({ role: 'system', content: buildHistoryLedger(older) });
  }
  // 压缩之外纯拼接：recent 区原文不截断、不随档位改写——同一条历史消息在
  // 跨轮请求里保持逐字节稳定，避免无谓打碎 prompt 缓存前缀。
  for (const item of recent) {
    messages.push({
      role: item.role,
      content: item.content
    });
  }
  return messages;
}

export interface StoredSession {
  id?: number;
  mode?: string;
  prompt?: string;
  result?: { messages?: HistoryItem[]; answer?: string; error?: string };
  [extra: string]: unknown;
}

export function storedSessionHistory(session: StoredSession | null = null): HistoryItem[] {
  if (!session) return [];
  const result = session.result || {};
  if (Array.isArray(result.messages)) return result.messages;
  const messages: HistoryItem[] = [];
  if (session.prompt) {
    messages.push({
      role: 'user',
      mode: session.mode,
      content: session.prompt
    });
  }
  if (result.answer || result.error) {
    messages.push({
      role: 'assistant',
      mode: session.mode,
      content: result.answer || result.error
    });
  }
  return messages;
}

export function mergeAgentHistorySources(...sources: Array<HistoryItem[] | unknown>): HistoryItem[] {
  const merged: HistoryItem[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const item of source as HistoryItem[]) {
      const role = item?.role === 'assistant' ? 'assistant' : 'user';
      const mode = normalizeAgentMode(item?.mode);
      const content = String(item?.content || item?.answer || '').trim();
      if (!content) continue;
      const key = `${role}\n${mode}\n${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...item, role, mode, content });
    }
  }
  return merged;
}

export const TOOL_RESULT_FULL_JSON_LIMIT = 60000;

export interface Pointer { kind: string; [extra: string]: unknown }

export function toolPointerFromNode(node: AnyRecord = {}, fallbackDocId: unknown = null): Pointer | null {
  const docId = normalizeStableId(node.docId ?? node.doc_id ?? fallbackDocId, null);
  const nodeId = normalizeStableId(node.nodeId ?? node.id, null);
  const address = String(node.address || '').trim();
  if (!docId && !nodeId && !address) return null;
  return {
    kind: 'node',
    docId: docId || undefined,
    nodeId: nodeId || undefined,
    address: address || undefined
  };
}

export function pushPointer(list: Pointer[], pointer: Pointer | null = null): void {
  if (!pointer || typeof pointer !== 'object') return;
  const clean = Object.fromEntries(Object.entries(pointer).filter(([, value]) => value !== undefined && value !== ''));
  if (Object.keys(clean).length === 0) return;
  const key = JSON.stringify(clean);
  if (list.some((item) => JSON.stringify(item) === key)) return;
  list.push(clean as Pointer);
}

export function collectToolPointers(name: string, args: AnyRecord = {}, result: AnyRecord = {}): Pointer[] {
  const pointers: Pointer[] = [];
  const action = String(args.action || result.kind || '').trim();
  const docId = normalizeStableId(args.docId ?? args.doc_id ?? result.docId ?? result.doc_id, null);
  const nodeId = normalizeStableId(args.nodeId ?? args.node_id, null);
  const address = String(args.address || result.rootAddress || '').trim();
  const query = String(args.query || args.q || result.query || '').trim();
  const terms = Array.isArray(args.terms) ? args.terms : Array.isArray(result.terms) ? result.terms : null;
  const command = String(args.command || result.command || '').trim();
  const path = String(args.path || args.relativePath || result.path || result.relativePath || '').trim();
  const url = String(args.url || result.url || '').trim();
  const functionName = String(args.functionName || args.function || args.symbol || result.functionName || result.function || '').trim();
  const depthRange = result.depthRange || (
    args.minDepth || args.min_depth || args.maxDepth || args.max_depth
      ? {
          from: args.minDepth ?? args.min_depth,
          to: args.maxDepth ?? args.max_depth
        }
      : undefined
  );
  pushPointer(pointers, {
    kind: 'query',
    tool: name,
    action: action || undefined,
    docId: docId || undefined,
    nodeId: nodeId || undefined,
    address: address || undefined,
    query: query || undefined,
    terms: terms && terms.length ? terms : undefined,
    offset: args.offset ?? args.startOffset ?? args.start_offset,
    limit: args.limit,
    depthRange
  });
  if (command) pushPointer(pointers, { kind: 'command', command });
  if (path) pushPointer(pointers, { kind: 'file', path });
  const sourceDoc = result.sourceDocument as AnyRecord | undefined;
  if (sourceDoc?.original_path) pushPointer(pointers, { kind: 'file', path: sourceDoc.original_path });
  if (sourceDoc?.path) pushPointer(pointers, { kind: 'file', path: sourceDoc.path });
  if (url) pushPointer(pointers, { kind: 'url', url });
  if (functionName) pushPointer(pointers, { kind: 'function', name: functionName });
  if (docId) {
    pushPointer(pointers, {
      kind: 'node',
      docId,
      nodeId: nodeId || undefined,
      address: address || undefined
    });
  }
  pushPointer(pointers, toolPointerFromNode((result.node as AnyRecord) || {}, docId));
  pushPointer(pointers, toolPointerFromNode((result.tree as AnyRecord) || {}, docId));
  pushPointer(pointers, toolPointerFromNode((result.root as AnyRecord) || {}, docId));
  return pointers;
}

export function toolResultReturnedCount(result: ToolResult = {}): unknown {
  if (result.returned !== undefined) return result.returned;
  if (result.rowCount !== undefined) return result.rowCount;
  for (const key of ['rows', 'nodes', 'docs'] as const) {
    const value = result[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

export function toolResultStatus(result: ToolResult = {}): 'ok' | 'error' | 'rejected' {
  if (result?.rejected) return 'rejected';
  if (result?.ok === false || result?.error) return 'error';
  const exitCode = Number(result?.exitCode);
  if (Number.isFinite(exitCode) && exitCode !== 0) return 'error';
  return 'ok';
}

export function toolErrorSummary(result: ToolResult = {}): string {
  const raw = [
    (result as { reason?: unknown }).reason,
    (result?.error as { message?: string } | null | undefined)?.message,
    result?.error,
    result?.stderr
  ].filter(Boolean).map((value) => String(value)).join('\n');
  return raw ? clipText(raw.split(/\r?\n/).filter(Boolean).slice(0, 6).join('\n'), 1200) : '';
}

export function summarizeToolResultForHistory(name: string, args: AnyRecord = {}, result: ToolResult = {}, resultJson: string = ''): string {
  if (resultJson.length <= TOOL_RESULT_FULL_JSON_LIMIT) return resultJson;
  const pointers = collectToolPointers(name, args, result as AnyRecord);
  const status = toolResultStatus(result);
  const summary = {
    kind: 'tool_result_summary',
    tool: name,
    status,
    action: String(args.action || (result as AnyRecord).kind || (result as AnyRecord).mode || '').trim() || undefined,
    command: args.command || (result as AnyRecord).command || undefined,
    originalCharLength: resultJson.length,
    omittedFullOutput: true,
    counts: {
      returned: toolResultReturnedCount(result),
      total: result.total,
      truncated: result.truncated
    },
    pointers,
    error: toolErrorSummary(result) || undefined,
    conclusion: status === 'ok'
      ? '工具已返回长结果，完整内容未写入模型历史。'
      : '工具调用未成功，保留错误摘要供模型修正参数。',
    next: pointers.length > 0
      ? '需要完整内容时，按 pointers 中的 action、docId、address、nodeId、path、url 或 command 重新读取。'
      : '需要完整内容时，用更窄的查询条件重新调用同一工具。'
  };
  return JSON.stringify(sanitize(summary));
}