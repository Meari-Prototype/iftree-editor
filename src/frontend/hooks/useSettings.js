import { useCallback, useMemo, useRef, useState } from 'react';

import { DEFAULT_NODE_LAYOUT } from '../../core/mindmap.mjs';
import { normalizeNodeLayoutSettingsByView } from '../lib/doc-utils.mjs';
import { settingsRepository } from '../data/repositories.js';

export function useSettings({ setNotice }) {
  const [vectorSettings, setVectorSettings] = useState({ enabled: true, disabledReason: '' });
  const [llmSummarySettings, setLlmSummarySettings] = useState(null);
  const [nodeLayoutSettings, setNodeLayoutSettings] = useState(() => normalizeNodeLayoutSettingsByView());
  const llmSummarySaveSeqRef = useRef(0);

  const saveVectorSettings = useCallback(async (patch) => {
    try {
      setVectorSettings(await settingsRepository.saveVectorSettings(patch));
    } catch (error) {
      setNotice(error.message);
    }
  }, [setNotice]);

  const saveLlmSummarySettings = useCallback(async (next) => {
    const seq = llmSummarySaveSeqRef.current + 1;
    llmSummarySaveSeqRef.current = seq;
    const merged = { ...(llmSummarySettings || {}), ...(next || {}) };
    setLlmSummarySettings(merged);
    try {
      const updated = await settingsRepository.saveLlmSummarySettings(merged);
      if (llmSummarySaveSeqRef.current === seq) setLlmSummarySettings(updated);
    } catch (error) {
      setNotice(error.message);
    }
  }, [llmSummarySettings, setNotice]);

  const saveNodeLayoutSettings = useCallback(async (view, patch) => {
    const current = normalizeNodeLayoutSettingsByView(nodeLayoutSettings);
    const next = normalizeNodeLayoutSettingsByView({
      ...current,
      [view]: {
        ...(current[view] || DEFAULT_NODE_LAYOUT),
        ...(patch || {})
      }
    });
    setNodeLayoutSettings(next);
    try {
      await settingsRepository.saveNodeLayoutSettings(next);
      setNodeLayoutSettings(normalizeNodeLayoutSettingsByView(next));
    } catch (error) {
      setNotice(error.message);
    }
  }, [nodeLayoutSettings, setNotice]);

  return useMemo(() => ({
    vectorSettings,
    llmSummarySettings,
    nodeLayoutSettings,
    setVectorSettings,
    setLlmSummarySettings,
    setNodeLayoutSettings,
    llmSummarySaveSeqRef,
    saveVectorSettings,
    saveLlmSummarySettings,
    saveNodeLayoutSettings
  }), [
    llmSummarySettings,
    nodeLayoutSettings,
    saveLlmSummarySettings,
    saveNodeLayoutSettings,
    saveVectorSettings,
    vectorSettings
  ]);
}
