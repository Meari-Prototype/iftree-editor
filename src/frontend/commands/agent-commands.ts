// agentCommands：agent 会话运行 / 取消 / diff 审批（frontend-refactor.md §4.4 阶段 2b）。
// runAgentRequest / cancelAgentRequest / applyAgentDiff / rejectAgentDiff / applyAll / rejectAll /
// traceAgentDiff 自 AppBody 原样搬入。activeAgentRequestIdRef 变为工厂闭包变量（命令组单例持有）。
// 消息/diff/会话状态仍住 useAgentChat（该 hook 无倒灌——不收 AppBody 逻辑，是自洽状态桶），
// 经 deps.chat 读写；agentStore 化留到需要 selector 级订阅时再做。
// 依赖方向：agent → editor（undo token、审批进出）、agent → document（refreshDocs/openDoc）。
// smart import 的跨域协调住 import-commands；agent 保持单向调用 document。

import { normalizeDocId } from '../lib/doc-utils.js';
import { agentHistoryForRequest } from '../lib/agent-utils.js';
import { agentRepository } from '../data/repositories.js';
import type { EditorCommands } from './editor-commands.js';

type AgentMessageLike = Record<string, unknown> & { requestId?: unknown; role?: unknown };
type AgentDiffLike = Record<string, unknown> & { id?: unknown };

interface AgentRequestResultLike {
  usage?: unknown;
  answer?: string;
  diffs?: unknown[];
  toolEvents?: unknown[];
  segments?: unknown[];
  canceled?: boolean;
  changedDocIds?: unknown[];
  sessionId?: unknown;
  [extra: string]: unknown;
}

interface AgentApplyDiffResultLike {
  ok?: unknown;
  diffs?: unknown[];
  docId?: unknown;
  editBranch?: unknown;
  [extra: string]: unknown;
}

export interface RunAgentRequestInput {
  mode: string;
  prompt: unknown;
  modelOption?: { providerId?: string; apiId?: string; model?: string } | null;
  reasoningEffort?: string;
}

export interface AgentCommandDeps {
  getCurrentDoc(): { doc?: { id?: unknown } | null; editBranch?: unknown } | null;
  chat: {
    getMessages(): AgentMessageLike[];
    setMessages(updater: (previous: AgentMessageLike[]) => AgentMessageLike[]): void;
    getDiffs(): AgentDiffLike[];
    setDiffs(diffs: unknown[]): void;
    setActiveSessionId(id: unknown): void;
    getActiveSessionId(): unknown;
    setAgentBusy(value: boolean): void;
    getContextUsage(): unknown;
    setContextUsage(usage: unknown): void;
    refreshSessions(): Promise<unknown>;
  };
  editor: Pick<EditorCommands,
    'captureEditorHistoryToken' | 'discardHistoryTokens' | 'commitUndoToken'
    | 'syncEditBranchHistoryStacks' | 'activeEditBranch' | 'ensureAgentApprovalEditMode' | 'isTreeEditMode'>;
  document: {
    refreshDocs(nextDocId?: unknown): Promise<unknown>;
    openDoc(docId: unknown): Promise<unknown>;
  };
  docState: {
    patchDocMeta(patch: Record<string, unknown>): unknown;
    reloadStructuralChange(): Promise<unknown>;
    refreshList(): Promise<unknown>;
  };
  ui: {
    setNotice(message: string): void;
  };
  view: {
    getActiveTab(): string;
    getDepthLimit(): number;
    getSelectedNodeId(): unknown;
  };
  loadDocForCurrentView(docId: unknown, sourceDoc?: unknown): Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | null | undefined)?.message || error || '');
}

