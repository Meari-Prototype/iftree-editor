// 写动词 / 状态返回的形状（write-result-text 渲染、未来 mutation-api 标注返回值的权威契约）。
// 不同 action 返回不同字段子集，故全部可选；嵌套对象复用 db/rows 的行类型 + 少量回执专属字段。
// 刻意不加索引签名：保留对「拼错字段名」的 strict 检测。

import type {
  NodeRow,
  DocRow,
  RefRow,
  EntityRow,
  EditBranchRow,
  SourceDocumentRow,
} from './db/rows.js';

// commit/history 回执条目（commit_id 与 id 并存是历史口径差异）。
export interface CommitSummary {
  commit_id?: string;
  id?: string;
  summary?: string;
  author?: string;
  saved_at?: string;
}

// 编辑分支变更计数：中英双键并存（后端给中文键、旧路径给英文键）。
export interface BranchCounts {
  改?: number; update?: number;
  增?: number; insert?: number;
  删?: number; delete?: number;
  移?: number; move?: number;
  其他?: number; other?: number;
  撤销?: number; undone?: number;
}

export type BranchSummary = Partial<EditBranchRow> & { counts?: BranchCounts };

// 结构化冲突条目（applyMerge blocked 时回带）。
export interface ConflictEntry {
  id?: string | number;
  address?: string;
  field?: string;
  ours?: unknown;
  theirs?: unknown;
}

// push 回带的新建节点子树（嵌套 children）。
export interface PushNode {
  id?: string | number;
  address?: string;
  children?: PushNode[];
}

// memory_deliver 回带的卷元信息。
export interface DeliverVolume {
  agent?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
}

// memory_volumes 列表项。
export interface VolumeListItem {
  docId?: string;
  state?: string;
  agent?: string;
  sessionId?: string;
  title?: string;
  nodeCount?: number;
  lastActivityAt?: string;
}

export interface WriteResult {
  ok?: boolean;
  error?: string;
  message?: string;
  action?: string;

  changed?: boolean;
  applied?: boolean;
  fastForward?: boolean;
  blocked?: boolean;
  editMode?: string;

  docId?: string | number;
  baseDocId?: string | number;
  branchId?: string | number;
  owner?: string;
  commitId?: string;
  revertCommitId?: string;

  doc?: Partial<DocRow> & { history?: CommitSummary[] };
  node?: Partial<NodeRow> & { pending_insert?: boolean };
  entity?: Partial<EntityRow>;
  axiom?: Record<string, unknown>;
  link?: Record<string, unknown>;
  ref?: Partial<RefRow> & { kind?: string };
  editBranch?: BranchSummary;
  branch?: BranchSummary;
  source?: Partial<SourceDocumentRow>;
  history?: CommitSummary;

  insertedNodeId?: string | number | null;
  insertedAxiomId?: string | number | null;
  insertedRefId?: string | number | null;

  undoDepth?: number;
  redoDepth?: number;

  pragmas?: Record<string, unknown>;
  restoredPragmas?: Record<string, unknown>;
  checkpoint?: string;
  touchedNodeIds?: Array<string | number>;
  touchedDocIds?: Array<string | number>;
  conflicts?: ConflictEntry[];

  nodeId?: string | number | null;
  sourceNodeId?: string | number | null;
  targetNodeId?: string | number | null;
  newParentId?: string | number | null;
  axiomId?: string | number | null;
  refId?: string | number | null;
  entityId?: string | number | null;
  entityIds?: Array<string | number>;
  kind?: string | null;
  status?: string | null;
  direction?: string | null;

  // push
  createdCount?: number;
  createdRootId?: string | number;
  parentId?: string | number;
  created?: PushNode[];

  // memory_deliver
  title?: string;
  volume?: DeliverVolume;

  // memory_volumes
  volumes?: VolumeListItem[];
  total?: number;
  now?: string;

  // sql
  rows?: unknown[];
  rowCount?: number;
  truncated?: boolean;
}
