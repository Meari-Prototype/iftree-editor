import { ChevronDown, FileText, ListTree, LocateFixed, Minus, Square, Upload, X
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '../data/window-service.js';

const IMPORT_MODE_OPTIONS = [
  { mode: 'simple', label: '简单导入' },
  { mode: 'complete', label: '完整导入' },
  { mode: 'smart', label: '智能导入', disabled: true, title: '智能导入依赖 LLM skill，当前入口未接入' },
  { mode: 'direct', label: '直接导入' },
  { mode: 'vector', label: '向量导入', disabled: true, title: '向量导入入口未接入普通文档导入' }
];

export function ViewPromptCard({ selectedLibraryEntry, onImport }) {
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef(null);

  useEffect(() => {
    if (!importMenuOpen) return undefined;
    const closeImportMenu = (event) => {
      if (!importMenuRef.current?.contains(event.target)) setImportMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeImportMenu);
    return () => window.removeEventListener('pointerdown', closeImportMenu);
  }, [importMenuOpen]);

  const runImport = (mode) => {
    setImportMenuOpen(false);
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
                disabled={option.disabled === true}
                title={option.title || option.label}
                onClick={() => runImport(option.mode)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ViewAlignedEmptyState({ activeTab, selectedLibraryEntry, onImport }) {
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

/** @param {{ onClose?: any, title?: string }} props */
export function WindowTitlebar({ onClose, title = '条件树编辑器' }) {
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

// 统一的命令式确认弹窗。actions 自上而下渲染为按钮，每个 { value, label, autoFocus? }
// 点击时回调 onChoose(value)；点击遮罩回调 onChoose(backdropValue)。
export function ChoiceDialog({ open, title, message, actions = [], backdropValue, onChoose }) {
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

export function DepthCollapseOneIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1.2 2.2" fill="none" />
      <path d="M13 8H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M10 5 7 8l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function DepthExpandOneIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1.2 2.2" fill="none" />
      <path d="M8 8h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M10 5 13 8l-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function IconButton({ children, title, onClick, disabled = false }) {
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

export function LocateNodeButton({ title = '定位节点', label = '定位节点', className = '', disabled = false, onClick }) {
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
