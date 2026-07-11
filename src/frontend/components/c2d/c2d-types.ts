// c2d-types.ts
// C2DMapView 渲染链共享类型。结构上兼容 node-model 的 TreeNode 与
// MindMapView 的 axiom 块（后者多出 axiomId 字段）。

// 节点 id 全链路是字符串：数据库是 uuidv7 TEXT 主键（旧 INTEGER 库在 store
// 打开时一次性迁移），lazy 编辑分支用 `tmp-…` 前缀字符串；node-model 的
// normalizeNodeId 再把任何输入统一成 string。
export interface C2DBlock {
  id: string;
  address: string;
  parentId: string | null;
  depth?: number;
  childCount: number;
  nodeType: string;
  title?: string;
  text?: string;
  note?: string;
  // 与 node-model.TreeNode.sourcePosition 形态对齐（来源行 unknown，本地按需 narrow）。
  sourcePosition?: unknown;
  axiomId?: string | null;
  [extra: string]: unknown;
}

export interface C2DGroup {
  parent: C2DBlock | null;
  blocks: C2DBlock[];
  direction?: 'left';
}

export interface C2DColumn {
  kind?: string;
  groups: C2DGroup[];
}

export interface C2DTreeIndex {
  byId: Map<string, C2DBlock>;
  byAddress: Map<string, C2DBlock>;
  // node-model.TreeIndex.childrenOf 真形态 = Map<string | null, T[]>（null key 收 root 的 parentId）。
  childrenOf: Map<string | null, C2DBlock[]>;
  root: C2DBlock | null;
  size: number;
}

export interface ConnectorLine {
  key: string;
  d: string;
  bounds?: { left: number; top: number; width: number; height: number };
}

export interface ConnectorMeasure {
  lines: ConnectorLine[];
  w: number;
  h: number;
}

export interface ContentStats {
  words: number;
  charsNoSpace: number;
  charsWithSpace: number;
}

export interface NodeStats {
  own: ContentStats;
  subtree: ContentStats;
  subtreeNodeCount: number;
  remainingDepth: number;
  nextDepthWidth: number;
}

// buildStatsIndex 的聚合中间量：charsSum/nonEmptyCount 用于在 statsForNode
// 里补回 join 分隔符数，maxDepth 用于剩余深度。键是节点 id。
export interface C2DStatsEntry {
  own: ContentStats;
  words: number;
  charsNoSpace: number;
  charsSum: number;
  nonEmptyCount: number;
  nodeCount: number;
  maxDepth: number;
}

export type StatsIndex = Map<string, C2DStatsEntry>;
