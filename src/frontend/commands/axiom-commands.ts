// axiomCommands：事实前提动词（frontend-refactor.md §4.4 阶段 2c）。
// addAxiom（原 openAxiomDialog——名字遗留，实际直建空前提并定位）/ requestAxiomRef（校验后开
// 引用选择框）/ confirmAxiomRef（写引用）/ toggleAxiomsCollapsed / addAxiomFromReadableView
// 自 AppBody 原样搬入。引用选择框的 UI state（axiomRefDialog）留 AppBody React 薄层，
// 经 deps.dialogs.openAxiomRef 下发候选。

import type { DocRow } from '../../backend/db/schema.js';
import { findNode } from '../../core/tree.js';
import { depthOf, isFactAxiomRef, normalizeDocId, sameDocId } from '../lib/doc-utils.js';
import { axiomRepository, documentRepository, refRepository } from '../data/repositories.js';
import type { EditorCommands } from './editor-commands.js';

interface AxiomRowLike {
  id?: unknown;
  [extra: string]: unknown;
}

interface AxiomDocLike {
  doc?: { id?: unknown; updated_at?: unknown; [extra: string]: unknown } | null;
  tree?: unknown;
  axioms?: AxiomRowLike[];
  refs?: Array<{ source_id?: unknown; target_id?: unknown; [extra: string]: unknown }>;
  [extra: string]: unknown;
}

interface AddAxiomResultLike {
  axiom?: { id?: unknown; [extra: string]: unknown } | null;
  [extra: string]: unknown;
}

export interface AxiomRefDialogPayload {
  docId: unknown;
  nodeId: string;
  axiomId: unknown;
  options: AxiomRowLike[];
}

export interface AxiomCommandDeps {
  getCurrentDoc(): AxiomDocLike | null;
  editor: Pick<EditorCommands, 'dispatchWrite' | 'isTreeEditMode'>;
  docState: {
    patchDocMeta(patch: Record<string, unknown>): unknown;
  };
  ui: {
    setBusy(value: boolean): void;
    setNotice(message: string): void;
    setDocs(docs: unknown[]): void;
  };
  tree: {
    getAxiomsCollapsed(): boolean;
    setAxiomsCollapsed(value: boolean): void;
  };
  view: {
    setLocateRequest(updater: (previous: { seq?: number } | null | undefined) => Record<string, unknown>): void;
  };
  dialogs: {
    openAxiomRef(payload: AxiomRefDialogPayload): void;
  };
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | null | undefined)?.message || error || '');
}

