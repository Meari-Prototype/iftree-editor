import { env, pipeline } from '@huggingface/transformers';

import {
  DEFAULT_VECTOR_CONFIG,
  assertEmbeddingVector,
  normalizeVectorConfig
} from './embeddings.mjs';

const extractorPromises = new Map();

function reportProgress(id, progress) {
  if (id == null) return;
  globalThis.postMessage({ id, progress });
}

function progressFromTransformers(runtime, data = {}) {
  const rawProgress = Number(data.progress);
  const initializationProgress = Number.isFinite(rawProgress)
    ? Math.min(0.98, Math.max(0.02, rawProgress / 100))
    : 0.05;
  const file = data.file || data.name || '';
  return {
    phase: 'load-model',
    label: file ? `加载 ${runtime.label} 模型：${file}` : `加载 ${runtime.label} 模型`,
    initializationProgress,
    detail: data.status || ''
  };
}

async function assertWebGpuReady(runtime, id) {
  reportProgress(id, {
    phase: 'init-webgpu',
    label: `初始化 ${runtime.label} WebGPU`,
    initializationProgress: 0.02
  });
  if (!globalThis.navigator?.gpu) {
    throw new Error(`${runtime.label} 需要 WebGPU，但当前 worker 未检测到 navigator.gpu。`);
  }
  const adapter = await globalThis.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  reportProgress(id, {
    phase: 'webgpu-ready',
    label: `${runtime.label} WebGPU 已就绪`,
    initializationProgress: 0.08
  });
  if (!adapter) {
    throw new Error(`${runtime.label} 需要 WebGPU，但当前 worker 未取得高性能 GPU adapter。`);
  }
}

async function getExtractor(runtime, id) {
  const key = `${runtime.modelName}|${runtime.device}|${runtime.dtype}|${runtime.localModelBaseUrl || ''}|${runtime.remoteModelHost || ''}`;
  if (!extractorPromises.has(key)) {
    extractorPromises.set(key, (async () => {
      if (runtime.device === 'webgpu') {
        await assertWebGpuReady(runtime, id);
      }
      const hasLocal = Boolean(runtime.localModelBaseUrl);
      env.allowLocalModels = hasLocal;
      env.localModelPath = runtime.localModelBaseUrl || '/models/';
      env.allowRemoteModels = !hasLocal;
      if (runtime.remoteModelHost) env.remoteHost = runtime.remoteModelHost;
      reportProgress(id, {
        phase: 'load-model',
        label: `加载 ${runtime.label} 模型`,
        initializationProgress: 0.1
      });
      return pipeline('feature-extraction', runtime.modelName, {
        device: runtime.device,
        dtype: runtime.dtype,
        progress_callback: (data) => reportProgress(id, progressFromTransformers(runtime, data))
      });
    })());
  } else {
    reportProgress(id, {
      phase: 'wait-model',
      label: `等待 ${runtime.label} 模型初始化`,
      initializationProgress: 0.1
    });
  }
  const extractor = await extractorPromises.get(key);
  reportProgress(id, {
    phase: 'model-ready',
    label: `${runtime.label} 模型已就绪`,
    initializationProgress: 1
  });
  return extractor;
}

function tensorToVectors(output, expectedCount) {
  const data = Array.from(output?.data || [], Number);
  const dims = Array.isArray(output?.dims) ? output.dims : [];

  if (expectedCount === 0) return [];

  if (dims.length >= 2 && dims[0] === expectedCount) {
    const width = dims[dims.length - 1];
    return Array.from({ length: expectedCount }, (_, row) => data.slice(row * width, (row + 1) * width));
  }

  if (expectedCount === 1) return [data];

  if (data.length % expectedCount === 0) {
    const width = data.length / expectedCount;
    return Array.from({ length: expectedCount }, (_, row) => data.slice(row * width, (row + 1) * width));
  }

  throw new Error(`向量输出形状异常：dims=${JSON.stringify(dims)} expected=${expectedCount}`);
}

globalThis.onmessage = async (event) => {
  const { id, texts, config: rawConfig } = event.data || {};
  try {
    const runtime = normalizeVectorConfig(rawConfig || DEFAULT_VECTOR_CONFIG);
    const inputTexts = Array.isArray(texts) ? texts.map((text) => String(text || '').trim()) : [];
    if (inputTexts.length === 0) {
      globalThis.postMessage({ id, vectors: [] });
      return;
    }

    const extractor = await getExtractor(runtime, id);
    reportProgress(id, {
      phase: 'infer',
      label: `计算 ${runtime.label} 向量`,
      initializationProgress: 1
    });
    const output = await extractor(inputTexts, {
      pooling: runtime.pooling,
      normalize: true
    });
    const vectors = tensorToVectors(output, inputTexts.length)
      .map((vector, index) => assertEmbeddingVector(vector, `${runtime.label} vector ${index + 1}`, runtime.dimensions));

    globalThis.postMessage({
      id,
      vectors,
      meta: {
        model: runtime.modelName,
        device: runtime.device,
        dtype: runtime.dtype,
        dimensions: runtime.dimensions
      }
    });
  } catch (error) {
    globalThis.postMessage({
      id,
      error: {
        message: error?.message || String(error),
        stack: error?.stack || ''
      }
    });
  }
};
