export const MIN_VECTOR_DIMENSIONS = 1024;
export const DEFAULT_BATCH_SIZE = 16;
export const DEFAULT_WORKER_COUNT = 2;
export const EMBEDDING_INIT_PROGRESS_UNITS = 1;

export const VECTOR_MODEL_OPTIONS = Object.freeze([
  {
    id: 'bge-m3',
    label: 'BGE-M3',
    baseModelName: 'BAAI/bge-m3',
    modelName: 'Xenova/bge-m3',
    modelPath: 'Hugging Face model repo: Xenova/bge-m3',
    dimensions: 1024,
    maxInputTokens: 8192,
    pooling: 'cls',
    gpuDtype: 'fp16',
    cpuDtype: 'q8'
  },
  {
    id: 'bge-large-zh-v1.5',
    label: 'BGE Large ZH v1.5',
    baseModelName: 'BAAI/bge-large-zh-v1.5',
    modelName: 'Xenova/bge-large-zh-v1.5',
    modelPath: 'Hugging Face model repo: Xenova/bge-large-zh-v1.5',
    dimensions: 1024,
    maxInputTokens: 512,
    pooling: 'mean',
    gpuDtype: 'fp16',
    cpuDtype: 'q8'
  },
  {
    id: 'bge-large-en-v1.5',
    label: 'BGE Large EN v1.5',
    baseModelName: 'BAAI/bge-large-en-v1.5',
    modelName: 'Xenova/bge-large-en-v1.5',
    modelPath: 'Hugging Face model repo: Xenova/bge-large-en-v1.5',
    dimensions: 1024,
    maxInputTokens: 512,
    pooling: 'mean',
    gpuDtype: 'fp16',
    cpuDtype: 'q8'
  }
]);

export const VECTOR_COMPUTE_OPTIONS = Object.freeze([
  {
    id: 'gpu',
    label: 'GPU / WebGPU',
    backend: 'WebGPU',
    renderer: 'Electron renderer module workers',
    device: 'webgpu'
  },
  {
    id: 'cpu',
    label: 'CPU / wasm',
    backend: 'wasm',
    renderer: 'Electron renderer module workers',
    device: 'wasm'
  }
]);

export const DEFAULT_VECTOR_CONFIG = Object.freeze({
  modelId: 'bge-m3',
  computeTarget: 'gpu',
  batchSize: DEFAULT_BATCH_SIZE,
  workerCount: DEFAULT_WORKER_COUNT,
  localModelRoot: '',
  remoteModelHost: '',
  importVectors: true
});

function optionById(options, id, fallbackId) {
  return options.find((option) => option.id === id)
    || options.find((option) => option.id === fallbackId)
    || options[0];
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

export function normalizeVectorConfig(input = {}) {
  const model = optionById(VECTOR_MODEL_OPTIONS, input.modelId, DEFAULT_VECTOR_CONFIG.modelId);
  const compute = optionById(VECTOR_COMPUTE_OPTIONS, input.computeTarget, DEFAULT_VECTOR_CONFIG.computeTarget);
  const batchSize = clampInteger(input.batchSize, 1, 128, DEFAULT_VECTOR_CONFIG.batchSize);
  const workerCount = clampInteger(input.workerCount, 1, 8, DEFAULT_VECTOR_CONFIG.workerCount);
  const localModelRoot = typeof input.localModelRoot === 'string'
    ? input.localModelRoot.trim()
    : DEFAULT_VECTOR_CONFIG.localModelRoot;
  const remoteModelHost = typeof input.remoteModelHost === 'string'
    ? input.remoteModelHost.trim()
    : DEFAULT_VECTOR_CONFIG.remoteModelHost;
  const importVectors = input.importVectors !== undefined
    ? Boolean(input.importVectors)
    : DEFAULT_VECTOR_CONFIG.importVectors;

  return {
    modelId: model.id,
    computeTarget: compute.id,
    batchSize,
    workerCount,
    localModelRoot,
    remoteModelHost,
    importVectors,
    label: model.label,
    baseModelName: model.baseModelName,
    modelName: model.modelName,
    modelPath: model.modelPath,
    renderer: compute.renderer,
    backend: compute.backend,
    device: compute.device,
    dtype: compute.id === 'gpu' ? model.gpuDtype : model.cpuDtype,
    pooling: model.pooling,
    dimensions: model.dimensions,
    minDimensions: model.dimensions,
    maxInputTokens: model.maxInputTokens,
    computePolicy: compute.id === 'gpu'
      ? 'GPU WebGPU computation'
      : 'CPU wasm computation explicitly selected in settings'
  };
}

export function assertEmbeddingVector(vector, context = 'Embedding vector', expectedDimensions = null) {
  if (!Array.isArray(vector) && !(ArrayBuffer.isView(vector))) {
    throw new Error(`${context} must be an array-like vector`);
  }
  const values = Array.from(/** @type {ArrayLike<any>} */ (vector), Number);
  const exactDimensions = Number(expectedDimensions) || null;
  if (exactDimensions && values.length !== exactDimensions) {
    throw new Error(`${context} must have exactly ${exactDimensions} dimensions; got ${values.length}`);
  }
  if (!exactDimensions && values.length < MIN_VECTOR_DIMENSIONS) {
    throw new Error(`${context} must have at least ${MIN_VECTOR_DIMENSIONS} dimensions; got ${values.length}`);
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`${context} contains a non-finite value`);
    }
  }
  return values;
}

export function zeroEmbedding(dimensions = MIN_VECTOR_DIMENSIONS) {
  if (dimensions < MIN_VECTOR_DIMENSIONS) {
    throw new Error(`Zero embedding must have at least ${MIN_VECTOR_DIMENSIONS} dimensions`);
  }
  return new Array(dimensions).fill(0);
}

export function normalizeVector(vector, expectedDimensions = null) {
  const values = assertEmbeddingVector(vector, 'Vector', expectedDimensions);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return values.map(() => 0);
  return values.map((value) => value / norm);
}

function clampProgressNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function embeddingProgressTotal(textCount, includeInitialization = true) {
  const count = Math.max(0, Math.trunc(Number(textCount) || 0));
  return count + (includeInitialization && count > 0 ? EMBEDDING_INIT_PROGRESS_UNITS : 0);
}

export function embeddingProgressStep({
  completedTexts = 0,
  textCount = 0,
  initializationProgress = 1,
  includeInitialization = true
} = {}) {
  const count = Math.max(0, Math.trunc(Number(textCount) || 0));
  const completed = clampProgressNumber(completedTexts, 0, count);
  if (!includeInitialization || count === 0) return completed;
  const init = clampProgressNumber(initializationProgress, 0, EMBEDDING_INIT_PROGRESS_UNITS);
  return clampProgressNumber(completed + init, 0, embeddingProgressTotal(count, true));
}

export function embeddingProgressCountLabel(completedTexts, totalTexts) {
  const total = Math.max(0, Math.trunc(Number(totalTexts) || 0));
  const completed = Math.trunc(clampProgressNumber(completedTexts, 0, total));
  return `${completed} / ${total}`;
}

export function cosineSimilarity(left, right) {
  const size = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < size; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
