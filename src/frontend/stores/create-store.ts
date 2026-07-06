// domain store 最小内核（frontend-refactor.md §4.2 约束：零新运行时依赖，自写 ~75 行工具）。
// 纯 TS、无 React 依赖，可 node --test；React 绑定见 use-store.ts。
//
// 范式对齐 document-session：状态转移是纯函数（prev → next），store 只做「持引用 + 通知」。
// setState 返回原引用即视为无变化、不广播——对齐 useDocumentState.setViewSnapshot 的防回环
// 惯例（project() 每次造新引用会让下游 effect churn，见该处注释）。
//
// 接缝契约（§4.8）：store 互不 import，跨 store 协调一律走命令层；store 单例只由装配根
// 与命令层持有，视图经 use-store.ts 的 selector 订阅读取，不 import 单例。

export interface Store<T> {
  getState(): T;
  setState(next: T | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initialState: T): Store<T> {
  let state = initialState;
  const listeners = new Set<() => void>();
  return {
    getState() {
      return state;
    },
    setState(next) {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
      if (Object.is(resolved, state)) return;
      state = resolved;
      // 快照后遍历：listener 内再 subscribe/unsubscribe 不影响本轮通知。
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

// 浅比较：selector 返回「浅组装对象」（如 { a: x.a, b: x.b }）时用它当 isEqual，
// 字段引用全同则视为未变。只比一层，深层变化靠上游换引用（函数式转移天然满足）。
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}