export function createAxiomCommands(getDeps: () => AxiomCommandDeps) {
  // 直建一条空事实前提（深层目标节点顺带挂引用），成功后定位到新前提。
  async function addAxiom(targetNodeId: unknown = null) {
    const deps = getDeps();
    const { editor, ui, tree } = deps;
    const currentDoc = deps.getCurrentDoc();
    const docId = currentDoc?.doc?.id;
    if (!docId) return null;
    if (!editor.isTreeEditMode()) {
      ui.setNotice('请先解锁编辑，再新增事实前提。');
      return null;
    }
    const target = targetNodeId ? findNode(currentDoc?.tree, targetNodeId) : null;
    const axiomsCollapsed = tree.getAxiomsCollapsed();
    if (axiomsCollapsed) tree.setAxiomsCollapsed(false);
    const result = await editor.dispatchWrite(async () => {
      const written = await axiomRepository.addAxiom({ docId, content: '', status: 'pending' } as Parameters<typeof axiomRepository.addAxiom>[0]) as AddAxiomResultLike | null;
      const axiomId = written?.axiom?.id;
      if (target?.id && depthOf(String(target.address ?? '1')) > 1 && axiomId) {
        await refRepository.addAxiomRefToNode({ docId, nodeId: target.id, axiomId } as Parameters<typeof refRepository.addAxiomRefToNode>[0]);
      }
      if (axiomsCollapsed) {
        await documentRepository.updateDocAxiomsCollapsed({ docId, collapsed: false, includeDoc: false } as Parameters<typeof documentRepository.updateDocAxiomsCollapsed>[0]);
      }
      return written;
    }) as AddAxiomResultLike | null | undefined;
    const axiomId = result?.axiom?.id;
    if (axiomId) {
      deps.view.setLocateRequest((previous) => ({
        seq: (previous?.seq || 0) + 1,
        nodeId: `axiom:${axiomId}`,
        includeRootAxiomGroup: true
      }));
    }
    return null;
  }

  function addAxiomFromReadableView() {
    const deps = getDeps();
    if (!deps.editor.isTreeEditMode()) {
      deps.ui.setNotice('请先进入编辑模式');
      return null;
    }
    return addAxiom((deps.getCurrentDoc()?.tree as { id?: unknown } | null | undefined)?.id || null);
  }

  // 校验目标节点可挂引用后，开选择框（UI state 在 AppBody）。
  async function requestAxiomRef(targetNodeId: unknown, preferredAxiomId: unknown = null) {
    const deps = getDeps();
    const { editor, ui } = deps;
    const currentDoc = deps.getCurrentDoc();
    const docId = currentDoc?.doc?.id;
    const nodeId = normalizeDocId(targetNodeId);
    if (!docId) return null;
    if (!nodeId) {
      ui.setNotice('请先选择要引用事实前提的节点。');
      return null;
    }
    if (!editor.isTreeEditMode()) {
      ui.setNotice('请先解锁编辑，再添加事实前提引用。');
      return null;
    }
    const target = findNode(currentDoc?.tree, nodeId);
    if (!target) return null;
    if (depthOf(String(target.address ?? '1')) <= 1) {
      ui.setNotice('根节点天然引用全部事实前提，无需添加引用。');
      return null;
    }
    const axioms = Array.isArray(currentDoc?.axioms) ? currentDoc.axioms : [];
    if (axioms.length === 0) {
      ui.setNotice('当前文档还没有事实前提。');
      return null;
    }
    const used = new Set((currentDoc?.refs || [])
      .filter((ref) => isFactAxiomRef(ref as Parameters<typeof isFactAxiomRef>[0]) && String(ref.target_id) === String(nodeId))
      .map((ref) => String(ref.source_id)));
    const available = axioms.filter((axiom) => !used.has(String(axiom.id)));
    if (available.length === 0) {
      ui.setNotice('当前节点已引用全部事实前提。');
      return null;
    }
    const preferred = available.find((axiom) => String(axiom.id) === String(preferredAxiomId));
    deps.dialogs.openAxiomRef({
      docId,
      nodeId,
      axiomId: (preferred || available[0]).id,
      options: available
    });
    return null;
  }

  // 选择框确认后的真正写入（AppBody 表单 handler 读 state、关框后调这里）。
  async function confirmAxiomRef(payload: { docId?: unknown; nodeId?: unknown; axiomId?: unknown }) {
    const { editor } = getDeps();
    const { docId, nodeId, axiomId } = payload;
    await editor.dispatchWrite(() => refRepository.addAxiomRefToNode({ docId, nodeId, axiomId } as Parameters<typeof refRepository.addAxiomRefToNode>[0]));
  }

  async function toggleAxiomsCollapsed() {
    const deps = getDeps();
    const { ui, tree, docState } = deps;
    const currentDoc = deps.getCurrentDoc();
    const docId = currentDoc?.doc?.id;
    const nextValue = !tree.getAxiomsCollapsed();
    if (!docId) {
      tree.setAxiomsCollapsed(nextValue);
      return;
    }
    tree.setAxiomsCollapsed(nextValue);
    ui.setBusy(true);
    try {
      const next = await documentRepository.updateDocAxiomsCollapsed({ docId, collapsed: nextValue, includeDoc: false }) as { doc?: { axioms_collapsed?: unknown; updated_at?: unknown; [extra: string]: unknown } } | null;
      if (next) {
        const latest = deps.getCurrentDoc();
        if (sameDocId(latest?.doc?.id, docId)) {
          docState.patchDocMeta({
            doc: {
              ...latest!.doc!,
              axioms_collapsed: Number(next.doc?.axioms_collapsed ?? (nextValue ? 1 : 0)) || 0,
              updated_at: String(next.doc?.updated_at ?? latest!.doc?.updated_at ?? '')
            } as DocRow
          });
        }
        ui.setDocs(await documentRepository.listDocs() as unknown[]);
      }
    } catch (error) {
      tree.setAxiomsCollapsed(!nextValue);
      ui.setNotice(errorMessage(error));
    } finally {
      ui.setBusy(false);
    }
  }

  return {
    addAxiom,
    addAxiomFromReadableView,
    requestAxiomRef,
    confirmAxiomRef,
    toggleAxiomsCollapsed
  };
}

export type AxiomCommands = ReturnType<typeof createAxiomCommands>;
