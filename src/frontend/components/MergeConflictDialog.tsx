import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';

type MergeConflict = Record<string, unknown> & { field: string };
type MergeNode = Record<string, unknown> & {
  id: string | number;
  address?: string | number;
  title?: string;
  conflicts?: MergeConflict[];
  resolution?: string;
};
// blocked 失配条目（后端 blockedConflicts 回带，仅渲染用）。
type BlockedConflict = {
  id?: string | number;
  kind?: string;
  address?: string | number;
  reason?: string;
};
type ConflictItem = { node: MergeNode; conflict: MergeConflict };
type PickChoice = 'ours' | 'theirs' | 'fill';
type PickState = Record<string, { pick?: PickChoice; value?: string }>;
type MergeConflictDialogProps = {
  view?: Record<string, unknown> | null;
  applying?: boolean;
  error?: string;
  onApply?: (resolutions: Array<{ id: string; field: string; pick: PickChoice; value?: string }>) => void;
  onDiscard?: () => void;
  onClose?: () => void;
};

const FIELD_LABELS: Record<string, string> = {
  text: '正文',
  node_title: '标题',
  node_note: '备注',
  node_type: '类型',
  trust_level: '信任',
  parent_id: '父节点'
};

function fieldLabel(field: string) {
  if (field === '__node__') return '存在性（删除/修改）';
  if (field === '__parent__') return '挂载父节点（主干已删）';
  return FIELD_LABELS[field] || field;
}

const isFieldConflict = (conflict: MergeConflict) => conflict.field !== '__node__' && conflict.field !== 'parent_id' && conflict.field !== '__parent__';

// 与后端 resolveConflictEntries 的 v1 边界对齐：parent_id 结构冲突、复活己删节点（主干删+分支改）、
// 主干删父+分支在其下新增/移入（__parent__）不能在此自动应用。
function conflictSupport(conflict: MergeConflict): { resolvable: boolean; reason?: string } {
  if (conflict.field === 'parent_id') {
    return { resolvable: false, reason: '父节点重挂冲突需手动处理（v1 暂不支持在此裁决）' };
  }
  if (conflict.field === '__parent__') {
    return { resolvable: false, reason: '主干已删除其父节点、分支又在其下新增/移入——复活父节点暂不支持，请在分支侧处理后再合并' };
  }
  if (conflict.field === '__node__' && conflict.ours === 'deleted') {
    return { resolvable: false, reason: '主干已删、分支又改——复活节点暂不支持，请在分支侧处理后再合并' };
  }
  return { resolvable: true };
}

