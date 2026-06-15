export async function openSettingsAction({
  settingsRepository,
  normalizeNodeLayoutSettingsByView,
  setActiveScreen,
  setVectorSettings,
  setLlmSummarySettings,
  setAgentSettings,
  setNodeLayoutSettings,
  setNotice
}) {
  setActiveScreen('settings');
  const results = await Promise.allSettled([
    settingsRepository.readVectorSettings(),
    settingsRepository.readLlmSummarySettings(),
    settingsRepository.readAgentSettings(),
    settingsRepository.readNodeLayoutSettings()
  ]);
  const [vector, llmSummary, agent, nodeLayout] = results;
  if (vector.status === 'fulfilled') setVectorSettings(vector.value);
  else setNotice(vector.reason?.message || String(vector.reason));
  if (llmSummary.status === 'fulfilled' && llmSummary.value) setLlmSummarySettings(llmSummary.value);
  else if (llmSummary.status === 'rejected') setNotice(llmSummary.reason?.message || String(llmSummary.reason));
  if (agent.status === 'fulfilled' && agent.value) setAgentSettings(agent.value);
  else if (agent.status === 'rejected') setNotice(agent.reason?.message || String(agent.reason));
  if (nodeLayout.status === 'fulfilled' && nodeLayout.value) setNodeLayoutSettings(normalizeNodeLayoutSettingsByView(nodeLayout.value));
  else if (nodeLayout.status === 'rejected') setNotice(nodeLayout.reason?.message || String(nodeLayout.reason));
}

export async function saveAgentSettingsAction({
  next,
  agentSettings,
  llmSummarySettings,
  setLlmSummarySettings,
  saveAgentSettingsCore
}) {
  const merged = { ...(agentSettings || {}), ...(next || {}) };
  if (llmSummarySettings?.independent !== true) {
    setLlmSummarySettings({ ...merged, independent: false });
  }
  const updated = await saveAgentSettingsCore(next);
  if (updated && llmSummarySettings?.independent !== true) {
    setLlmSummarySettings({ ...updated, independent: false });
  }
}
