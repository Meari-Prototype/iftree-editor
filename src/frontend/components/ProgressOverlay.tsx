import { X } from 'lucide-react';
import type { MouseEventHandler } from 'react';
import { progressCountText } from '../lib/ui-utils.js';

interface ProgressState {
  label: string;
  total: number;
  step: number;
  cancelable?: boolean;
}

interface ProgressBarProps {
  progress?: ProgressState | null;
  onCancel?: MouseEventHandler<HTMLButtonElement> | null;
}

function ProgressBar({ progress, onCancel }: ProgressBarProps) {
  if (!progress) return null;
  return (
    <>
      <div className="progress-header">
        <span className="progress-label">{progress.label}</span>
        {progress.total > 0 && (
          <span className="progress-count">{progressCountText(progress)}</span>
        )}
        {progress.cancelable && (
          <button type="button" className="progress-cancel-button" onClick={onCancel || undefined} title="取消" aria-label="取消">
            <X size={14} />
            <span>取消</span>
          </button>
        )}
      </div>
      <div className="progress-track">
        <div
          className={`progress-fill${progress.total === 0 ? ' progress-fill--indeterminate' : ''}`}
          style={progress.total > 0 ? { width: `${Math.round(progress.step / progress.total * 100)}%` } : undefined}
        />
      </div>
    </>
  );
}

interface ProgressOverlayProps {
  progress?: ProgressState | null;
  lockedProgress?: ProgressState | null;
  locked?: boolean;
  onCancel?: MouseEventHandler<HTMLButtonElement> | null;
}

export function ProgressOverlay({ progress, lockedProgress, locked = false, onCancel = null }: ProgressOverlayProps) {
  if (locked && lockedProgress) {
    return (
      <div className="operation-lock-overlay" aria-live="polite" aria-busy="true">
        <div className="operation-lock-card">
          <ProgressBar progress={lockedProgress} onCancel={onCancel} />
        </div>
      </div>
    );
  }
  if (!locked && progress) {
    return (
      <div className="progress-overlay">
        <ProgressBar progress={progress} onCancel={onCancel} />
      </div>
    );
  }
  return null;
}
