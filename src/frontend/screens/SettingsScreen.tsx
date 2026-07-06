// 设置屏（frontend-refactor.md §6 阶段 3）：activeScreen==='settings' 的整屏渲染。
// 数据经 useAppState / useAppUIContext，命令经 useCommands——不收装配根 props。

import { WindowTitlebar } from '../components/common.jsx';
import { SettingsView } from '../components/SettingsView.jsx';
import { useAppUIContext } from '../hooks/useAppUI.js';
import { useAppState } from '../app-context.js';
import { useCommands } from '../commands/commands-context.js';

export function SettingsScreen() {
  const { busy, notice, progress, setNotice, setActiveScreen } = useAppUIContext();
  const { settingsState, agentChat, misc } = useAppState();
  const { editor } = useCommands();
  const {
    vectorSettings, memorySettings, llmSummarySettings, nodeLayoutSettings,
    saveVectorSettings, saveMemorySettings, saveLlmSummarySettings, saveNodeLayoutSettings
  } = settingsState;
  return (
    <>
      <WindowTitlebar onClose={misc.handleCloseWindow} />
      <SettingsView
        vectorSettings={vectorSettings}
        memorySettings={memorySettings}
        llmSummarySettings={llmSummarySettings}
        agentSettings={agentChat.settings}
        nodeLayoutSettings={nodeLayoutSettings}
        notice={notice}
        clearNotice={() => setNotice('')}
        onBack={() => setActiveScreen('editor')}
        onChange={saveVectorSettings}
        onMemoryChange={saveMemorySettings}
        onLlmSummaryChange={saveLlmSummarySettings}
        onAgentChange={misc.saveAgentSettings}
        onNodeLayoutChange={saveNodeLayoutSettings}
        canEditNodeLayout={misc.treeEditMode}
        treeEditMode={misc.treeEditMode}
        onToggleTreeEditMode={editor.toggleTreeEditMode}
        onChooseLocalModelRoot={misc.chooseLocalModelRoot}
        onDownloadVectorModel={misc.downloadVectorModel}
        progress={progress}
        busy={busy}
      />
    </>
  );
}
