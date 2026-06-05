import {
  DEFAULT_VECTOR_CONFIG,
  normalizeVectorConfig,
  zeroEmbedding
} from './embeddings.mjs';

class EmbeddingWorkerSlot {
  constructor(index) {
    this.index = index;
    this.worker = new Worker(new URL('./embedding-worker.js', import.meta.url), { type: 'module' });
    this.busy = false;
    this.current = null;
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = (event) => this.handleError(event.error || new Error(event.message));
  }

  run(task) {
    this.busy = true;
    this.current = task;
    this.worker.postMessage({ id: task.id, texts: task.texts, config: task.config });
  }

  handleMessage(message) {
    const task = this.current;
    if (message?.progress) {
      task?.onProgress?.(message.progress);
      return;
    }
    this.busy = false;
    this.current = null;
    if (!task) return;
    if (message?.error) {
      task.reject(new Error(message.error.message || String(message.error)));
    } else {
      task.resolve(message?.vectors || []);
    }
    task.onComplete?.();
  }

  handleError(error) {
    const task = this.current;
    this.busy = false;
    this.current = null;
    if (task) {
      task.reject(error);
      task.onComplete?.();
    }
  }

  terminate() {
    this.worker.terminate();
  }
}

export function createGpuEmbeddingService(options = {}) {
  const initialConfig = normalizeVectorConfig({ ...DEFAULT_VECTOR_CONFIG, ...options });
  const workers = [];
  const queue = [];
  let sequence = 0;

  function ensureWorkerCount(targetCount) {
    const count = Math.max(1, Number(targetCount) || initialConfig.workerCount);
    while (workers.length < count) {
      workers.push(new EmbeddingWorkerSlot(workers.length));
    }
    while (workers.length > count) {
      const worker = workers[workers.length - 1];
      if (worker.busy) break;
      worker.terminate();
      workers.pop();
    }
  }

  ensureWorkerCount(initialConfig.workerCount);

  function schedule() {
    for (const worker of workers) {
      if (worker.busy) continue;
      const task = queue.shift();
      if (!task) return;
      worker.run(task);
    }
  }

  function runBatch(texts, config, onProgress) {
    return new Promise((resolve, reject) => {
      queue.push({
        id: ++sequence,
        texts,
        config,
        resolve,
        reject,
        onProgress,
        onComplete: schedule
      });
      schedule();
    });
  }

  async function embed(texts, runtimeConfig = DEFAULT_VECTOR_CONFIG, onProgress = null) {
    const config = normalizeVectorConfig(runtimeConfig);
    ensureWorkerCount(config.workerCount);
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

    const batchJobs = [];
    for (let offset = 0; offset < pending.length; offset += config.batchSize) {
      const batch = pending.slice(offset, offset + config.batchSize);
      batchJobs.push(runBatch(batch.map((item) => item.text), config, onProgress).then((vectors) => {
        for (const [batchIndex, item] of batch.entries()) {
          results[item.index] = vectors[batchIndex];
        }
      }));
    }
    await Promise.all(batchJobs);

    return results;
  }

  return {
    embed,
    dispose() {
      for (const worker of workers) worker.terminate();
      queue.length = 0;
    }
  };
}
