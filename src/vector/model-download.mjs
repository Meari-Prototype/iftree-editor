export const DTYPE_SUFFIXES = Object.freeze({
  fp32: '',
  fp16: '_fp16',
  int8: '_int8',
  uint8: '_uint8',
  q8: '_quantized',
  q4: '_q4',
  q2: '_q2',
  q1: '_q1',
  q4f16: '_q4f16',
  q2f16: '_q2f16',
  q1f16: '_q1f16',
  bnb4: '_bnb4'
});

const ROOT_MODEL_FILE_EXTENSIONS = new Set(['.json', '.txt', '.model', '.spm', '.tiktoken']);
const ROOT_MODEL_FILE_NAMES = new Set([
  'merges.txt',
  'vocab.txt',
  'vocab.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'sentencepiece.bpe.model',
  'spiece.model'
]);

function normalizeRepoPath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function pathExtension(path) {
  const name = normalizeRepoPath(path).split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function dtypeSuffix(dtype) {
  return DTYPE_SUFFIXES[dtype] ?? DTYPE_SUFFIXES.fp32;
}

export function modelOnnxFileName(dtype) {
  return `model${dtypeSuffix(dtype)}.onnx`;
}

export function repoIdUrlPath(modelName) {
  return String(modelName || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

export function huggingFaceTreeUrl(modelName) {
  return `https://huggingface.co/api/models/${repoIdUrlPath(modelName)}/tree/main?recursive=true`;
}

export function huggingFaceResolveUrl(modelName, filePath) {
  const encodedPath = normalizeRepoPath(filePath).split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${repoIdUrlPath(modelName)}/resolve/main/${encodedPath}`;
}

export function shouldDownloadTransformerFile(path, dtype) {
  const normalized = normalizeRepoPath(path);
  if (!normalized || normalized.startsWith('.') || normalized.includes('/.')) return false;

  const parts = normalized.split('/');
  const name = parts.at(-1) || '';
  if (parts.length === 1) {
    return ROOT_MODEL_FILE_NAMES.has(name) || ROOT_MODEL_FILE_EXTENSIONS.has(pathExtension(name));
  }

  const onnxFileName = modelOnnxFileName(dtype);
  const onnxPath = `onnx/${onnxFileName}`;
  if (normalized === onnxPath) return true;
  return normalized.startsWith(`${onnxPath}_data`);
}

export function selectTransformerModelFiles(entries, dtype) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (typeof entry === 'string') return { path: normalizeRepoPath(entry), size: 0 };
      return {
        ...entry,
        path: normalizeRepoPath(entry?.path),
        size: Number(entry?.size) || 0
      };
    })
    .filter((entry) => entry.path && (entry.type === undefined || entry.type === 'file'))
    .filter((entry) => shouldDownloadTransformerFile(entry.path, dtype))
    .sort((left, right) => left.path.localeCompare(right.path));
}
