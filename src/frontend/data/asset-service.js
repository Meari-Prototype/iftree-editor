import { callIftree, hasIftreeMethod } from './iftree-api.js';

export const assetRepository = {
  createImageAsset(payload) {
    return callIftree('createImageAsset', payload);
  },

  canResolveImageSources() {
    return hasIftreeMethod('resolveImageSources');
  },

  resolveImageSources(payload) {
    return callIftree('resolveImageSources', payload);
  }
};

export const assetService = assetRepository;
