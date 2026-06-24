// @ts-nocheck
import { useCallback } from 'react';

import { normalizeDocId } from '../lib/doc-utils.js';
import { debugLog } from '../lib/debug-log.js';
import { documentRepository } from '../data/repositories.js';

function isSuccessfulWriteResult(result) {
  return result !== undefined && result !== null && result !== false && result?.ok !== false;
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
}: any = {}) {
  return useCallback(async (action, options: any = {}) => {
    if (!currentDoc) return;
    const effects = options.effects || {};
    const undoMode = effects.undo === undefined ? (treeEditMode ? 'editBranch' : 'capture') : effects.undo;
    const docsMode = effects.docsRefresh === undefined ? 'list' : effects.docsRefresh;
    const busyMode = effects.busy === undefined ? true : effects.busy;
    const historyEffect = normalizeEditorHistoryEffect(options.historyEffect || options.redoEffect || options.effect);
    let undoToken = null;
    if (busyMode) setBusy(true);
    try {
      if (undoMode === 'capture' && !treeEditMode) {
        undoToken = await captureEditorHistoryToken(currentDoc?.doc?.id, editorHistoryViewState(currentDoc?.doc?.id), historyEffect);
      }
      const next = await action();
      const writeOk = isSuccessfulWriteResult(next);
      if (writeOk && undoToken) {
        discardHistoryTokens(redoStackRef.current);
      }
      if (next) {
        const refreshKind = next.refresh?.kind;
        const seedDoc = next.doc?.doc ? next.doc : (next.doc && next.tree ? next : null);
        if (refreshKind === 'node' && next.node) {
          docState.reconcileWrittenNode(next.node);
          if (next.editBranch) docState.patchDocMeta({ editBranch: next.editBranch });
        } else if (refreshKind === 'doc') {
          const affected = normalizeDocId(next.node?.parentId ?? next.node?.parent_id);
          await docState.reloadStructuralChange(affected ? [affected] : null);
        } else if (refreshKind === 'doc_state') {
          if (next.doc?.doc) docState.patchDocMeta({ doc: next.doc.doc });
        } else if (seedDoc) {
          await docState.reloadStructuralChange();
        }
        if (refreshKind === 'docs' || Array.isArray(next.docs)) {
          if (docsMode !== 'none') {
            if (Array.isArray(next.docs)) setDocs(next.docs);
            else if (docsMode === 'list') setDocs(await documentRepository.listDocs());
          }
        } else if (docsMode === 'list' && !next.skipDocsRefresh) {
          setDocs(await documentRepository.listDocs());
        }
        if (undoMode === 'editBranch') {
          const branch = next.editBranch || activeEditBranch();
          syncEditBranchHistoryStacks(branch);
        }
        if (writeOk && undoToken) {
          const nextUndoStack = updateUndoStack((stack) => pushHistoryToken(stack, undoToken));
          updateRedoStack([]);
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
        discardHistoryTokens([undoToken]);
        undoToken = null;
      }
      return next;
    } catch (error) {
      if (undoToken) discardHistoryTokens([undoToken]);
      setNotice(error.message);
      return null;
    } finally {
      if (busyMode) setBusy(false);
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
