import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_VECTOR_CONFIG,
  embeddingProgressCountLabel,
  embeddingProgressStep,
  embeddingProgressTotal,
  VECTOR_COMPUTE_OPTIONS,
  VECTOR_MODEL_OPTIONS,
  normalizeVectorConfig
} from '../src/vector/embeddings.mjs';
import {
  huggingFaceResolveUrl,
  huggingFaceTreeUrl,
  modelOnnxFileName,
  selectTransformerModelFiles
} from '../src/vector/model-download.mjs';

test('vector model options only expose database-safe dimensions', () => {
  assert.equal(VECTOR_MODEL_OPTIONS.length >= 2, true);
  for (const option of VECTOR_MODEL_OPTIONS) {
    assert.equal(option.dimensions >= 1024, true);
  }
});

test('normalizeVectorConfig derives dimensions and runtime from selected model and compute target', () => {
  const config = normalizeVectorConfig({
    modelId: 'bge-large-zh-v1.5',
    computeTarget: 'cpu',
    workerCount: 4,
    batchSize: 8
  });

  assert.equal(config.modelName, 'Xenova/bge-large-zh-v1.5');
  assert.equal(config.dimensions, 1024);
  assert.equal(config.device, 'wasm');
  assert.equal(config.dtype, 'q8');
  assert.equal(config.workerCount, 4);
  assert.equal(config.batchSize, 8);
  assert.equal(config.localModelRoot, '');
});

test('normalizeVectorConfig falls back to bge-m3 and clamps worker settings', () => {
  const config = normalizeVectorConfig({
    modelId: 'missing',
    computeTarget: 'missing',
    workerCount: 999,
    batchSize: 0
  });

  assert.equal(config.modelId, DEFAULT_VECTOR_CONFIG.modelId);
  assert.equal(config.computeTarget, DEFAULT_VECTOR_CONFIG.computeTarget);
  assert.equal(config.workerCount, 8);
  assert.equal(config.batchSize, 1);
});

test('normalizeVectorConfig preserves a selected local model root', () => {
  const config = normalizeVectorConfig({
    localModelRoot: ' C:\\models\\transformers '
  });

  assert.equal(config.localModelRoot, 'C:\\models\\transformers');
});

test('vector compute options include gpu and cpu choices', () => {
  assert.deepEqual(VECTOR_COMPUTE_OPTIONS.map((option) => option.id), ['gpu', 'cpu']);
});

test('embedding progress includes model initialization before text completion', () => {
  assert.equal(embeddingProgressTotal(21), 22);
  assert.equal(embeddingProgressStep({ completedTexts: 0, textCount: 21, initializationProgress: 0 }), 0);
  assert.equal(embeddingProgressStep({ completedTexts: 0, textCount: 21, initializationProgress: 0.5 }), 0.5);
  assert.equal(embeddingProgressStep({ completedTexts: 3, textCount: 21, initializationProgress: 1 }), 4);
  assert.equal(embeddingProgressCountLabel(3, 21), '3 / 21');
});

test('model download helpers select runtime dtype ONNX and metadata files', () => {
  const files = selectTransformerModelFiles([
    { type: 'file', path: 'README.md', size: 1 },
    { type: 'file', path: 'config.json', size: 1 },
    { type: 'file', path: 'tokenizer.json', size: 1 },
    { type: 'file', path: 'onnx/model.onnx', size: 1 },
    { type: 'file', path: 'onnx/model_fp16.onnx', size: 1 },
    { type: 'file', path: 'onnx/model_fp16.onnx_data', size: 1 },
    { type: 'file', path: 'onnx/model_quantized.onnx', size: 1 }
  ], 'fp16');

  assert.deepEqual(files.map((file) => file.path), [
    'config.json',
    'onnx/model_fp16.onnx',
    'onnx/model_fp16.onnx_data',
    'tokenizer.json'
  ]);
});

test('model download helpers derive Hugging Face paths from model and dtype', () => {
  assert.equal(modelOnnxFileName('q8'), 'model_quantized.onnx');
  assert.equal(huggingFaceTreeUrl('Xenova/bge-m3'), 'https://huggingface.co/api/models/Xenova/bge-m3/tree/main?recursive=true');
  assert.equal(
    huggingFaceResolveUrl('Xenova/bge-m3', 'onnx/model_fp16.onnx'),
    'https://huggingface.co/Xenova/bge-m3/resolve/main/onnx/model_fp16.onnx'
  );
});
