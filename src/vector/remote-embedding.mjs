// 远程嵌入后端（headless 路径可选）：把 embedTexts 从本地 DirectML 串行
// 切到 GPU 加速的 HTTP 服务。覆盖两类端点：
//   - ollama       : POST {baseUrl}/api/embed   { model, input:[...] } -> { embeddings:[...] }
//   - openai/llamacpp: POST {baseUrl}/v1/embeddings { model, input:[...] } -> { data:[{embedding}] }
// llama.cpp server（`--embedding`）原生暴露 /v1/embeddings，故 openai 后端即覆盖「手写 llama.cpp」。
// 统一在客户端做 L2 归一化，保证与本地 transformers（normalize:true + cls）路径的向量可比。

import { normalizeVector } from './embeddings.mjs';

const DEFAULT_BATCH = 64;

function endpointFor(backend, baseUrl) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (backend === 'ollama') return `${root}/api/embed`;
  return `${root}/v1/embeddings`; // openai / llamacpp
}

async function postJson(url, body, apiKey) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`embedding HTTP ${res.status} @ ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function extractVectors(backend, json, expectedCount) {
  let raw;
  if (backend === 'ollama') raw = json?.embeddings;
  else raw = Array.isArray(json?.data) ? json.data.map((row) => row?.embedding) : null;
  if (!Array.isArray(raw) || raw.length !== expectedCount) {
    throw new Error(`embedding 响应数量不符：期望 ${expectedCount}，得到 ${Array.isArray(raw) ? raw.length : typeof raw}`);
  }
  return raw;
}

export function createRemoteEmbedder(options = {}) {
  const backend = String(options.backend || 'ollama').toLowerCase();
  const baseUrl = options.baseUrl || (backend === 'ollama' ? 'http://localhost:11434' : 'http://localhost:8080');
  const model = options.model;
  const apiKey = options.apiKey || '';
  const dimensions = Number(options.dimensions) || null;
  const batchSize = Math.max(1, Number(options.batchSize) || DEFAULT_BATCH);
  if (!model) throw new Error('remote embedder requires a model id (IFTREE_EMBED_MODEL)');
  const url = endpointFor(backend, baseUrl);

  async function embedBatch(texts) {
    const json = await postJson(url, { model, input: texts }, apiKey);
    const raw = extractVectors(backend, json, texts.length);
    return raw.map((vector) => normalizeVector(vector, dimensions));
  }

  async function embed(texts) {
    const out = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const part = await embedBatch(texts.slice(offset, offset + batchSize));
      for (const vector of part) out.push(vector);
    }
    return out;
  }

  // 健康检查 + 维度校验：切后端前先确认可达且维度匹配（避免污染 lance 表）。
  async function healthCheck() {
    const [vector] = await embedBatch(['healthcheck']);
    if (dimensions && vector.length !== dimensions) {
      throw new Error(`远程嵌入维度不符：期望 ${dimensions}，得到 ${vector.length}（换模型需同维或调整下限）`);
    }
    return { ok: true, backend, url, model, dimensions: vector.length };
  }

  return { backend, url, model, batchSize, embed, embedBatch, healthCheck };
}

// 从环境变量解析后端配置。未声明则返回 null（调用方回落本地 transformers）。
export function resolveEmbedBackendConfig(env = process.env) {
  const choice = String(env.IFTREE_EMBED_BACKEND || 'transformers').toLowerCase();
  if (choice === 'transformers' || choice === 'local' || !choice) return null;
  return {
    backend: choice, // 'ollama' | 'openai' | 'llamacpp'
    baseUrl: env.IFTREE_EMBED_BASE_URL || '',
    model: env.IFTREE_EMBED_MODEL || '',
    apiKey: env.IFTREE_EMBED_API_KEY || '',
    batchSize: env.IFTREE_EMBED_BATCH ? Number(env.IFTREE_EMBED_BATCH) : undefined,
    fallback: env.IFTREE_EMBED_FALLBACK !== '0'
  };
}
