export function chatCompletionUrl(baseUrl, fullUrl = false) {
  const base = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  if (fullUrl) return base;
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

export function anthropicMessagesUrl(baseUrl, fullUrl = false) {
  const base = String(baseUrl || 'https://api.deepseek.com/anthropic').trim().replace(/\/+$/, '');
  if (fullUrl) return base;
  if (base.endsWith('/messages')) return base;
  if (base.endsWith('/v1')) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function defaultFetchers() {
  if (typeof fetch !== 'function') return [];
  return [(target, init) => fetch(target, init)];
}

function cleanUrlForError(url) {
  return String(url || '').replace(/\?.*$/, '');
}

function abortError(message = '请求已取消') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export async function fetchLlmResponse(url, options = {}, config = {}) {
  const fetchers = Array.isArray(config.fetchers) && config.fetchers.length > 0
    ? config.fetchers
    : defaultFetchers();
  const errors = [];
  const externalSignal = config.signal || options.signal || null;

  for (const fetcher of fetchers) {
    if (externalSignal?.aborted) throw abortError();
    const controller = new AbortController();
    let externalAbort = false;
    let timeoutAbort = false;
    const onExternalAbort = () => {
      externalAbort = true;
      controller.abort();
    };
    const timer = setTimeout(() => {
      timeoutAbort = true;
      controller.abort();
    }, Math.max(1, Number(config.timeoutMs) || 45000));
    externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
    try {
      return await fetcher(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (externalAbort || externalSignal?.aborted) throw abortError();
      if (timeoutAbort) errors.push(new Error('请求超时'));
      else errors.push(error);
    } finally {
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
      clearTimeout(timer);
    }
  }

  const detail = errors
    .map((error) => error?.cause?.message || error?.message || String(error))
    .filter(Boolean)
    .join('; ');
  const prefix = config.errorPrefix || 'LLM 请求失败';
  throw new Error(`${prefix}: 无法连接 ${cleanUrlForError(url)}。${detail || '网络请求未成功'}`);
}

export async function readJsonSseStream(response, onChunk, options = {}) {
  const signal = options.signal || null;
  const assertNotAborted = () => {
    if (signal?.aborted) throw abortError();
  };
  const decoder = new TextDecoder();
  let buffer = '';

  const handleLine = (line) => {
    assertNotAborted();
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      onChunk(JSON.parse(data));
    } catch {
      // Ignore malformed SSE keepalive chunks.
    }
  };

  const pushText = (text) => {
    assertNotAborted();
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) handleLine(line);
  };

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    for (;;) {
      assertNotAborted();
      const { done, value } = await reader.read();
      if (done) break;
      pushText(decoder.decode(value, { stream: true }));
    }
  } else if (response.body) {
    for await (const chunk of response.body) {
      assertNotAborted();
      pushText(decoder.decode(chunk, { stream: true }));
    }
  }

  pushText(decoder.decode());
  if (buffer.trim()) handleLine(buffer);
}
