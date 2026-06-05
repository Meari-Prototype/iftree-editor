import { callIftree } from './iftree-api.js';

export const settingsRepository = {
  readVectorSettings() {
    return callIftree('readVectorSettings');
  },

  saveVectorSettings(patch) {
    return callIftree('saveVectorSettings', patch);
  },

  readLlmSummarySettings() {
    return callIftree('readLlmSummarySettings');
  },

  saveLlmSummarySettings(settings) {
    return callIftree('saveLlmSummarySettings', settings);
  },

  readAgentSettings() {
    return callIftree('readAgentSettings');
  },

  saveAgentSettings(settings) {
    return callIftree('saveAgentSettings', settings);
  },

  readNodeLayoutSettings() {
    return callIftree('readNodeLayoutSettings');
  },

  saveNodeLayoutSettings(settings) {
    return callIftree('saveNodeLayoutSettings', settings);
  }
};

export const settingsService = settingsRepository;