export function createAgentCommands(getDeps: () => AgentCommandDeps) {
  // 在途请求 id（原 activeAgentRequestIdRef）：命令组单例的闭包状态。
  let activeAgentRequestId: string | null = null;

  async function runAgentRequest({
    mode,
    prompt,
    modelOption = null,
    reasoningEffort = 'auto'
  }: RunAgentRequestInput) {
    const deps = getDeps();
    const { chat, editor, ui } = deps;
    const text = String(prompt || '').trim();
    if (!text) return;
    const requestId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = Date.now();
    let beforeFullAccessToken: Awaited<ReturnType<EditorCommands['captureEditorHistoryToken']>> = null;
    activeAgentRequestId = requestId;
    chat.setAgentBusy(true);
    chat.setMessages((previous) => [
      ...previous,
      {
        id: `${requestId}-user`,
        requestId,
        role: 'user',
        mode,
        content: text,
        createdAt: startedAt
      },
      {
        id: `${requestId}-assistant`,
        requestId,
        role: 'assistant',
        mode,
        answer: '',
        status: '正在连接...',
        streaming: true,
        diffCount: 0,
        toolEvents: [],
        segments: [],
        createdAt: startedAt
      }
    ]);
    try {
      beforeFullAccessToken = mode === 'full' ? await editor.captureEditorHistoryToken() : null;
      const result = await agentRepository.runAgentRequest({
        requestId,
        sessionId: chat.getActiveSessionId(),
        mode,
        prompt: text,
        agentProviderId: modelOption?.providerId || '',
        agentApiId: modelOption?.apiId || '',
        agentModel: modelOption?.model || '',
        reasoningEffort,
        history: agentHistoryForRequest(chat.getMessages() as Parameters<typeof agentHistoryForRequest>[0]),
        contextUsage: chat.getContextUsage(),
        docId: deps.getCurrentDoc()?.doc?.id || null,
        selectedNodeId: deps.view.getSelectedNodeId() || null,
        viewMode: deps.view.getActiveTab(),
        depthLimit: deps.view.getDepthLimit()
      }) as AgentRequestResultLike | null;
      if (result?.usage) chat.setContextUsage(result.usage);
      chat.setMessages((previous) => previous.map((message) => (
        message.requestId === requestId && message.role === 'assistant'
          ? {
              ...message,
              answer: result?.answer || message.answer || '',
              diffCount: Array.isArray(result?.diffs) ? result.diffs.length : message.diffCount,
              elapsedMs: Date.now() - startedAt,
              usage: result?.usage || message.usage,
              toolEvents: Array.isArray(result?.toolEvents) ? result.toolEvents : (message.toolEvents || []),
              segments: Array.isArray(result?.segments) ? result.segments : (message.segments || []),
              status: result?.canceled ? '已取消' : '完成',
              streaming: false
            }
          : message
      )));
      chat.setDiffs(Array.isArray(result?.diffs) ? result.diffs : []);
      const changedDocIds = Array.isArray(result?.changedDocIds) ? result.changedDocIds.map(normalizeDocId).filter(Boolean) : [];
      if (changedDocIds.length > 0) {
        if (beforeFullAccessToken && changedDocIds.includes(normalizeDocId(beforeFullAccessToken.docId))) {
          editor.commitUndoToken(beforeFullAccessToken);
          beforeFullAccessToken = null;
        }
        // 完成分支统一「完成时」时基（重新 getDeps()）：agent 请求可跑分钟级，期间用户可能
        // 切文档/进出编辑——发起时快照与 editor.isTreeEditMode()（恒读最新）混用会把「刷新
        // 发起时文档」的动作打在完成时的另一个文档上（清错 editBranch）。语义定为：完成时
        // 用户正看着的文档被改了才刷它；已切走则只刷列表，不把用户强拉回被改文档（有意改掉
        // 旧版 refreshDocs(changedDocIds[0]) 的强切）。
        const now = getDeps();
        const currentDocIdNow = normalizeDocId(now.getCurrentDoc()?.doc?.id);
        if (currentDocIdNow && changedDocIds.includes(currentDocIdNow)) {
          if (editor.isTreeEditMode()) {
            // full agent 直写 base：refreshDocs 的编辑分支保护会早退、视图不动，
            // 这里显式重取投影让 agent 改动立即可见；不调 syncEditBranchHistoryStacks，
            // 保住栈顶 base 快照 token 的紧邻回退窗口（Ctrl+Z 一键回退 agent 改动）。
            const nextDoc = await now.loadDocForCurrentView(currentDocIdNow, now.getCurrentDoc()) as { editBranch?: unknown } | null;
            now.docState.patchDocMeta({ editBranch: nextDoc?.editBranch ?? null });
            await now.docState.reloadStructuralChange();
            await now.docState.refreshList();
          } else {
            await now.document.refreshDocs(currentDocIdNow);
          }
        } else {
          await now.docState.refreshList();
        }
      }
      if (beforeFullAccessToken) {
        editor.discardHistoryTokens([beforeFullAccessToken]);
        beforeFullAccessToken = null;
      }
      if (result?.sessionId) chat.setActiveSessionId(result.sessionId);
      await chat.refreshSessions();
    } catch (error) {
      if (beforeFullAccessToken) editor.discardHistoryTokens([beforeFullAccessToken]);
      chat.setMessages((previous) => previous.map((message) => (
        message.requestId === requestId && message.role === 'assistant'
          ? {
              ...message,
              answer: errorMessage(error) || 'Agent 调用失败',
              elapsedMs: Date.now() - startedAt,
              toolEvents: message.toolEvents || [],
              status: '失败',
              streaming: false,
              error: true
            }
          : message
      )));
      ui.setNotice(errorMessage(error));
    } finally {
      if (activeAgentRequestId === requestId) activeAgentRequestId = null;
      chat.setAgentBusy(false);
      chat.refreshSessions().catch((error) => ui.setNotice(errorMessage(error)));
    }
  }

  async function cancelAgentRequest() {
    const { chat, ui } = getDeps();
    const requestId = activeAgentRequestId;
    if (!requestId || !agentRepository.canCancelAgentRequest?.()) return;
    try {
      await agentRepository.cancelAgentRequest({ requestId });
      chat.setMessages((previous) => previous.map((message) => (
        message.requestId === requestId && message.role === 'assistant'
          ? { ...message, status: '正在取消...', streaming: true }
          : message
      )));
    } catch (error) {
      ui.setNotice(errorMessage(error));
    }
  }

  async function applyAgentDiff(diffId: unknown, options: { skipEditModeCheck?: boolean } = {}) {
    const deps = getDeps();
    const { chat, editor, ui } = deps;
    const pendingDiff = chat.getDiffs().find((diff) => Number(diff.id) === Number(diffId));
    if (!pendingDiff) return false;
    if (!options.skipEditModeCheck) {
      const ready = await editor.ensureAgentApprovalEditMode();
      if (!ready) return false;
    }
    const target = { docId: (pendingDiff as { base_doc_id?: unknown }).base_doc_id };
    let undoToken: Awaited<ReturnType<EditorCommands['captureEditorHistoryToken']>> = null;
    try {
      if (target.docId && !editor.isTreeEditMode()) {
        undoToken = await editor.captureEditorHistoryToken(target.docId);
      }
      const result = await agentRepository.applyDiff({ diffId } as Parameters<typeof agentRepository.applyDiff>[0]) as AgentApplyDiffResultLike | null;
      if (result?.ok !== false && undoToken) {
        editor.commitUndoToken(undoToken);
        undoToken = null;
      }
      if (undoToken) {
        editor.discardHistoryTokens([undoToken]);
        undoToken = null;
      }
      chat.setDiffs(Array.isArray(result?.diffs) ? result.diffs : []);
      const resultDocId = result?.docId || deps.getCurrentDoc()?.doc?.id;
      if (editor.isTreeEditMode() && resultDocId) {
        const nextDoc = await deps.loadDocForCurrentView(resultDocId, deps.getCurrentDoc()) as { editBranch?: unknown } | null;
        deps.docState.patchDocMeta({ editBranch: nextDoc?.editBranch ?? null });
        await deps.docState.reloadStructuralChange();
        editor.syncEditBranchHistoryStacks(nextDoc?.editBranch || editor.activeEditBranch());
      } else if (resultDocId) {
        await deps.document.refreshDocs(resultDocId);
      }
      await chat.refreshSessions();
      return true;
    } catch (error) {
      if (undoToken) editor.discardHistoryTokens([undoToken]);
      ui.setNotice(errorMessage(error));
      return false;
    }
  }

  async function rejectAgentDiff(diffId: unknown) {
    const { chat, ui } = getDeps();
    try {
      const result = await agentRepository.rejectDiff({ diffId } as Parameters<typeof agentRepository.rejectDiff>[0]) as { diffs?: unknown[] } | null;
      chat.setDiffs(Array.isArray(result?.diffs) ? result.diffs : []);
      await chat.refreshSessions();
    } catch (error) {
      ui.setNotice(errorMessage(error));
    }
  }

  async function applyAllAgentDiffs() {
    const { chat, editor } = getDeps();
    const pendingDiffs = [...chat.getDiffs()];
    if (pendingDiffs.length === 0) return;
    const ready = await editor.ensureAgentApprovalEditMode();
    if (!ready) return;
    for (const diff of pendingDiffs) {
      // 需求 15-4-1：逐条转移，遇到第一条失败即停止，保留已成功转移的，
      // 失败那条已在 applyAgentDiff 内弹出错误说明。
      const ok = await applyAgentDiff(diff.id, { skipEditModeCheck: true });
      if (!ok) break;
    }
  }

  async function rejectAllAgentDiffs() {
    const { chat } = getDeps();
    for (const diff of chat.getDiffs()) {
      await rejectAgentDiff(diff.id);
    }
  }

  async function traceAgentDiff(branch: { base_doc_id?: unknown; [extra: string]: unknown } | null | undefined) {
    const deps = getDeps();
    // 整批：打开该 owner=llm:<会话> 分支的基底文档；明细对照走 changes / 分支 diff 视图。
    const docId = branch?.base_doc_id;
    if (!docId) {
      deps.ui.setNotice('这个待审分支没有可定位的文档。');
      return;
    }
    try {
      if (normalizeDocId(deps.getCurrentDoc()?.doc?.id) !== normalizeDocId(docId)) await deps.document.openDoc(docId);
      deps.ui.setNotice('已打开文档；在 changes / 分支 diff 视图查看该会话的待审改动。');
    } catch (error) {
      deps.ui.setNotice(errorMessage(error));
    }
  }

  return {
    runAgentRequest,
    cancelAgentRequest,
    applyAgentDiff,
    rejectAgentDiff,
    applyAllAgentDiffs,
    rejectAllAgentDiffs,
    traceAgentDiff
  };
}

export type AgentCommands = ReturnType<typeof createAgentCommands>;
