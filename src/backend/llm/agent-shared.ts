// agent 域共享小工具与基础类型（agent-runtime 按职责拆分，架构 §6-7）：
// 文本裁剪 / 取消信号 / 树扁平化 / 模式与权限。无外部依赖，被 agent-* 各件与 runtime 消费。

﻿export type Json = Record<string, unknown>;
export type AnyRecord = Record<string, unknown>;

export const STABLE_ID_SCHEMA = Object.freeze({
  anyOf: [{ type: 'string' }, { type: 'number' }]
});

export function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function clipText(value: unknown, limit = 500): string {
  const text = String(value || '');
  const max = Math.max(0, Number(limit) || 0);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

export function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError'
    || /aborted|abort|cancel|取消/i.test(String((error as { message?: string } | null)?.message || error || ''));
}

export function agentAbortError(): Error {
  const error = new Error('Agent 请求已取消');
  error.name = 'AbortError';
  return error;
}

export function assertNotAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw agentAbortError();
}

export interface TreeNode {
  id?: unknown;
  parent_id?: unknown;
  address?: unknown;
  children?: TreeNode[];
  [extra: string]: unknown;
}

export function flattenTree(node: TreeNode | null | undefined, list: TreeNode[] = []): TreeNode[] {
  if (!node) return list;
  list.push(node);
  for (const child of node.children || []) flattenTree(child, list);
  return list;
}

export type AgentMode = 'qa' | 'edit' | 'full';

export function normalizeAgentMode(value: unknown): AgentMode {
  if (value === 'full') return 'full';
  if (value === 'edit') return 'edit';
  return 'qa';
}

export function agentModeText(mode: unknown): string {
  if (mode === 'full') return '完全权限';
  if (mode === 'edit') return '协作';
  return '问答';
}

export interface AgentPermissions {
  mode: AgentMode;
  label: string;
  localFiles: {
    root: string;
    pathStyle: 'relative';
    canRead: boolean;
    canWrite: boolean;
    canAccessOutsideLibrary: boolean;
  };
  database: {
    canRead: boolean;
    canProposeChanges: boolean;
    canWriteShadow: boolean;
    canWriteDirect: boolean;
    rawSqlAllowed: boolean;
  };
}

export function agentPermissionsForMode(mode: unknown): AgentPermissions {
  const normalized = normalizeAgentMode(mode);
  return {
    mode: normalized,
    label: agentModeText(normalized),
    localFiles: {
      root: 'library',
      pathStyle: 'relative',
      canRead: true,
      canWrite: normalized === 'full',
      canAccessOutsideLibrary: false
    },
    database: {
      canRead: true,
      canProposeChanges: normalized === 'edit' || normalized === 'full',
      canWriteShadow: normalized === 'edit' || normalized === 'full',
      canWriteDirect: false,
      rawSqlAllowed: false
    }
  };
}