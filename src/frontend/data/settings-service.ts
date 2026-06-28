import { callIftree } from './iftree-api.js';

type SettingsPatch = Record<string, unknown>;

export const settingsRepository = {
  readVectorSettings() {
    return callIftree('readVectorSettings');
  },

  saveVectorSettings(patch: SettingsPatch) {
    return callIftree('saveVectorSettings', patch);
  },

  readMemorySettings() {
    return callIftree('readMemorySettings');
  },

  saveMemorySettings(patch: SettingsPatch) {
    return callIftree('saveMemorySettings', patch);
  },

  readLlmSummarySettings() {
    return callIftree('readLlmSummarySettings');
  },

  saveLlmSummarySettings(settings: SettingsPatch) {
    return callIftree('saveLlmSummarySettings', settings);
  },

  readAgentSettings() {
    return callIftree('readAgentSettings');
  },

  saveAgentSettings(settings: SettingsPatch) {
    return callIftree('saveAgentSettings', settings);
  },

  readNodeLayoutSettings() {
    return callIftree('readNodeLayoutSettings');
  },

  saveNodeLayoutSettings(settings: SettingsPatch) {
    return callIftree('saveNodeLayoutSettings', settings);
  }
};

export const settingsService = settingsRepository;
