// 导入协调命令：普通导入只写 document 投影，smart import 额外调用 agent。
// 依赖图固定为 import coordinator → agent → document；document 不再反向引用 agent。

import { isSupportedLibraryImport, persistActiveDocId } from '../lib/doc-utils.js';
import { importService } from '../data/repositories.js';
import type { AgentCommands } from './agent-commands.js';
import type { DocumentCommands, DocumentOpenedDocLike } from './document-commands.js';
import type { EditorCommands } from './editor-commands.js';
import type { LibraryEntry } from '../../backend/library/library-fs.js';

export interface ImportCommandDeps {
  docState: {
    loadComplete(docId: unknown, label?: string): Promise<DocumentOpenedDocLike | null>;
    refreshList(): Promise<unknown>;
    refreshLibrary(): Promise<unknown>;
  };
  document: Pick<DocumentCommands, 'refreshDocs'>;
  editor: Pick<EditorCommands, 'confirmLeaveEditMode'>;
  agent: Pick<AgentCommands, 'runAgentRequest'>;
  ui: {
    setBusy(value: boolean): void;
    setNotice(message: string): void;
    setProgress(value: unknown): void;
    setOperationLock(value: unknown): void;
  };
  view: {
    getSelectedLibraryEntry(): LibraryEntry | null;
    setSelectedLibraryEntry(entry: unknown): void;
  };
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | null | undefined)?.message || error || '');
}

export function createImportCommands(getDeps: () => ImportCommandDeps) {
  async function importFiles(mode = 'simple', options: { chunkSize?: number; overlap?: number } = {}) {
    const deps = getDeps();
    const { ui, view, docState, editor } = deps;
    const rawMode = String(mode || 'simple').trim();
    const importMode = ['simple', 'complete', 'direct', 'smart', 'vector'].includes(rawMode) ? rawMode : 'simple';
    const selectedLibraryEntry = view.getSelectedLibraryEntry();
    if (importMode === 'smart') {
      if (selectedLibraryEntry?.type !== 'file') {
        ui.setNotice('智能导入请先在库里选中要导入的文件');
        return;
      }
      try {
        // 智能导入不在前端/后端落库：后端构造任务 prompt，前端以 full 档发起一次 agent 会话，
        // agent 自主跑 smart-import skill（观察源文 → 写脚本 → 校验 → 入库），过程在 AgentPanel 可见。
        const task = await importService.smartImportTask({ relativePath: selectedLibraryEntry.relativePath }) as { mode?: string; prompt?: string } | null;
        await deps.agent.runAgentRequest({ mode: task?.mode || 'full', prompt: task?.prompt || '' });
        // agent 跑 db import-json 直接入库、不一定进 runAgent 的 changedDocIds，显式刷新库与文档列表。
        await docState.refreshLibrary();
        await docState.refreshList();
      } catch (error) {
        ui.setNotice(errorMessage(error) || '智能导入发起失败');
      }
      return;
    }
    if (selectedLibraryEntry?.type === 'file' && !isSupportedLibraryImport(selectedLibraryEntry)) {
      ui.setNotice(`不支持导入格式：${selectedLibraryEntry.extension || '未知格式'}`);
      return;
    }
    const canLeave = await editor.confirmLeaveEditMode();
    if (!canLeave) return;
    ui.setBusy(true);
    ui.setOperationLock({ label: '正在处理导入……', step: 0, total: 0 });
    try {
      // 向量式导入的切块参数（对话框收集）：缺省不带字段，后端 normalizeVectorChunkOptions 用默认 512/10%。
      const payload: Record<string, unknown> = { mode: importMode };
      if (importMode === 'vector') {
        if (Number.isFinite(Number(options.chunkSize))) payload.chunkSize = Math.floor(Number(options.chunkSize));
        if (Number.isFinite(Number(options.overlap))) payload.overlap = Number(options.overlap);
      }
      const importedRaw = selectedLibraryEntry?.type === 'file' && importService.canImportLibraryDocument()
        ? await importService.importLibraryDocument({ relativePath: selectedLibraryEntry.relativePath, ...payload })
        : await importService.chooseImportFile(payload);
      const imported = (Array.isArray(importedRaw) ? importedRaw : []) as Array<{ doc?: { id?: unknown }; [extra: string]: unknown }>;
      if (imported.length) {
        const last = imported[imported.length - 1];
        ui.setOperationLock({ label: '正在打开文档……', step: 0, total: 0 });
        const opened = await docState.loadComplete(last.doc?.id, '正在打开文档……');
        view.setSelectedLibraryEntry(null);
        persistActiveDocId(opened?.doc?.id || last?.doc?.id);
        ui.setBusy(false);
        ui.setProgress(null);
        ui.setOperationLock(null);
        ui.setNotice(`已导入 ${imported.length} 份文档`);
        deps.document.refreshDocs(null).catch(() => {});
      } else {
        ui.setBusy(false);
        ui.setProgress(null);
        ui.setOperationLock(null);
      }
    } catch (error) {
      ui.setNotice(errorMessage(error));
      ui.setBusy(false);
      ui.setProgress(null);
      ui.setOperationLock(null);
    }
  }

  return { importFiles };
}

export type ImportCommands = ReturnType<typeof createImportCommands>;
