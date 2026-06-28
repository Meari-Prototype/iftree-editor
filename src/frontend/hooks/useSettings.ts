import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DEFAULT_NODE_LAYOUT } from '../../core/mindmap.js';
import { normalizeNodeLayoutSettingsByView } from '../lib/doc-utils.js';
import { settingsRepository } from '../data/repositories.js';
import { useAppUIContext } from './useAppUI.js';

export function useSettings() {
  const { setNotice } = useAppUIContext();
  type SettingsObject = Record<string, unknown>;
  const [vectorSettings, setVectorSettings] = useState<SettingsObject>({ enabled: true, disabledReason: '' });
  const [memorySettings, setMemorySettings] = useState<SettingsObject>({ enabled: false });
  const [llmSummarySettings, setLlmSummarySettings] = useState<SettingsObject | null>(null);
  const [nodeLayoutSettings, setNodeLayoutSettings] = useState<SettingsObject>(() => normalizeNodeLayoutSettingsByView({}) as SettingsObject);
  const llmSummarySaveSeqRef = useRef(0);

  const errorMessage = (error: unknown) => String((error as { message?: unknown } | null | undefined)?.message || error || '');

  const saveVectorSettings = useCallback(async (patch: SettingsObject) => {
    try {
      setVectorSettings(await settingsRepository.saveVectorSettings(patch) as SettingsObject);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [setNotice]);

  const saveMemorySettings = useCallback(async (patch: SettingsObject) => {
    try {
      setMemorySettings(await settingsRepository.saveMemorySettings(patch) as SettingsObject);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [setNotice]);

  // 记忆模块开关（15-10-5，默认关）：启动时载一次当前值，供设置页开关显示。
  useEffect(() => {
    let alive = true;
    settingsRepository.readMemorySettings?.()
      .then((next) => { if (alive && next) setMemorySettings(next as SettingsObject); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const saveLlmSummarySettings = useCallback(async (next: SettingsObject) => {
    const seq = llmSummarySaveSeqRef.current + 1;
    llmSummarySaveSeqRef.current = seq;
    const merged = { ...(llmSummarySettings || {}), ...(next || {}) };
    setLlmSummarySettings(merged);
    try {
      const updated = await settingsRepository.saveLlmSummarySettings(merged);
      if (llmSummarySaveSeqRef.current === seq) setLlmSummarySettings(updated as SettingsObject);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [llmSummarySettings, setNotice]);

  const saveNodeLayoutSettings = useCallback(async (view: 'tree' | 'flow', patch: SettingsObject) => {
    const current = normalizeNodeLayoutSettingsByView(nodeLayoutSettings);
    const next = normalizeNodeLayoutSettingsByView({
      ...current,
      [view]: {
        ...(current[view] || DEFAULT_NODE_LAYOUT),
        ...(patch || {})
      }
    });
    setNodeLayoutSettings(next as SettingsObject);
    try {
      await settingsRepository.saveNodeLayoutSettings(next);
      setNodeLayoutSettings(normalizeNodeLayoutSettingsByView(next) as SettingsObject);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [nodeLayoutSettings, setNotice]);

  return useMemo(() => ({
    vectorSettings,
    memorySettings,
    llmSummarySettings,
    nodeLayoutSettings,
    setVectorSettings,
    setMemorySettings,
    setLlmSummarySettings,
    setNodeLayoutSettings,
    llmSummarySaveSeqRef,
    saveVectorSettings,
    saveMemorySettings,
    saveLlmSummarySettings,
    saveNodeLayoutSettings
  }), [
    llmSummarySettings,
    memorySettings,
    nodeLayoutSettings,
    saveLlmSummarySettings,
    saveNodeLayoutSettings,
    saveVectorSettings,
    saveMemorySettings,
    vectorSettings
  ]);
}
