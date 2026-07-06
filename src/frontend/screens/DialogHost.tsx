// 对话框簇（frontend-refactor.md §6 阶段 3）：编辑分支 diff / merge 冲突 / 事实前提引用
// 选择框 / 三个 ChoiceDialog / 全局进度遮罩，从 AppBody JSX 原样迁入。
// merge 冲突面板直接订阅 editorStore 的 conflict 态（阶段 1 状态机），不再经 props。

import { ChoiceDialog } from '../components/common.jsx';
import { EditBranchDiffDialog } from '../components/EditBranchDiffDialog.jsx';
import { MergeConflictDialog } from '../components/MergeConflictDialog.jsx';
import { ProgressOverlay } from '../components/ProgressOverlay.jsx';
import { useAppUIContext } from '../hooks/useAppUI.js';
import { useAppState } from '../app-context.js';
import { useCommands } from '../commands/commands-context.js';
import { useStoreSelector } from '../stores/use-store.js';

export function DialogHost() {
  const { progress, operationLock, lockedProgress } = useAppUIContext();
  const { dialogs, editorStore, summary } = useAppState();
  const { editor } = useCommands();
  const editorPhase = useStoreSelector(editorStore, (state) => state.phase);
  const {
    editExitDialog, startupEditBranchDialog, agentApprovalEditDialog,
    axiomRefDialog, setAxiomRefDialog, confirmAxiomRefDialog, cancelAxiomRefDialog,
    editBranchDiffDialog, closeEditBranchDiff
  } = dialogs;

  return (
    <>
      {editBranchDiffDialog.open && (
        <EditBranchDiffDialog
          view={editBranchDiffDialog.view}
          loading={editBranchDiffDialog.loading}
          error={editBranchDiffDialog.error}
          onClose={closeEditBranchDiff}
        />
      )}

      {editorPhase.kind === 'conflict' && (
        <MergeConflictDialog
          view={editorPhase.view as Parameters<typeof MergeConflictDialog>[0]['view']}
          applying={editorPhase.applying}
          error={editorPhase.error}
          onApply={editor.applyMergeResolutions}
          onDiscard={editor.discardMergeBlockedBranch}
          onClose={editor.closeMergeConflictDialog}
        />
      )}

      <ChoiceDialog
        open={editExitDialog.open}
        title="退出编辑模式"
        message={'当前文档处于编辑模式，影子分支里可能有未保存的临时 diff。选择"保存"把它们按顺序合并进文档历史；选择"丢弃"丢掉本次全部编辑，主文档保持不变。'}
        backdropValue="cancel"
        onChoose={editExitDialog.resolve}
        actions={[
          { value: 'cancel', label: '取消' },
          { value: 'discard', label: '丢弃' },
          { value: 'save', label: '保存' }
        ]}
      />

      <ChoiceDialog
        open={startupEditBranchDialog.open}
        title="恢复编辑状态"
        message={`检测到「${startupEditBranchDialog.payload?.base_title || startupEditBranchDialog.payload?.shadow_title || '当前文档'}」存在未保存编辑状态。`}
        backdropValue="stash"
        onChoose={startupEditBranchDialog.resolve}
        actions={[
          { value: 'discard', label: '丢弃' },
          { value: 'stash', label: '暂存' },
          { value: 'restore', label: '恢复', autoFocus: true }
        ]}
      />

      <ChoiceDialog
        open={agentApprovalEditDialog.open}
        title="接受 LLM 变更"
        message="接受 LLM 变更需要进入编辑模式。是否进入？"
        backdropValue="cancel"
        onChoose={agentApprovalEditDialog.resolve}
        actions={[
          { value: 'cancel', label: '取消' },
          { value: 'enter', label: '进入编辑模式', autoFocus: true }
        ]}
      />

      {axiomRefDialog && (
        <div className="dialog-overlay" onClick={cancelAxiomRefDialog}>
          <form
            className="dialog-box node-dialog"
            onClick={(event) => event.stopPropagation()}
            onSubmit={confirmAxiomRefDialog}
          >
            <header className="dialog-header">添加事实前提引用</header>
            <label className="dialog-field">
              <span>事实前提</span>
              <select
                className="dialog-input"
                value={String(axiomRefDialog.axiomId ?? '')}
                onChange={(event) => setAxiomRefDialog((current) => current ? {
                  ...current,
                  axiomId: event.target.value
                } : current)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') cancelAxiomRefDialog();
                  event.stopPropagation();
                }}
                autoFocus
              >
                {(axiomRefDialog.options ?? []).map((axiom: { id?: unknown; label?: string; content?: string; [k: string]: unknown }) => (
                  <option key={String(axiom.id ?? '')} value={String(axiom.id ?? '')}>
                    {axiom.label} {axiom.content}
                  </option>
                ))}
              </select>
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={cancelAxiomRefDialog}>取消</button>
              <button type="submit">确定</button>
            </div>
          </form>
        </div>
      )}

      <ProgressOverlay
        progress={progress as Parameters<typeof ProgressOverlay>[0]['progress']}
        lockedProgress={lockedProgress as Parameters<typeof ProgressOverlay>[0]['lockedProgress']}
        locked={Boolean(operationLock)}
        onCancel={summary.cancelSummaryGeneration}
      />
    </>
  );
}
