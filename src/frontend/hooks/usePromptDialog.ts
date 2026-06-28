import { useCallback, useRef, useState } from 'react';

// 把「弹确认框 -> 等用户点选 -> resolve 一个 Promise」这套命令式弹窗统一成一个 hook。
// 调用 prompt(payload, supersedeValue) 打开弹窗并返回 Promise；若上一个弹窗还没回答
// 就被再次 prompt 顶掉，旧 Promise 用 supersedeValue 兜底 resolve，绝不泄漏。
export function usePromptDialog() {
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const resolveRef = useRef<((choice: unknown) => void) | null>(null);

  const prompt = useCallback((nextPayload: Record<string, unknown> | null | undefined = {}, supersedeValue: unknown = null) => (
    new Promise<unknown>((resolvePromise) => {
      const previous = resolveRef.current;
      resolveRef.current = resolvePromise;
      setPayload(nextPayload || {});
      if (previous) previous(supersedeValue);
    })
  ), []);

  const resolve = useCallback((choice: unknown) => {
    const settle = resolveRef.current;
    resolveRef.current = null;
    setPayload(null);
    if (settle) settle(choice);
  }, []);

  return {
    open: payload != null,
    payload,
    prompt,
    resolve
  };
}
