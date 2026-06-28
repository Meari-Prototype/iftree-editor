import { useCallback, type Dispatch, type SetStateAction } from 'react';

import type { DocListItem } from '../../backend/query-api.js';
import { normalizeDocId } from '../lib/doc-utils.js';
import { debugLog } from '../lib/debug-log.js';
import { documentRepository } from '../data/repositories.js';

interface WriteResult {
  ok?: unknown;
  refresh?: { kind?: unknown };
  doc?: ({ doc?: unknown } & Record<string, unknown>) | null;
  tree?: unknown;
  node?: ({ parentId?: unknown; parent_id?: unknown } & Record<string, unknown>) | null;
  editBranch?: unknown;
  docs?: unknown;
  skipDocsRefresh?: unknown;
  [key: string]: unknown;
}

interface WritePipelineOptions {
  currentDoc?: { doc?: { id?: unknown } } | null;
  treeEditMode?: boolean;
  docState?: {
    reconcileWrittenNode(node: unknown): void;
    patchDocMeta(patch: Record<string, unknown>): void;
    reloadStructuralChange(affected?: unknown[] | null): Promise<unknown>;
  };
  setBusy?: (busy: boolean) => void;
  setNotice?: (notice: string) => void;
  setDocs?: Dispatch<SetStateAction<DocListItem[]>>;
  redoStackRef?: { current: unknown[] };
  updateUndoStack?: (updater: (stack: unknown[]) => unknown[]) => unknown[];
  updateRedoStack?: (stack: unknown[]) => void;
  captureEditorHistoryToken?: (docId: unknown, viewState: unknown, effect: unknown) => Promise<{ id: unknown; docId: unknown } | null>;
  editorHistoryViewState?: (docId: unknown) => unknown;
  normalizeEditorHistoryEffect?: (effect: unknown) => unknown;
  discardHistoryTokens?: (tokens: unknown[]) => void;
  pushHistoryToken?: (stack: unknown[], token: unknown) => unknown[];
  activeEditBranch?: () => unknown;
  syncEditBranchHistoryStacks?: (branch: unknown) => void;
}

interface WritePipelineActionOptions {
  effects?: Record<string, unknown>;
  historyEffect?: unknown;
  redoEffect?: unknown;
  effect?: unknown;
}

function isSuccessfulWriteResult(result: unknown): boolean {
  return result !== undefined && result !== null && result !== false && (result as { ok?: unknown } | null | undefined)?.ok !== false;
}

// Central write pipeline: callers build repository thunks, this hook reconciles write results.
export function useWritePipeline({
  currentDoc,
  treeEditMode,
  docState,
  setBusy,
  setNotice,
  setDocs,
  redoStackRef,
  updateUndoStack,
  updateRedoStack,
  captureEditorHistoryToken,
  editorHistoryViewState,
  normalizeEditorHistoryEffect,
  discardHistoryTokens,
  pushHistoryToken,
  activeEditBranch,
  syncEditBranchHistoryStacks
}: WritePipelineOptions = {}) {
  return useCallback(async (action: () => unknown | Promise<unknown>, options: WritePipelineActionOptions = {}) => {
    if (!currentDoc) return;
    const effects = options.effects || {};
    const undoMode = effects.undo === undefined ? (treeEditMode ? 'editBranch' : 'capture') : effects.undo;
    const docsMode = effects.docsRefresh === undefined ? 'list' : effects.docsRefresh;
    const busyMode = effects.busy === undefined ? true : effects.busy;
    const historyEffect = normalizeEditorHistoryEffect!(options.historyEffect || options.redoEffect || options.effect);
    let undoToken: { id: unknown; docId: unknown } | null = null;
    if (busyMode) setBusy!(true);
    try {
      if (undoMode === 'capture' && !treeEditMode) {
        undoToken = await captureEditorHistoryToken!(currentDoc?.doc?.id, editorHistoryViewState!(currentDoc?.doc?.id), historyEffect) || null;
      }
      const rawNext = await action();
      const writeOk = isSuccessfulWriteResult(rawNext);
      if (writeOk && undoToken) {
        discardHistoryTokens!(redoStackRef!.current);
      }
      const next = rawNext as WriteResult | null | undefined;
      if (next) {
        const refreshKind = next.refresh?.kind;
        const seedDoc = next.doc?.doc ? next.doc : (next.doc && next.tree ? next : null);
        if (refreshKind === 'node' && next.node) {
          docState!.reconcileWrittenNode(next.node);
          if (next.editBranch) docState!.patchDocMeta({ editBranch: next.editBranch });
        } else if (refreshKind === 'doc') {
          const affected = normalizeDocId(next.node?.parentId ?? next.node?.parent_id);
          await docState!.reloadStructuralChange(affected ? [affected] : null);
        } else if (refreshKind === 'doc_state') {
          if ((next.doc as { doc?: unknown } | undefined)?.doc) docState!.patchDocMeta({ doc: (next.doc as { doc: unknown }).doc });
        } else if (seedDoc) {
          await docState!.reloadStructuralChange();
        }
        if (refreshKind === 'docs' || Array.isArray(next.docs)) {
          if (docsMode !== 'none') {
            if (Array.isArray(next.docs)) setDocs!(next.docs as DocListItem[]);
            else if (docsMode === 'list') setDocs!(await documentRepository.listDocs() as DocListItem[]);
          }
        } else if (docsMode === 'list' && !next.skipDocsRefresh) {
          setDocs!(await documentRepository.listDocs() as DocListItem[]);
        }
        if (undoMode === 'editBranch') {
          const branch = next.editBranch || activeEditBranch!();
          syncEditBranchHistoryStacks!(branch);
        }
        if (writeOk && undoToken) {
          const nextUndoStack = updateUndoStack!((stack) => pushHistoryToken!(stack, undoToken));
          updateRedoStack!([]);
          debugLog('editor.history.pushUndo', {
            docId: undoToken.docId,
            tokenId: undoToken.id,
            undoDepth: nextUndoStack.length,
            redoDepth: 0
          });
          undoToken = null;
        }
      }
      if (undoToken) {
        discardHistoryTokens!([undoToken]);
        undoToken = null;
      }
      return rawNext;
    } catch (error) {
      if (undoToken) discardHistoryTokens!([undoToken]);
      setNotice!(String((error as { message?: unknown } | null | undefined)?.message || error || ''));
      return null;
    } finally {
      if (busyMode) setBusy!(false);
    }
  }, [
    activeEditBranch,
    captureEditorHistoryToken,
    currentDoc,
    discardHistoryTokens,
    docState,
    editorHistoryViewState,
    normalizeEditorHistoryEffect,
    pushHistoryToken,
    redoStackRef,
    setBusy,
    setDocs,
    setNotice,
    syncEditBranchHistoryStacks,
    treeEditMode,
    updateRedoStack,
    updateUndoStack
  ]);
}