export function MergeConflictDialog({ view, applying = false, error = '', onApply, onDiscard, onClose }: MergeConflictDialogProps) {
  // blocked：非快进保存的逐条前置验证发现结构性失配（主干删了被改/被挂载的节点、并发移动、
  // 拆分/并入的内容漂移）——v1 不可裁，只能放弃本次编辑；取消可保留分支自行留存改动。
  const blocked = Boolean(view?.blocked);
  const blockedConflicts = (view?.blockedConflicts || []) as BlockedConflict[];
  const conflictNodes = useMemo<MergeNode[]>(
    () => ((view?.nodes || []) as MergeNode[]).filter((node) => node.resolution === 'conflict'),
    [view?.nodes]
  );
  const allConflicts = useMemo(() => {
    const out: ConflictItem[] = [];
    for (const node of conflictNodes) {
      for (const conflict of node.conflicts || []) out.push({ node, conflict });
    }
    return out;
  }, [conflictNodes]);

  const [picks, setPicks] = useState<PickState>({});
  useEffect(() => { setPicks({}); }, [view]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const keyOf = (id: string | number, field: string) => `${id}::${field}`;
  const setPick = (id: string | number, field: string, pick: PickChoice, fillSeed?: string) => {
    setPicks((cur) => ({
      ...cur,
      [keyOf(id, field)]: { pick, value: pick === 'fill' ? (cur[keyOf(id, field)]?.value ?? fillSeed ?? '') : (cur[keyOf(id, field)]?.value ?? '') }
    }));
  };
  const setFill = (id: string | number, field: string, value: string) => {
    setPicks((cur) => ({ ...cur, [keyOf(id, field)]: { pick: 'fill', value } }));
  };

  const hasUnresolvable = allConflicts.some(({ conflict }) => !conflictSupport(conflict).resolvable);
  const allChosen = allConflicts
    .filter(({ conflict }) => conflictSupport(conflict).resolvable)
    .every(({ node, conflict }) => {
      const p = picks[keyOf(node.id, conflict.field)];
      if (!p?.pick) return false;
      if (p.pick === 'fill') return String(p.value ?? '').length > 0;
      return true;
    });
  const canApply = !applying && !hasUnresolvable && allChosen && allConflicts.length > 0;

  function buildResolutions() {
    const out: Array<{ id: string; field: string; pick: PickChoice; value?: string }> = [];
    for (const { node, conflict } of allConflicts) {
      if (!conflictSupport(conflict).resolvable) continue;
      const p = picks[keyOf(node.id, conflict.field)];
      if (!p?.pick) continue;
      const res: { id: string; field: string; pick: PickChoice; value?: string } = { id: String(node.id), field: conflict.field, pick: p.pick };
      if (p.pick === 'fill') res.value = String(p.value ?? '');
      out.push(res);
    }
    return out;
  }

  const resolutionErrors = (view?.resolutionErrors || []) as Record<string, unknown>[];

  return (
    <div className="dialog-overlay merge-conflict-overlay" onMouseDown={() => onClose?.()}>
      <section
        className="dialog-box merge-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="合并冲突解决"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="merge-conflict-header">
          <div>
            <strong>{blocked ? '无法保存' : '合并冲突'}</strong>
            <span>
              {blocked
                ? `${blockedConflicts.length} 处结构性失配 · 主干已被修改`
                : `${allConflicts.length} 处冲突 · base / 主干 / 本分支`}
            </span>
          </div>
          <button type="button" className="diff-dialog-close" aria-label="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        {error ? <div className="merge-conflict-state error">{error}</div> : null}
        {blocked ? (
          <div className="merge-conflict-state error">
            {(view?.message as string) || '主干已被修改，无法保存，请放弃本次编辑'}
            ——「取消」可保留编辑分支（先自行留存这些改动），「放弃本次编辑」将丢弃分支并退出。
          </div>
        ) : null}
        {!blocked && hasUnresolvable ? (
          <div className="merge-conflict-state warn">
            含结构冲突（父节点重挂 / 复活己删节点 / 主干已删父节点），v1 不能在此自动应用——请在分支侧处理后再合并。
          </div>
        ) : null}
        {blocked && blockedConflicts.length > 0 ? (
          <div className="merge-conflict-scroll">
            {blockedConflicts.map((item, index) => (
              <article key={`${item.id}:${item.kind}:${index}`} className="merge-conflict-row unresolvable">
                <header>
                  <code>{item.address || item.id}</code>
                  <em>{item.kind}</em>
                </header>
                <div className="merge-conflict-actions disabled">{item.reason}</div>
              </article>
            ))}
          </div>
        ) : null}

        {blocked ? null : (
        <div className="merge-conflict-scroll">
          {allConflicts.length === 0 ? (
            <div className="merge-conflict-state">没有冲突</div>
          ) : allConflicts.map(({ node, conflict }) => {
            const support = conflictSupport(conflict);
            const k = keyOf(node.id, conflict.field);
            const p = picks[k];
            return (
              <article key={k} className={`merge-conflict-row ${support.resolvable ? '' : 'unresolvable'}`}>
                <header>
                  <code>{node.address || node.id}</code>
                  {node.title ? <strong>{node.title}</strong> : null}
                  <em>{fieldLabel(conflict.field)}</em>
                </header>
                <div className="merge-conflict-cols">
                  <div className="merge-col base"><span>base</span><p>{String(conflict.base ?? '—')}</p></div>
                  <div className="merge-col ours"><span>主干</span><p>{String(conflict.ours ?? '—')}</p></div>
                  <div className="merge-col theirs"><span>本分支</span><p>{String(conflict.theirs ?? '—')}</p></div>
                </div>
                {support.resolvable ? (
                  <div className="merge-conflict-actions">
                    <button type="button" className={p?.pick === 'ours' ? 'active' : ''} onClick={() => setPick(node.id, conflict.field, 'ours')}>取主干</button>
                    <button type="button" className={p?.pick === 'theirs' ? 'active' : ''} onClick={() => setPick(node.id, conflict.field, 'theirs')}>取本分支</button>
                    {isFieldConflict(conflict) ? (
                      <button type="button" className={p?.pick === 'fill' ? 'active' : ''} onClick={() => setPick(node.id, conflict.field, 'fill', String(conflict.ours ?? ''))}>填值</button>
                    ) : null}
                    {p?.pick === 'fill' ? (
                      <textarea
                        className="merge-fill"
                        value={p.value ?? ''}
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setFill(node.id, conflict.field, event.target.value)}
                        placeholder="填入合并后的值"
                      />
                    ) : null}
                  </div>
                ) : (
                  <div className="merge-conflict-actions disabled">{support.reason}</div>
                )}
              </article>
            );
          })}
        </div>
        )}

        {resolutionErrors.length > 0 ? (
          <div className="merge-conflict-state error">
            未能应用：{resolutionErrors.map((e) => `${e.id} ${e.field}（${e.reason}）`).join('；')}
          </div>
        ) : null}

        <footer className="merge-conflict-footer">
          <button type="button" onClick={onClose}>取消（保留分支）</button>
          {blocked ? (
            <button type="button" className="primary" disabled={applying} onClick={() => onDiscard?.()}>
              {applying ? '处理中…' : '放弃本次编辑'}
            </button>
          ) : (
            <button type="button" className="primary" disabled={!canApply} onClick={() => onApply?.(buildResolutions())}>
              {applying ? '应用中…' : '应用合并'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
