import { callIftree, hasIftreeMethod } from './iftree-api.js';

interface CreateImageAssetPayload {
  docId: string;
  nodeId: string | number;
}

interface ResolveImageSourcesPayload {
  docId: string;
  sources: string[];
}

export const assetRepository = {
  createImageAsset(payload: CreateImageAssetPayload) {
    return callIftree('createImageAsset', payload);
  },

  canResolveImageSources() {
    return hasIftreeMethod('resolveImageSources');
  },

  resolveImageSources(payload: ResolveImageSourcesPayload) {
    return callIftree('resolveImageSources', payload);
  }
};

export const assetService = assetRepository;
