// 远程嵌入后端（headless 路径可选）：把 embedTexts 从本地 DirectML 串行
// 切到 GPU 加速的 HTTP 服务。覆盖两类端点：
//   - ollama       : POST {baseUrl}/api/embed   { model, input:[...] } -> { embeddings:[...] }
//   - openai/llamacpp: POST {baseUrl}/v1/embeddings { model, input:[...] } -> { data:[{embedding}] }
// llama.cpp server（`--embedding`）原生暴露 /v1/embeddings，故 openai 后端即覆盖「手写 llama.cpp」。
// 统一在客户端做 L2 归一化，保证与本地 transformers（normalize:true + cls）路径的向量可比。

import { normalizeVector } from './embeddings.js';

const DEFAULT_BATCH = 64;
const TRANSIENT_RETRY_DELAYS_MS = [500, 1500, 3000];
const normalizeVectorTyped = normalizeVector as unknown as (vector: unknown, dimensions: number | null) => number[];

type RemoteEmbeddingBackend = string;

interface RemoteEmbedderOptions {
  backend?: unknown;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  dimensions?: number | string | null;
  batchSize?: number | string;
  workerCount?: number | string;
}

interface RemoteEmbedBackendEnv {
  IFTREE_EMBED_BACKEND?: string;
  IFTREE_EMBED_BASE_URL?: string;
  IFTREE_EMBED_MODEL?: string;
  IFTREE_EMBED_API_KEY?: string;
  IFTREE_EMBED_BATCH?: string;
  IFTREE_EMBED_WORKERS?: string;
  IFTREE_EMBED_FALLBACK?: string;
}

function endpointFor(backend: RemoteEmbeddingBackend, baseUrl: string): string {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (backend === 'ollama') return `${root}/api/embed`;
  return `${root}/v1/embeddings`; // openai / llamacpp
}

async function postJson(url: string, body: Record<string, unknown>, apiKey: string): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`embedding HTTP ${res.status} @ ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientRemoteEmbeddingError(error: unknown) {
  const message = String((error as { message?: unknown } | null | undefined)?.message || error).toLowerCase();
  return message.includes('/tokenize')
    || message.includes('connectex')
    || message.includes('connection refused')
    || message.includes('actively refused')
    || message.includes('econnreset')
    || message.includes('fetch failed')
    || message.includes('und_err_socket');
}

function extractVectors(backend: RemoteEmbeddingBackend, json: unknown, expectedCount: number): unknown[] {
  const payload = json as { embeddings?: unknown; data?: Array<{ embedding?: unknown }> } | null | undefined;
  let raw: unknown;
  if (backend === 'ollama') raw = payload?.embeddings;
  else raw = Array.isArray(payload?.data) ? payload.data.map((row) => row?.embedding) : null;
  if (!Array.isArray(raw) || raw.length !== expectedCount) {
    throw new Error(`embedding 响应数量不符：期望 ${expectedCount}，得到 ${Array.isArray(raw) ? raw.length : typeof raw}`);
  }
  return raw;
}

export function createRemoteEmbedder(options: RemoteEmbedderOptions = {}) {
  const backend = String(options.backend || 'ollama').toLowerCase();
  const baseUrl = options.baseUrl || (backend === 'ollama' ? 'http://localhost:11434' : 'http://localhost:8080');
  const model = options.model;
  const apiKey = options.apiKey || '';
  const dimensions = Number(options.dimensions) || null;
  const batchSize = Math.max(1, Number(options.batchSize) || DEFAULT_BATCH);
  const workerCount = Math.max(1, Math.min(8, Math.trunc(Number(options.workerCount) || 1)));
  if (!model) throw new Error('remote embedder requires a model id (IFTREE_EMBED_MODEL)');
  const url = endpointFor(backend, baseUrl);

  async function embedBatch(texts: string[]): Promise<number[][]> {
    let json: unknown;
    for (let attempt = 0; ; attempt += 1) {
      try {
        json = await postJson(url, { model, input: texts }, apiKey);
        break;
      } catch (error: unknown) {
        if (backend !== 'ollama' || !isTransientRemoteEmbeddingError(error) || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) {
          throw error;
        }
        const delayMs = TRANSIENT_RETRY_DELAYS_MS[attempt];
        process.stderr.write(`[embed] ollama transient failure; retry ${attempt + 1}/${TRANSIENT_RETRY_DELAYS_MS.length} in ${delayMs}ms: ${(error as { message?: string } | null | undefined)?.message || error}\n`);
        await sleep(delayMs);
      }
    }
    const raw = extractVectors(backend, json, texts.length);
    return raw.map((vector) => normalizeVectorTyped(vector, dimensions));
  }

  async function embed(texts: string[]): Promise<number[][]> {
    const batches: string[][] = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      batches.push(texts.slice(offset, offset + batchSize));
    }
    const parts: number[][][] = new Array(batches.length);
    let nextBatch = 0;
    const workers = Array.from({ length: Math.min(workerCount, batches.length) }, async () => {
      for (;;) {
        const index = nextBatch;
        nextBatch += 1;
        if (index >= batches.length) return;
        parts[index] = await embedBatch(batches[index]);
      }
    });
    await Promise.all(workers);
    return parts.flat();
  }

  // 健康检查 + 维度校验：切后端前先确认可达且维度匹配（避免污染 lance 表）。
  async function healthCheck() {
    const [vector] = await embedBatch(['healthcheck']);
    if (dimensions && vector.length !== dimensions) {
      throw new Error(`远程嵌入维度不符：期望 ${dimensions}，得到 ${vector.length}（换模型需同维或调整下限）`);
    }
    return { ok: true, backend, url, model, dimensions: vector.length };
  }

  return { backend, url, model, batchSize, workerCount, embed, embedBatch, healthCheck };
}

// 从环境变量解析后端配置。未声明则返回 null（调用方回落本地 transformers）。
export function resolveEmbedBackendConfig(env: RemoteEmbedBackendEnv = process.env) {
  const choice = String(env.IFTREE_EMBED_BACKEND || 'transformers').toLowerCase();
  if (choice === 'transformers' || choice === 'local' || !choice) return null;
  return {
    backend: choice, // 'ollama' | 'openai' | 'llamacpp'
    baseUrl: env.IFTREE_EMBED_BASE_URL || '',
    model: env.IFTREE_EMBED_MODEL || '',
    apiKey: env.IFTREE_EMBED_API_KEY || '',
    batchSize: env.IFTREE_EMBED_BATCH ? Number(env.IFTREE_EMBED_BATCH) : undefined,
    workerCount: env.IFTREE_EMBED_WORKERS ? Number(env.IFTREE_EMBED_WORKERS) : undefined,
    fallback: env.IFTREE_EMBED_FALLBACK !== '0'
  };
}
