// Aho-Corasick 多模式字面匹配自动机。
//
// 一次扫描即可在文本里找出「所有模式串」的「全部出现」，时间复杂度
// O(文本长度 + 命中数)，与模式数量无关。这是字面连续命中召回的精确解：
// 全量、不截断——区别于 FTS/BM25 那种「按相关性排序取 top-N」的近似召回。
//
// 用途（projectneed）：
//   - 13-2 实体↔节点绑定：一次扫描把整个实体库的命中全找出来；
//   - 14-3 keyword 字面召回：把用户输入的词当模式串扫节点正文，全量命中。
//
// 约定：大小写归一化是调用方的语义，本模块只做字节级匹配。调用方需保证
// 模式 key 与被扫文本已按同一口径归一化（实体/keyword 两路都先转小写）。

interface AhoCorasickNode<T> {
  next: Map<string, number>;
  fail: number;
  outputs: T[];
}

function ahoCorasickNode<T>(): AhoCorasickNode<T> {
  // next：goto 转移表（字符 -> 状态下标）；fail：失配指针；outputs：到达该状态命中的模式（含后缀链）
  return { next: new Map(), fail: 0, outputs: [] };
}

/**
 * 构建 Aho-Corasick 自动机。
 * @param patterns
 *   模式串列表，每项至少含 key（要匹配的字面，已归一化）；其余字段原样随命中回传。
 * @returns
 *   scan 沿文本逐字符转移，每命中一个模式就以该模式对象回调 visit 一次。
 */
export function buildAhoCorasickMatcher<T extends { key: string }>(patterns: T[] = []) {
  const nodes: AhoCorasickNode<T>[] = [ahoCorasickNode<T>()];
  const valid = patterns.filter((pattern) => pattern && pattern.key);

  // 1. 建 trie：把每个模式串的字符路径铺成 goto 转移，终点挂上该模式。
  for (const pattern of valid) {
    let state = 0;
    for (const char of pattern.key) {
      if (!nodes[state].next.has(char)) {
        nodes[state].next.set(char, nodes.length);
        nodes.push(ahoCorasickNode<T>());
      }
      state = nodes[state].next.get(char)!;
    }
    nodes[state].outputs.push(pattern);
  }

  // 2. BFS 逐层建失配指针，并把失配链上的 outputs 合并上来，
  //    使得到达任一状态时能一次吐出「以此处结尾的所有模式」（含作为后缀的较短模式）。
  const queue: number[] = [];
  for (const nextState of nodes[0].next.values()) queue.push(nextState);
  while (queue.length > 0) {
    const state = queue.shift()!;
    for (const [char, nextState] of nodes[state].next.entries()) {
      let fail = nodes[state].fail;
      while (fail && !nodes[fail].next.has(char)) fail = nodes[fail].fail;
      nodes[nextState].fail = nodes[fail].next.get(char) ?? 0;
      nodes[nextState].outputs.push(...nodes[nodes[nextState].fail].outputs);
      queue.push(nextState);
    }
  }

  // 3. 扫描：沿 goto 转移，失配时回退 fail 指针，命中即吐出该状态的全部 outputs。
  return {
    scan(text = '', visit: (output: T) => void = () => {}) {
      const haystack = String(text || '');
      let state = 0;
      for (const char of haystack) {
        while (state && !nodes[state].next.has(char)) state = nodes[state].fail;
        state = nodes[state].next.get(char) ?? 0;
        for (const output of nodes[state].outputs) visit(output);
      }
    }
  };
}
