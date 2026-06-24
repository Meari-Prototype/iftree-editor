// @ts-nocheck
import { Gauge, Lock,
  RotateCcw, SlidersHorizontal, Unlock
} from 'lucide-react';
import { DEFAULT_NODE_LAYOUT } from '../../../core/mindmap.js';


export function NodeLayoutSettingsPanel({
  title = '节点调整',
  description = '节点卡片尺寸、比例和正文留白写入数据库；只读模式下保持锁定。',
  settings,
  disabled,
  onChange,
  onNumberChange,
  treeEditMode,
  onToggleTreeEditMode
}) {
  const values = settings || DEFAULT_NODE_LAYOUT;
  const modeLabel = values.mode === 'goldenRatio' ? '等比' : '等宽';
  const saveDefaults = () => onChange?.({ ...DEFAULT_NODE_LAYOUT });

  return (
    <>
      <header className="settings-header settings-header-row">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <button
          type="button"
          className={`tree-lock-button ${treeEditMode ? 'editing' : ''}`}
          title={treeEditMode ? '退出编辑模式并保存' : '进入编辑模式'}
          aria-pressed={treeEditMode}
          onClick={onToggleTreeEditMode}
        >
          {treeEditMode ? <Unlock size={16} /> : <Lock size={16} />}
          <span>{treeEditMode ? '编' : '锁'}</span>
        </button>
      </header>

      {disabled && (
        <div className="settings-warning">
          当前为只读模式。点右上角锁按钮进入编辑模式后，才能调整节点尺寸参数。
        </div>
      )}

      <section className="settings-group">
        <header>
          <h2>渲染模式</h2>
          <span>{modeLabel}</span>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-icon"><SlidersHorizontal size={17} /></div>
            <div className="settings-row-text">
              <strong>节点渲染模式</strong>
              <span>等宽使用统一默认宽度；等比使用横向黄金卡片，高度为宽度的 0.618。</span>
            </div>
            <div className="settings-row-control">
              <select
                value={values.mode || 'equalWidth'}
                disabled={disabled}
                onChange={(event) => onChange?.({ mode: event.target.value })}
              >
                <option value="equalWidth">等宽</option>
                <option value="goldenRatio">等比</option>
              </select>
            </div>
          </div>

          <NodeLayoutNumberRow
            icon={<SlidersHorizontal size={17} />}
            label="默认卡片宽度"
            detail="未手动调整过的节点会使用这个宽度。"
            value={values.defaultWidth}
            min={values.minWidth}
            max={values.maxWidth}
            disabled={disabled}
            onChange={(value) => onNumberChange?.('defaultWidth', value)}
          />
          <NodeLayoutNumberRow
            icon={<SlidersHorizontal size={17} />}
            label="默认卡片高度"
            detail="等宽模式的最小默认高度；等比模式仍会受比例约束。"
            value={values.defaultHeight}
            min={values.minHeight}
            max={values.maxHeight}
            disabled={disabled}
            onChange={(value) => onNumberChange?.('defaultHeight', value)}
          />
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>尺寸边界</h2>
          <span>px</span>
        </header>
        <div className="settings-list">
          <NodeLayoutNumberRow label="最小宽度" value={values.minWidth} min={40} max={values.maxWidth} disabled={disabled} onChange={(value) => onNumberChange?.('minWidth', value)} />
          <NodeLayoutNumberRow label="最大宽度" value={values.maxWidth} min={values.minWidth} max={100000} disabled={disabled} onChange={(value) => onNumberChange?.('maxWidth', value)} />
          <NodeLayoutNumberRow label="最小高度" value={values.minHeight} min={24} max={values.maxHeight} disabled={disabled} onChange={(value) => onNumberChange?.('minHeight', value)} />
          <NodeLayoutNumberRow label="最大高度" value={values.maxHeight} min={values.minHeight} max={1000000} disabled={disabled} onChange={(value) => onNumberChange?.('maxHeight', value)} />
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>内部留白</h2>
          <span>布局参数</span>
        </header>
        <div className="settings-list">
          <NodeLayoutNumberRow
            label="正文左右内边距"
            detail="影响正文换行估算和 Canvas 绘制位置。"
            value={values.paddingX}
            min={4}
            max={48}
            disabled={disabled}
            onChange={(value) => onNumberChange?.('paddingX', value)}
          />
          <NodeLayoutNumberRow
            label="备注间距"
            detail="备注仍然挂在节点下方，不包进卡片里。"
            value={values.noteGap}
            min={0}
            max={120}
            disabled={disabled}
            onChange={(value) => onNumberChange?.('noteGap', value)}
          />
          <div className="settings-row">
            <div className="settings-row-icon"><RotateCcw size={17} /></div>
            <div className="settings-row-text">
              <strong>恢复全局默认</strong>
              <span>只恢复全局参数，不清除单个节点已经保存的宽高。</span>
            </div>
            <div className="settings-row-control">
              <button type="button" disabled={disabled} onClick={saveDefaults}>恢复默认</button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export function NodeLayoutNumberRow({ icon = null, label, detail = '', value, min, max, disabled, onChange }) {
  return (
    <div className="settings-row">
      <div className="settings-row-icon">{icon || <Gauge size={17} />}</div>
      <div className="settings-row-text">
        <strong>{label}</strong>
        <span>{detail || `范围 ${min} - ${max}`}</span>
      </div>
      <div className="settings-row-control">
        <input
          type="number"
          min={min}
          max={max}
          value={Number.isFinite(Number(value)) ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </div>
    </div>
  );
}
