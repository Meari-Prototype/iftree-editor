// 树的 DFS 先序遍历原语 —— 纯 address 推导，不需要完整树在手。
//
// 这是系统的查询逻辑核心：前端扩散加载算「下一个该取谁」、后端 node.listChildren 的
// anchor 窗口、检索定位、按身份穿透，都基于同一套 DFS 序推导，不各写一份（防两套实现）。
//
// address 约定：'1' 是根，'1-3-2' 是 1-3 的第 2 个子节点（前缀即父子，1-based）。
// 与 core/tree.mjs 的 flattenTree（DFS 先序）输出的序必须一致 —— 后者是「树已完整在手」
// 的遍历，本模块是它的懒加载版（树没全加载，靠 address + childCount 推导出同一个序）。
//
// childCountOf(address) => number：该地址节点的子节点数。
//   0 = 无子，或尚未加载（边界）—— 算法把「未知」当作叶处理，扩散到此自然停下，
//   等该节点加载后（childCount 变正）再继续。折叠节点想「浅探首子」或「视为叶」，
//   由调用方在 provider 里对其返回 1 或 0 决定，core 不掺 UI 状态。

type ChildCountOf = (address: string) => number | null | undefined;

// ── address 纯推导（不需要 childCountOf）──────────────────────────

export function parseAddress(address: unknown): number[] {
  return String(address || '')
    .split('-')
    .map((part) => Number(part))
    .filter((part) => Number.isInteger(part) && part >= 1);
}

export function formatAddress(parts: unknown): string {
  return (Array.isArray(parts) ? parts : []).join('-');
}

export function depthOf(address: unknown): number {
  return parseAddress(address).length;
}

export function parentAddress(address: unknown): string | null {
  const parts = parseAddress(address);
  return parts.length <= 1 ? null : formatAddress(parts.slice(0, -1));
}

export function childAddress(address: unknown, index: unknown): string | null {
  const i = Math.floor(Number(index) || 0);
  if (i < 1) return null;
  return formatAddress([...parseAddress(address), i]);
}

export function siblingAddress(address: unknown, delta: unknown): string | null {
  const parts = parseAddress(address);
  if (parts.length <= 1) return null; // 根没有兄弟
  const next = parts[parts.length - 1] + Math.trunc(Number(delta) || 0);
  if (next < 1) return null;
  return formatAddress([...parts.slice(0, -1), next]);
}

// [父, 祖, …, 根]，不含自身；根 => []
export function ancestorChain(address: unknown): string[] {
  const chain: string[] = [];
  let parent = parentAddress(address);
  while (parent) {
    chain.push(parent);
    parent = parentAddress(parent);
  }
  return chain;
}

// maybeAncestor 是 address 的严格祖先？（真前缀）
export function isAncestor(maybeAncestor: unknown, address: unknown): boolean {
  const a = formatAddress(parseAddress(maybeAncestor));
  const b = formatAddress(parseAddress(address));
  return Boolean(a) && a !== b && b.startsWith(`${a}-`);
}

// ── DFS 结构推导（需要 childCountOf）─────────────────────────────

const countOf = (childCountOf: ChildCountOf | null | undefined, address: string): number => {
  const n = Math.floor(Number(childCountOf?.(address)) || 0);
  return n > 0 ? n : 0;
};

export function firstChildAddress(address: unknown, childCountOf: ChildCountOf): string | null {
  return countOf(childCountOf, formatAddress(parseAddress(address))) > 0 ? childAddress(address, 1) : null;
}

// 子树的最右最深叶（沿「末子」链走到底）。无子则是自身。
export function lastDescendantAddress(address: unknown, childCountOf: ChildCountOf): string {
  let current = formatAddress(parseAddress(address));
  for (let count = countOf(childCountOf, current); count > 0; count = countOf(childCountOf, current)) {
    current = childAddress(current, count)!;
  }
  return current;
}

export function nextSiblingAddress(address: unknown, childCountOf: ChildCountOf): string | null {
  const parent = parentAddress(address);
  if (!parent) return null;
  const lastSeg = parseAddress(address)[parseAddress(address).length - 1];
  return lastSeg + 1 <= countOf(childCountOf, parent) ? siblingAddress(address, 1) : null;
}

export function prevSiblingAddress(address: unknown): string | null {
  const parts = parseAddress(address);
  return parts.length > 1 && parts[parts.length - 1] > 1 ? siblingAddress(address, -1) : null;
}

// DFS 先序后继：有子→首子；无子→下一兄弟；无兄弟→上溯到有下一兄弟的祖先。尽头 => null。
export function nextInDfs(address: unknown, childCountOf: ChildCountOf): string | null {
  const firstChild = firstChildAddress(address, childCountOf);
  if (firstChild) return firstChild;
  let current: string | null = formatAddress(parseAddress(address));
  while (current) {
    const sibling = nextSiblingAddress(current, childCountOf);
    if (sibling) return sibling;
    current = parentAddress(current);
  }
  return null;
}

// DFS 先序前驱：有前兄弟→前兄弟子树的最右最深叶；无前兄弟→父。根 => null。
export function prevInDfs(address: unknown, childCountOf: ChildCountOf): string | null {
  const prevSibling = prevSiblingAddress(address);
  if (prevSibling) return lastDescendantAddress(prevSibling, childCountOf);
  return parentAddress(address);
}

// 从 address（不含）向后取 count 个 DFS 后继地址。
export function dfsForward(address: unknown, count: unknown, childCountOf: ChildCountOf): string[] {
  const out: string[] = [];
  let current = formatAddress(parseAddress(address));
  const n = Math.max(0, Math.floor(Number(count) || 0));
  for (let i = 0; i < n && current; i += 1) {
    current = nextInDfs(current, childCountOf)!;
    if (current) out.push(current);
  }
  return out;
}

// 从 address（不含）向前取 count 个 DFS 前驱地址。
export function dfsBackward(address: unknown, count: unknown, childCountOf: ChildCountOf): string[] {
  const out: string[] = [];
  let current = formatAddress(parseAddress(address));
  const n = Math.max(0, Math.floor(Number(count) || 0));
  for (let i = 0; i < n && current; i += 1) {
    current = prevInDfs(current, childCountOf)!;
    if (current) out.push(current);
  }
  return out;
}

// ── 扩散取数序（加载调度器用）────────────────────────────────────
// 以焦点为中心的预取顺序：① 祖先链优先（保证从根到焦点的上下文路径先到）；
// ② 再沿 DFS 序交替向后/向前各扩 radius 步。去重、不含焦点自身。
// 这就是「一维 DFS 序上以焦点为中心的滑动窗口」——和文本虚拟滚动同构。
export function spreadAddresses(focusAddress: unknown, radius: unknown, childCountOf: ChildCountOf): string[] {
  const focus = formatAddress(parseAddress(focusAddress));
  const seen = new Set<string>(focus ? [focus] : []);
  const out: string[] = [];
  const add = (address: string | null) => {
    if (address && !seen.has(address)) {
      seen.add(address);
      out.push(address);
    }
  };

  for (const ancestor of ancestorChain(focus)) add(ancestor);

  let forward: string | null = focus;
  let backward: string | null = focus;
  const steps = Math.max(0, Math.floor(Number(radius) || 0));
  for (let i = 0; i < steps; i += 1) {
    if (forward) {
      forward = nextInDfs(forward, childCountOf);
      add(forward);
    }
    if (backward) {
      backward = prevInDfs(backward, childCountOf);
      add(backward);
    }
  }
  return out;
}
