// AppStateContext：装配根（App.tsx 的 AppBody）持有的领域 hook 实例与横切视图态，
// 经此下发给 screens/*（frontend-refactor.md §6 阶段 3——render 拆分后的数据通道）。
//
// 定位是**过渡形态**：数据真相仍住各 hook（docState/treeView/selection/...），context 只是
// 把「原来同组件内的闭包可见性」显式化，消掉几十个 props drill；阶段 4/5 store 化后，
// 屏幕组件改用 stores/use-store.ts 的 selector 订阅，本 context 逐域瘦身。
// 命令层另走 commands/commands-context.ts（useCommands），不混在这里。

import { createContext, useContext, type Dispatch, type FormEvent, type SetStateAction } from 'react';

import type { useDocumentState } from './hooks/useDocumentState.js';
import type { useTreeViewState } from './hooks/useTreeViewState.js';
import type { useEntityTrace } from './hooks/useEntityTrace.js';
import type { useNodeSelection } from './hooks/useNodeSelection.js';
import type { useLayout } from './hooks/useLayout.js';
import type { useSettings } from './hooks/useSettings.js';
import type { useAgentChat } from './hooks/useAgentChat.js';
import type { useSummaryRun } from './hooks/useSummaryRun.js';
import type { usePromptDialog } from './hooks/usePromptDialog.js';
import type { EditBranchDiffViewModel } from './components/EditBranchDiffDialog.jsx';
import type { Store } from './stores/create-store.js';
import type { EditorState } from './stores/editor-store.js';
import type { AxiomRefDialogPayload } from './commands/axiom-commands.js';
import type { EditBranchRow } from '../backend/db/schema.js';
import type { VectorContentSearchItem } from './data/operation-services.js';
import type { AppTab } from './hooks/useAppUI.js';

export interface AppState {
  docState: ReturnType<typeof useDocumentState>;
  treeView: ReturnType<typeof useTreeViewState>;
  // 住在装配根而非 WorkspacePane：设置屏是组件级切换（EditorScreen 整棵卸载），
  // 实体面板的检索/选中/分页状态必须在常驻组件里才能在 settings 往返间存活。
  entityTrace: ReturnType<typeof useEntityTrace>;
  selection: ReturnType<typeof useNodeSelection>;
  layout: ReturnType<typeof useLayout>;
  settingsState: ReturnType<typeof useSettings>;
  agentChat: ReturnType<typeof useAgentChat>;
  editorStore: Store<EditorState>;
  summary: ReturnType<typeof useSummaryRun>;
  search: {
    query: string;
    setQuery: Dispatch<SetStateAction<string>>;
    results: VectorContentSearchItem[];
    runVectorSearch(): Promise<void> | void;
    vectorModuleDisabled: boolean;
    vectorDisabledMessage: string;
  };
  startup: {
    armRenderUnlock(docId: unknown, reason?: string): boolean;
    handleMindMapRenderReady(info?: unknown): void;
  };
  dialogs: {
    editExitDialog: ReturnType<typeof usePromptDialog>;
    startupEditBranchDialog: ReturnType<typeof usePromptDialog>;
    agentApprovalEditDialog: ReturnType<typeof usePromptDialog>;
    axiomRefDialog: AxiomRefDialogPayload | null;
    setAxiomRefDialog: Dispatch<SetStateAction<AxiomRefDialogPayload | null>>;
    confirmAxiomRefDialog(event: FormEvent<HTMLFormElement>): Promise<void>;
    cancelAxiomRefDialog(): void;
    editBranchDiffDialog: { open: boolean; loading: boolean; view: EditBranchDiffViewModel | null; error: string };
    openEditBranchDiff(option?: { branch?: EditBranchRow | null; activeEntryCount?: number; owner?: string } | null): Promise<void>;
    closeEditBranchDiff(): void;
  };
  misc: {
    treeEditMode: boolean;
    currentVisualDocId: unknown;
    handleCloseWindow(): Promise<void>;
    openSettings(): Promise<void>;
    saveAgentSettings(next: unknown): Promise<void>;
    chooseLocalModelRoot(): Promise<void>;
    downloadVectorModel(): Promise<void>;
    changeActiveTab(nextTab: AppTab): void;
  };
}

export const AppStateContext = createContext<AppState | null>(null);

export function useAppState(): AppState {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used within <AppStateContext.Provider>');
  return value;
}
