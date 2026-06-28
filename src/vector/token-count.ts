// 真 token 计数（第 2 步嵌入守卫）：用模型自带 tokenizer 算 token 数，与嵌入模型一致。
// 三后端通用——@huggingface/transformers 的 AutoTokenizer 已是依赖，按模型 Xenova 名加载就是
// bge-m3 / bge-large 的真 tokenizer；无论嵌入实际跑在 ollama / llama.cpp / 本地 DirectML（都跑同一 bge），
// JS 侧这一个 tokenizer 都对得上，不必为每个后端各接 /tokenize。
// 加载失败（离线 / 无模型文件 / 未装 transformers）退回保守字数估算 + 标记 fallback——绝不硬编码窗口大小。
// 步骤4：@huggingface/transformers 降为可选依赖，这里改动态 import（懒加载）；未装时 import 抛错被
// 下面 catch 接住，直接走字数 fallback，不崩模块加载。
import type { Tokenizer } from '@huggingface/transformers';

interface TokenCounterOptions {
  modelName?: string;
  localModelRoot?: string;
}

export function createTokenCounter({ modelName, localModelRoot = '' }: TokenCounterOptions = {}) {
  let tokenizerPromise: Promise<Tokenizer | null> | null = null;
  let fallback = false;

  async function loadTokenizer(): Promise<Tokenizer | null> {
    if (!tokenizerPromise) {
      tokenizerPromise = (async () => {
        try {
          if (!modelName) throw new Error('token counter requires modelName');
          const { AutoTokenizer, env } = await import('@huggingface/transformers');
          // transformers env：有本地模型根用本地、否则允许远程拉取（首次下载后缓存）。
          if (localModelRoot) {
            env.allowLocalModels = true;
            env.localModelPath = localModelRoot;
          } else {
            env.allowRemoteModels = true;
          }
          return await AutoTokenizer.from_pretrained(modelName);
        } catch {
          fallback = true;
          return null;
        }
      })();
    }
    return tokenizerPromise;
  }

  // 单条文本的 token 数。tokenizer 不可用时退回字数：CJK ≈ 1 token/字、英文字数远多于 token，
  // 故字数是 token 数的保守上界——宁可多跳几个，绝不把超长放进嵌入（避免后端 HTTP 400 整批空转）。
  async function count(text: unknown): Promise<number> {
    const value = String(text ?? '');
    if (value.length === 0) return 0;
    const tokenizer = await loadTokenizer();
    if (!tokenizer) return value.length;
    const encoded = await tokenizer(value, { add_special_tokens: true, truncation: false });
    return encoded?.input_ids?.size
      ?? encoded?.input_ids?.dims?.at?.(-1)
      ?? value.length;
  }

  return {
    count,
    get usingFallback() { return fallback; }
  };
}
