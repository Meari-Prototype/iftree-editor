// store 的 React 绑定：selector 级订阅（frontend-refactor.md §4.8 第 4 条——不做整快照广播，
// 「改一个节点」只惊动依赖它的视图）。
//
// getSnapshot 必须引用稳定：selector 返回对象/数组时每次都是新引用，直接交给
// useSyncExternalStore 会「每次通知都重渲」甚至 render 死循环。这里缓存上次 selected，
// isEqual 判等则返回旧引用。代价是 getSnapshot 每次调用都跑一遍 selector——selector
// 必须轻（取字段/浅组装），重投影放命令层或 store 内做好再存。

import { useRef, useSyncExternalStore } from 'react';

import type { Store } from './create-store.js';

export { shallowEqual } from './create-store.js';

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getState);
}

export function useStoreSelector<T, S>(
  store: Store<T>,
  selector: (state: T) => S,
  isEqual: (a: S, b: S) => boolean = Object.is
): S {
  const cacheRef = useRef<{ selected: S } | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const selected = selector(store.getState());
    const prev = cacheRef.current;
    if (prev && isEqual(prev.selected, selected)) return prev.selected;
    cacheRef.current = { selected };
    return selected;
  });
}
