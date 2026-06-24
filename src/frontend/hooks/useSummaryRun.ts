// @ts-nocheck
import { useEffect, useMemo, useRef, useState } from 'react';

import { appendGeneratedNote, hasGeneratedNote, plainNodeNote } from '../../core/node-notes.js';
import { flattenTree } from '../../core/tree.js';
import { summaryTargetsForMode as buildSummaryTargetsForMode } from '../../core/tree-ui.js';
import {
  depthOf,
  readPersistedSummaryNotesVisible, persistSummaryNotesVisible
} from '../lib/doc-utils.js';
import {
  normalizeSummaryStrategy, normalizeSummaryConcurrency, normalizeSummaryStrategySettings,
  summaryStrategyForMode, applySummarySkipStrategy, summarySkipBelowCount
} from '../lib/summary-utils.js';
import { documentRepository, nodeRepository, summaryService } from '../data/repositories.js';
import { useAppUIContext } from './useAppUI.js';

function summaryNodeLabel(node) {
  if (!node) return '未选中节点';
  const title = String(node.title || node.text || '').replace(/\s+/g, ' ').trim();
  return `${node.address}${title ? ` ${title.slice(0, 32)}` : ''}`;
}

function summaryStrategyModeForScope(mode) {
  return mode === 'article' ? 'node' : mode;
}

function isSummaryAbortError(error) {
  return error?.name === 'AbortError' || /aborted|abort|cancel|取消/i.test(String(error?.message || error || ''));
}

async function cancelSummaryRunRequests(run) {
  const requestIds = [...(run?.requestIds || [])];
  await Promise.allSettled(requestIds.map((requestId) => summaryService.cancelNodeSummary?.({ requestId })));
}

