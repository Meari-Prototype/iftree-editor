import { assertEmbeddingVector, zeroEmbedding } from './embeddings.mjs';
import { createRemoteEmbedder, resolveEmbedBackendConfig } from './remote-embedding.mjs';
import { createTokenCounter } from './token-count.mjs';

// 步骤4：@huggingface/transformers 降可选依赖，本地推理改懒加载——只有真正用本地嵌入（getExtractor）
// 才动态 import；未装时返回 null，由调用处报「未装本地嵌入、请走 HTTP」。token 计数侧的懒加载在 token-count.mjs。
let transformersModulePromise = null;
function loadTransformers() {
  if (!transformersModulePromise) {
    transformersModulePromise = import('@huggingface/transformers').catch(() => null);
  }
  return transformersModulePromise;
}

// 步骤4：HTTP 嵌入为首选（projectneed 3137）。没配 IFTREE_EMBED_BACKEND 时的默认后端——ollama
// localhost，model 由向量模型名派生（Xenova/bge-m3 → bge-m3）；健康检查失败回落本地 transformers。
function defaultOllamaEmbedConfig(config) {
  return {
    backend: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: String(config.modelName || '').split('/').pop() || 'bge-m3',
    apiKey: '',
    fallback: true
  };
}

// 嵌入计算服务（从 headless-agent-host 闭包下沉，解耦第 1a 步）：把「本地 transformers 推理 +
// 远/近后端选择 + 嵌入总入口 + token 计数守卫」从 host 收口成一处，host 只注入向量配置读取与模块开关。
// 实际行为：
//   · 加载并常驻缓存本地嵌入模型推理管线（transformers + onnxruntime，按配置走 GPU/DirectML 或 CPU），
//     按「模型+设备+精度+本地路径+远程host」做键只加载一次；
//   · 把一批文本切批过模型、池化归一、按输入同序返回向量；把模型扁平张量按条数拆成逐条向量；
//   · 决定走哪个后端：环境配了远程嵌入服务（ollama / openai 兼容 / llama.cpp）就先健康探活再用其 HTTP，
//     探活失败且允许回落则退回本地模型，没配则直接本地——这个判定只做一次并缓存；
//   · 嵌入总入口：空文本给零向量、其余交给选定后端、校验维度、按原序返回；
//   · token 计数：按模型记忆化 tokenizer，供超长守卫算真 token 数。
// 等价搬迁、不增功能、保持 in-process。依赖注入：getVectorConfig()、isVectorModuleEnabled()。
export function createEmbeddingService(deps = {}) {
  const getVectorConfig = deps.getVectorConfig;
  const isVectorModuleEnabled = deps.isVectorModuleEnabled;

  let embedBackendPromise = null;
  const extractorPromises = new Map();
  const tokenCounters = new Map();

  function assertVectorModuleEnabled() {
    if (!isVectorModuleEnabled()) throw new Error('向量模块已由用户禁用');
  }

  function headlessVectorRuntime(config = getVectorConfig()) {
    const localModelRoot = String(config.localModelRoot || '').trim();
    return {
      ...config,
      localModelRoot,
      nodeDevice: config.computeTarget === 'gpu' ? 'dml' : 'cpu'
    };
  }

  async function getExtractor(runtime = headlessVectorRuntime()) {
    const key = `${runtime.modelName}|${runtime.nodeDevice}|${runtime.dtype}|${runtime.localModelRoot}|${runtime.remoteModelHost || ''}`;
    if (!extractorPromises.has(key)) {
      extractorPromises.set(key, (async () => {
        const tf = await loadTransformers();
        if (!tf) throw new Error('未装本地嵌入（@huggingface/transformers / onnxruntime）；请配 IFTREE_EMBED_BACKEND 走 HTTP 嵌入（ollama / openai 兼容）。');
        const { env: transformersEnv, pipeline } = tf;
        const hasLocal = Boolean(runtime.localModelRoot);
        transformersEnv.allowLocalModels = hasLocal;
        transformersEnv.localModelPath = hasLocal ? `${runtime.localModelRoot.replace(/\\/g, '/')}/` : '/models/';
        transformersEnv.allowRemoteModels = !hasLocal;
        if (runtime.remoteModelHost) transformersEnv.remoteHost = runtime.remoteModelHost;
        return pipeline('feature-extraction', runtime.modelName, {
          device: runtime.nodeDevice,
          dtype: runtime.dtype
        });
      })());
    }
    return extractorPromises.get(key);
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

  // 本地 transformers（onnxruntime，GPU=DirectML）后端：批量抽取，返回与输入同序的向量。
  async function transformersEmbed(textList, runtime = headlessVectorRuntime()) {
    const extractor = textList.length > 0 ? await getExtractor(runtime) : null;
    const out = new Array(textList.length);
    for (let offset = 0; offset < textList.length; offset += runtime.batchSize) {
      const batch = textList.slice(offset, offset + runtime.batchSize);
      const output = await extractor(batch, { pooling: runtime.pooling, normalize: true });
      const vectors = tensorToVectors(output, batch.length);
      for (let i = 0; i < batch.length; i += 1) {
        out[offset + i] = assertEmbeddingVector(
          vectors[i],
          `${runtime.label} headless vector for text ${offset + i + 1}`,
          runtime.dimensions
        );
      }
    }
    return out;
  }

  // 解析嵌入后端（一次性、带兜底）：IFTREE_EMBED_BACKEND=ollama|openai|llamacpp 时切到
  // GPU 加速的 HTTP 服务（ollama /api/embed 或 OpenAI 兼容 /v1/embeddings = llama.cpp server）；
  // 未声明或健康检查失败（且未禁用兜底）时回落本地 transformers。
  function resolveEmbedBackend(config) {
    if (!embedBackendPromise) {
      embedBackendPromise = (async () => {
        // 步骤4：HTTP 首选——配了 IFTREE_EMBED_BACKEND 用之，没配也默认 ollama localhost；
        // 本地 transformers 纯兜底（remote 不可达且装了本地时才回落）。
        const remoteConfig = resolveEmbedBackendConfig(process.env) || defaultOllamaEmbedConfig(config);
        const local = {
          label: 'transformers',
          embed: (textList) => transformersEmbed(textList, headlessVectorRuntime(config))
        };
        try {
          const embedder = createRemoteEmbedder({ ...remoteConfig, dimensions: config.dimensions });
          const health = await embedder.healthCheck();
          process.stderr.write(`[embed] backend=${health.backend} url=${health.url} model=${health.model} dim=${health.dimensions}\n`);
          return { label: `${remoteConfig.backend}`, embed: (textList) => embedder.embed(textList) };
        } catch (error) {
          if (!remoteConfig.fallback) throw error;
          process.stderr.write(`[embed] remote backend 不可用，回落本地 transformers：${error?.message || error}\n`);
          return local;
        }
      })();
    }
    return embedBackendPromise;
  }

  async function headlessEmbeddings(texts) {
    assertVectorModuleEnabled();
    const config = getVectorConfig();
    const source = Array.isArray(texts) ? texts : [];
    const results = new Array(source.length);
    const pending = [];
    for (let index = 0; index < source.length; index += 1) {
      const text = String(source[index] || '').trim();
      if (!text) {
        results[index] = zeroEmbedding(config.dimensions);
        continue;
      }
      pending.push({ index, text });
    }
    if (pending.length === 0) return results;
    const backend = await resolveEmbedBackend(config);
    const vectors = await backend.embed(pending.map((item) => item.text));
    for (let i = 0; i < pending.length; i += 1) {
      results[pending[i].index] = assertEmbeddingVector(
        vectors[i],
        `${backend.label} headless vector for text ${pending[i].index + 1}`,
        config.dimensions
      );
    }
    return results;
  }

  // token 计数器按模型记忆化（第 2 步守卫）：嵌入串超模型窗口就跳过。用模型自带 tokenizer 算真 token 数，
  // 与嵌入模型一致（三后端都跑同一 bge）；加载失败时模块内部退回保守字数估算。
  function countTokens(text) {
    const config = getVectorConfig();
    const key = `${config.modelName}|${String(config.localModelRoot || '').trim()}`;
    if (!tokenCounters.has(key)) {
      tokenCounters.set(key, createTokenCounter({ modelName: config.modelName, localModelRoot: config.localModelRoot }));
    }
    return tokenCounters.get(key).count(text);
  }

  return { embed: headlessEmbeddings, countTokens };
}
