import type { Dispatch, SetStateAction } from 'react';

interface SettingsRepositoryLike {
  readVectorSettings(): Promise<unknown>;
  readLlmSummarySettings(): Promise<unknown>;
  readAgentSettings(): Promise<unknown>;
  readNodeLayoutSettings(): Promise<unknown>;
}

// setter 字段对齐 useSettings/useAgentChat 真签名（Dispatch<SetStateAction<X>>）；调用处把 unknown IPC 值 cast 到对应 setter X 类型。
interface OpenSettingsActionOptions {
  settingsRepository: SettingsRepositoryLike;
  normalizeNodeLayoutSettingsByView: (settings: unknown) => unknown;
  setActiveScreen: (screen: string) => void;
  setVectorSettings: Dispatch<SetStateAction<Record<string, unknown>>>;
  setLlmSummarySettings: Dispatch<SetStateAction<Record<string, unknown> | null>>;
  setAgentSettings: Dispatch<SetStateAction<Record<string, unknown> | null>>;
  setNodeLayoutSettings: Dispatch<SetStateAction<Record<string, unknown>>>;
  setNotice: (message: string) => void;
}

function reasonMessage(reason: unknown): string {
  return (reason as { message?: string } | null | undefined)?.message || String(reason);
}

export async function openSettingsAction({
  settingsRepository,
  normalizeNodeLayoutSettingsByView,
  setActiveScreen,
  setVectorSettings,
  setLlmSummarySettings,
  setAgentSettings,
  setNodeLayoutSettings,
  setNotice
}: OpenSettingsActionOptions): Promise<void> {
  setActiveScreen('settings');
  const results = await Promise.allSettled([
    settingsRepository.readVectorSettings(),
    settingsRepository.readLlmSummarySettings(),
    settingsRepository.readAgentSettings(),
    settingsRepository.readNodeLayoutSettings()
  ]);
  const [vector, llmSummary, agent, nodeLayout] = results;
  if (vector.status === 'fulfilled') setVectorSettings(vector.value as Record<string, unknown>);
  else setNotice(reasonMessage(vector.reason));
  if (llmSummary.status === 'fulfilled' && llmSummary.value) setLlmSummarySettings(llmSummary.value as Record<string, unknown> | null);
  else if (llmSummary.status === 'rejected') setNotice(reasonMessage(llmSummary.reason));
  if (agent.status === 'fulfilled' && agent.value) setAgentSettings(agent.value as Record<string, unknown> | null);
  else if (agent.status === 'rejected') setNotice(reasonMessage(agent.reason));
  if (nodeLayout.status === 'fulfilled' && nodeLayout.value) setNodeLayoutSettings(normalizeNodeLayoutSettingsByView(nodeLayout.value) as Record<string, unknown>);
  else if (nodeLayout.status === 'rejected') setNotice(reasonMessage(nodeLayout.reason));
}

type SettingsObject = Record<string, unknown>;

interface SaveAgentSettingsActionOptions {
  next: SettingsObject;
  agentSettings: SettingsObject | null | undefined;
  llmSummarySettings: (SettingsObject & { independent?: boolean }) | null | undefined;
  setLlmSummarySettings: Dispatch<SetStateAction<SettingsObject | null>>;
  saveAgentSettingsCore: (settings: SettingsObject) => Promise<SettingsObject | null | undefined>;
}

export async function saveAgentSettingsAction({
  next,
  agentSettings,
  llmSummarySettings,
  setLlmSummarySettings,
  saveAgentSettingsCore
}: SaveAgentSettingsActionOptions): Promise<void> {
  const merged = { ...(agentSettings || {}), ...(next || {}) };
  if (llmSummarySettings?.independent !== true) {
    setLlmSummarySettings({ ...merged, independent: false });
  }
  const updated = await saveAgentSettingsCore(next);
  if (updated && llmSummarySettings?.independent !== true) {
    setLlmSummarySettings({ ...updated, independent: false });
  }
}