// 摘要生成编排：确认请求构造（generateSummary）→ 并发 worker 生成 + writeChain 串行写入
// （runSummaryGeneration）→ 取消传播。摘要备注显隐也归这里。
// 逐次写回走注入的 dispatch 轻档（undo:'none' / docsRefresh:'none' / busy:false）——
// N 次并发生成 + 串行写入，每次都走 dispatch 重档（capture + listDocs）会 N 次快照 + N 次列表拉取；
// 摘要末尾自己刷一次 listDocs。
export function useSummaryRun({
  currentDoc = null,
  treeEditMode = false,
  selectedNode = null,
  selectedNodeId = null,
  multiSelectedNodeIds = new Set(),
  llmSummarySettings = null,
  setDocs,
  dispatch
}: any = {}) {
  const { setBusy, setNotice, setProgress } = useAppUIContext();
  const [summaryNotesVisible, setSummaryNotesVisible] = useState(true);
  const summaryRunRef = useRef(null);

  const currentDocHasSummaryNotes = useMemo(() => (
    flattenTree(currentDoc?.tree).some((node) => plainNodeNote(node?.note || '').trim())
  ), [currentDoc?.tree]);

  useEffect(() => {
    setSummaryNotesVisible(readPersistedSummaryNotesVisible(currentDoc?.doc?.id));
  }, [currentDoc?.doc?.id]);

  function toggleSummaryNotesVisible() {
    if (!currentDocHasSummaryNotes) {
      setNotice('请先生成摘要');
      return;
    }
    const next = !summaryNotesVisible;
    setSummaryNotesVisible(next);
    persistSummaryNotesVisible(currentDoc?.doc?.id, next);
  }

  function summaryTargetsForMode(mode) {
    const selectedNodeIds = (mode === 'selected' || mode === 'subtree') && multiSelectedNodeIds.size > 0
      ? [...multiSelectedNodeIds]
      : selectedNodeId
        ? [selectedNodeId]
        : [];
    return (buildSummaryTargetsForMode as any)({
      tree: currentDoc?.tree,
      selectedNodeId,
      selectedNodeIds,
      mode
    });
  }

  async function generateSummary(mode) {
    if (!treeEditMode) {
      setNotice('请先进入编辑模式');
      return;
    }
    if (!summaryService.canGenerateNodeSummary()) {
      setNotice('当前版本缺少摘要生成接口，请重启应用后再试。');
      return;
    }
    if (!currentDoc?.tree) {
      setNotice('没有打开文档。');
      return;
    }
    const selectedSummaryCount = multiSelectedNodeIds.size || (selectedNodeId ? 1 : 0);
    if ((mode === 'selected' || mode === 'subtree') && selectedSummaryCount === 0) {
      setNotice('没有选中任何节点，不能生成节点摘要。');
      return;
    }

    const targets = summaryTargetsForMode(mode);
    if (targets.length === 0) {
      const selectedDepth = selectedNode ? depthOf(selectedNode.address || '1') : 1;
      setNotice(mode === 'depth' ? `当前第 ${selectedDepth} 层没有节点。` : '没有可生成摘要的目标节点。');
      return;
    }

    const strategySettings = normalizeSummaryStrategySettings(llmSummarySettings || {});
    const strategyMode = summaryStrategyModeForScope(mode);
    const strategyIndex = strategyMode === 'article' ? 0 : 1;
    const strategy = summaryStrategyForMode(llmSummarySettings, strategyMode);
    const summaryItems = [];
    let skippedGenerated = 0;
    for (const target of targets) {
      const text = String(target.text || '').trim();
      if (hasGeneratedNote(target.node.note || '')) {
        skippedGenerated += 1;
        summaryItems.push({ target, text, skip: 'generated' });
        continue;
      }
      summaryItems.push({ target, text, skip: null });
    }
    const writableItems = summaryItems.filter((item) => item.skip !== 'generated');

    if (writableItems.length === 0) {
      setNotice(`没有需要生成摘要的节点：已有 AI 摘要跳过 ${skippedGenerated} 个。`);
      return;
    }

    const scopeLabel = {
      selected: '当前选中节点',
      subtree: '当前选中节点及其子树',
      depth: `当前第 ${selectedNode ? depthOf(selectedNode.address || '1') : 1} 层节点`,
      article: '全文'
    }[mode] || '节点';
    const targetLabel = writableItems.length === 1
      ? summaryNodeLabel(writableItems[0].target.node)
      : `${writableItems.length} 个节点`;
    return {
      mode,
      scopeLabel,
      selectedLabel: selectedNode ? summaryNodeLabel(selectedNode) : '无',
      targetLabel,
      summaryItems,
      skippedShort: summarySkipBelowCount(summaryItems, strategy, strategyIndex),
      skippedGenerated,
      strategy,
      strategyIndex,
      strategyOptions: strategySettings.summaryStrategies
    };
  }

  async function cancelSummaryGeneration() {
    const run = summaryRunRef.current;
    if (!run || run.canceled) return;
    run.canceled = true;
    setProgress((current) => current ? { ...current, label: '正在取消摘要生成...', cancelable: false } : current);
    await cancelSummaryRunRequests(run);
  }

  async function runSummaryGeneration(request, summaryStrategy) {
    // 与 generateSummary 的入口约束保持一致：摘要写入只允许落在编辑分支上。
    if (!treeEditMode) {
      setNotice('请先进入编辑模式');
      return;
    }
    const strategyIndex = Number.isInteger(request?.strategyIndex)
      ? request.strategyIndex
      : (summaryStrategyModeForScope(request?.mode) === 'article' ? 0 : 1);
    const normalizedStrategy = normalizeSummaryStrategy(summaryStrategy, strategyIndex);
    const summaryItems = applySummarySkipStrategy(request?.summaryItems || [], normalizedStrategy, strategyIndex);
    const skippedShort = summaryItems.filter((item) => item.skip === 'short').length;
    const skippedGenerated = summaryItems.filter((item) => item.skip === 'generated').length;
    const eligible = summaryItems.filter((item) => !item.skip);
    if (eligible.length === 0) {
      setNotice(`没有需要生成摘要的节点：短文本跳过 ${skippedShort} 个，已有 AI 摘要跳过 ${skippedGenerated} 个。`);
      return;
    }
    const concurrency = normalizeSummaryConcurrency(llmSummarySettings?.summaryConcurrency);
    const run = {
      id: `summary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      canceled: false,
      requestIds: new Set()
    };
    summaryRunRef.current = run;
    setBusy(true);
    let generated = 0;
    let processed = 0;
    let firstError = /** @type {{ index: number, error: any } | null} */ (null);
    try {
      const total = summaryItems.length;
      const progressFor = (label) => ({
        label,
        step: processed,
        total,
        countLabel: `${processed} / ${total}`,
        cancelable: true
      });
      const markProcessed = (label) => {
        processed += 1;
        setProgress(progressFor(label));
      };
      const workItems = [];
      for (const [index, item] of summaryItems.entries()) {
        const nodeLabel = summaryNodeLabel(item.target.node);
        if (item.skip) {
          markProcessed(item.skip === 'short' ? `跳过短文本：${nodeLabel}` : `跳过已有摘要：${nodeLabel}`);
          continue;
        }
        workItems.push({ item, index, nodeLabel });
      }

      let cursor = 0;
      let writeChain = Promise.resolve();
      const writeTasks = [];
      const enqueueSummaryWrite = (work, summary) => {
        const writeTask = writeChain.then(async () => {
          if (run.canceled || firstError) return;
          const nextNote = appendGeneratedNote(work.item.target.node.note || '', summary);
          const result = await dispatch(
            () => nodeRepository.updateNode({
              docId: currentDoc.doc.id,
              nodeId: work.item.target.node.id,
              patch: { node_note: nextNote },
              includeDoc: false
            }),
            { effects: { undo: 'none', docsRefresh: 'none', busy: false } }
          );
          if (result !== null && result !== undefined) generated += 1;
        }).catch(async (error) => {
          if (!firstError) firstError = { error, index: work.index };
          run.canceled = true;
          await cancelSummaryRunRequests(run);
          throw error;
        });
        writeTasks.push(writeTask);
        writeChain = writeTask.catch(() => {});
      };

      const worker = async () => {
        for (;;) {
          if (run.canceled || firstError) return;
          const work = workItems[cursor];
          cursor += 1;
          if (!work) return;
          const requestId = `${run.id}-${work.index}`;
          run.requestIds.add(requestId);
          setProgress(progressFor(`生成摘要：${work.nodeLabel}`));
          try {
            const result = await summaryService.generateNodeSummary({
              requestId,
              mode: work.item.target.summaryMode,
              title: currentDoc.doc.title,
              address: work.item.target.node.address,
              nodeTitle: work.item.target.node.title || '',
              text: work.item.text,
              summaryStrategy: normalizedStrategy
            });
            if (run.canceled || firstError) return;
            const summary = String(result?.summary || '').trim();
            if (summary) enqueueSummaryWrite(work, summary);
            markProcessed(`完成摘要：${work.nodeLabel}`);
          } catch (error) {
            if (isSummaryAbortError(error) || run.canceled) {
              run.canceled = true;
              return;
            }
            if (!firstError) firstError = { error, index: work.index };
            run.canceled = true;
            await cancelSummaryRunRequests(run);
            return;
          } finally {
            run.requestIds.delete(requestId);
          }
        }
      };

      const workerCount = Math.min(concurrency, workItems.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      await Promise.all(writeTasks);
      if (firstError) throw firstError.error;
      if (generated > 0) setDocs(await documentRepository.listDocs());
      if (run.canceled) {
        setNotice(`摘要生成已取消，已保存 ${generated} 个；再次选择同一范围会跳过已有摘要继续生成。`);
      } else {
        setNotice(`已生成摘要 ${generated} 个；短文本跳过 ${skippedShort} 个，已有 AI 摘要跳过 ${skippedGenerated} 个。`);
      }
    } catch (error) {
      const failedAt = Math.min((firstError?.index ?? processed) + 1, summaryItems.length);
      setNotice(`摘要生成失败（${failedAt} / ${summaryItems.length}）：${error.message}`);
    } finally {
      setBusy(false);
      setProgress(null);
      if (summaryRunRef.current?.id === run.id) summaryRunRef.current = null;
    }
  }

  return {
    summaryNotesVisible,
    toggleSummaryNotesVisible,
    generateSummary,
    runSummaryGeneration,
    cancelSummaryGeneration
  };
}
