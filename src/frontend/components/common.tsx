import { ChevronDown, FileText, ListTree, LocateFixed, Minus, Square, Upload, X
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '../data/window-service.js';

interface ImportModeOption {
  mode: string;
  label: string;
  title?: string;
}

const IMPORT_MODE_OPTIONS: ImportModeOption[] = [
  { mode: 'simple', label: '简单导入' },
  { mode: 'complete', label: '完整导入' },
  { mode: 'smart', label: '智能导入', title: '调用内置 agent 按 skill 解析结构并入库（过程在 AgentPanel 可见）' },
  { mode: 'direct', label: '直接导入' },
  { mode: 'vector', label: '向量式导入', title: '按字数定长切块导入（可设块大小与重叠比例，默认块 512 字、重叠 10%），适合需要切块向量化的数据' }
];

export interface VectorImportOptions {
  chunkSize: number;
  /** 相邻块重叠 = 块长比例（0~0.9），与后端 normalizeVectorChunkOptions 口径一致。 */
  overlap: number;
}

export interface LibraryEntryLike {
  name?: string;
  type?: string;
}

// 向量式导入参数对话框：块大小 + 重叠百分比（界面按 % 收，回调换算为比例）。
function VectorImportParamsDialog({ onConfirm, onCancel }: {
  onConfirm(options: VectorImportOptions): void;
  onCancel(): void;
}) {
  const [chunkSizeText, setChunkSizeText] = useState('512');
  const [overlapText, setOverlapText] = useState('10');
  const chunkSize = Math.floor(Number(chunkSizeText));
  const overlapPercent = Number(overlapText);
  const chunkSizeValid = Number.isFinite(chunkSize) && chunkSize >= 1;
  // 上限 90%：与后端 normalizeVectorChunkOptions 的 0.9 夹紧一致（重叠 ≥ 块长切不动）。
  const overlapValid = Number.isFinite(overlapPercent) && overlapPercent >= 0 && overlapPercent <= 90;
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-box node-dialog" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-header">向量式导入参数</header>
        <label className="dialog-field">
          <span>块大小（字符数，默认 512）</span>
          <input
            className="dialog-input"
            type="number"
            min={1}
            value={chunkSizeText}
            onChange={(event) => setChunkSizeText(event.target.value)}
            autoFocus
          />
        </label>
        <label className="dialog-field">
          <span>相邻块重叠（占块长 %，0-90，默认 10）</span>
          <input
            className="dialog-input"
            type="number"
            min={0}
            max={90}
            value={overlapText}
            onChange={(event) => setOverlapText(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button
            type="button"
            disabled={!chunkSizeValid || !overlapValid}
            onClick={() => onConfirm({ chunkSize, overlap: overlapPercent / 100 })}
          >
            导入
          </button>
          <button type="button" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  );
}

interface ViewPromptCardProps {
  selectedLibraryEntry: LibraryEntryLike | null | undefined;
  onImport?: (mode: string, options?: VectorImportOptions) => void;
}

export function ViewPromptCard({ selectedLibraryEntry, onImport }: ViewPromptCardProps) {
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [vectorParamsOpen, setVectorParamsOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!importMenuOpen) return undefined;
    const closeImportMenu = (event: PointerEvent): void => {
      if (!importMenuRef.current?.contains(event.target as Node)) setImportMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeImportMenu);
    return () => window.removeEventListener('pointerdown', closeImportMenu);
  }, [importMenuOpen]);

  const runImport = (mode: string): void => {
    setImportMenuOpen(false);
    // 向量式导入先收 chunkSize/overlap 参数再执行；其它模式直接跑。
    if (mode === 'vector') {
      setVectorParamsOpen(true);
      return;
    }
    onImport?.(mode);
  };

  if (!selectedLibraryEntry) {
    return <div className="view-prompt-card"><span>未打开文档。</span></div>;
  }
  return (
    <div className="view-prompt-card">
      <div className="view-prompt-title">
        <FileText size={18} />
        <strong>{selectedLibraryEntry.name}</strong>
      </div>
      <span>未导入原始文件，请先手动导入。</span>
      <div className="view-import-actions import-menu-anchor" ref={importMenuRef}>
        <button type="button" onClick={() => runImport('simple')}>
          <Upload size={14} />
          手动导入
        </button>
        <button
          type="button"
          className="import-menu-toggle view-import-toggle"
          title="选择导入模式"
          aria-label="选择导入模式"
          onClick={() => setImportMenuOpen((open) => !open)}
        >
          <ChevronDown size={12} />
        </button>
        {importMenuOpen && (
          <div className="import-mode-menu view-import-mode-menu">
            {IMPORT_MODE_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                title={option.title || option.label}
                onClick={() => runImport(option.mode)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {vectorParamsOpen && (
        <VectorImportParamsDialog
          onConfirm={(options) => {
            setVectorParamsOpen(false);
            onImport?.('vector', options);
          }}
          onCancel={() => setVectorParamsOpen(false)}
        />
      )}
    </div>
  );
}

interface ViewAlignedEmptyStateProps {
  activeTab?: string;
  selectedLibraryEntry: LibraryEntryLike | null | undefined;
  onImport?: (mode: string, options?: VectorImportOptions) => void;
}

export function ViewAlignedEmptyState({ activeTab, selectedLibraryEntry, onImport }: ViewAlignedEmptyStateProps) {
  const prompt = <ViewPromptCard selectedLibraryEntry={selectedLibraryEntry} onImport={onImport} />;
  if (activeTab === 'ide') {
    return (
      <div className="ide-surface">
        <div className="ide-editor">
          <div className="ide-header" aria-hidden="true">
            <span>节点位置</span>
            <span />
            <span>句子编号</span>
            <span />
            <span>正文</span>
            <span />
          </div>
          <div className="ide-node ide-empty-row">
            <span />
            <span />
            <span />
            <span />
            <div className="ide-empty-body">{prompt}</div>
            <span />
          </div>
        </div>
      </div>
    );
  }
  if (activeTab === 'rich') {
    return (
      <div className="rich-surface source-rich-surface">
        <article className="source-document missing-source">
          <div className="source-reader">
            <div className="source-block source-missing-block">
              <span className="source-gutter-cell" aria-hidden="true" />
              <span className="source-gutter-cell source-gutter-sentence" aria-hidden="true" />
              <div className="source-block-body">{prompt}</div>
            </div>
          </div>
        </article>
      </div>
    );
  }
  if (activeTab === 'entity' || activeTab === 'keyword' || activeTab === 'search') {
    return <div className="search-surface view-empty-search">{prompt}</div>;
  }
  return (
    <div className="view-empty-canvas">
      {prompt}
    </div>
  );
}

export function WindowTitlebar({ onClose, title = '条件树编辑器' }: { onClose?: () => void; title?: string }) {
  const close = onClose || (() => closeWindow?.());
  return (
    <header className="app-titlebar">
      <div className="app-titlebar-drag" onDoubleClick={() => toggleMaximizeWindow?.()}>
        <span className="app-titlebar-icon"><ListTree size={13} /></span>
        <span className="app-titlebar-title">{title}</span>
      </div>
      <div className="app-titlebar-controls">
        <button type="button" title="最小化" aria-label="最小化" onClick={() => minimizeWindow?.()}>
          <Minus size={13} />
        </button>
        <button type="button" title="最大化或还原" aria-label="最大化或还原" onClick={() => toggleMaximizeWindow?.()}>
          <Square size={12} />
        </button>
        <button type="button" className="app-titlebar-close" title="关闭" aria-label="关闭" onClick={close}>
          <X size={14} />
        </button>
      </div>
    </header>
  );
}

export interface ChoiceDialogAction {
  value: string;
  label: string;
  autoFocus?: boolean;
}

interface ChoiceDialogProps {
  open: boolean;
  title?: ReactNode;
  message?: ReactNode;
  actions?: ChoiceDialogAction[];
  backdropValue?: string;
  onChoose?: (value: string | undefined) => void;
}

// 统一的命令式确认弹窗。actions 自上而下渲染为按钮，每个 { value, label, autoFocus? }
// 点击时回调 onChoose(value)；点击遮罩回调 onChoose(backdropValue)。
export function ChoiceDialog({ open, title, message, actions = [], backdropValue, onChoose }: ChoiceDialogProps) {
  if (!open) return null;
  return (
    <div className="dialog-overlay" onClick={() => onChoose?.(backdropValue)}>
      <div className="dialog-box" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-header">{title}</header>
        <p className="dialog-message">{message}</p>
        <div className="dialog-actions">
          {actions.map((action) => (
            <button
              key={action.value}
              type="button"
              autoFocus={action.autoFocus === true}
              onClick={() => onChoose?.(action.value)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DepthCollapseOneIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1.2 2.2" fill="none" />
      <path d="M13 8H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M10 5 7 8l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function DepthExpandOneIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1.2 2.2" fill="none" />
      <path d="M8 8h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M10 5 13 8l-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

interface IconButtonProps {
  children?: ReactNode;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
}

export function IconButton({ children, title, onClick, disabled = false }: IconButtonProps) {
  return (
    <button
      className="icon-button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onClick?.();
      }}
    >
      {children}
    </button>
  );
}

interface LocateNodeButtonProps {
  title?: string;
  label?: string;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
}

export function LocateNodeButton({ title = '定位节点', label = '定位节点', className = '', disabled = false, onClick }: LocateNodeButtonProps) {
  return (
    <button
      type="button"
      className={`locate-node-button ${className}`.trim()}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onClick?.();
      }}
    >
      <LocateFixed size={14} />
      <span>{label}</span>
    </button>
  );
}
