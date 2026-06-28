// DB 行类型层（数据形状发源处）。逐表对齐本文件的 SQL DDL：
//   - 列名一比一 snake_case（DB 直出即 snake_case，全 backend 无 camelCase 别名）。
//   - NOT NULL -> 必填；其余 -> `T | null`（如 parent_id / meta / trust_level）。
//   - 带 CHECK 枚举的列用字面量联合（node_type / edit_mode / trust_level / kind 等）。
//   - INTEGER -> number，含 0/1 布尔列（axioms_collapsed / nodes_hash_dirty）不擅自转 boolean，
//     由领域层转换。
//   - `DEFAULT CURRENT_TIMESTAMP` 的时间戳列虽无 NOT NULL，但所有写路径都走默认值、从不写 NULL，
//     故类型为 string（避免下游被迫到处判空）。
//
// 约定：这些是“整行”形状。部分列 SELECT（如 `SELECT id FROM docs`）请在调用处用 Pick<DocRow, ...>；
// JOIN 出的派生列（如 child_count）请就地用交叉类型 `NodeRow & { child_count: number }` 扩展。
// 此处不加索引签名，保留 strict 取属性检查。

export type NodeType =
  | 'TEXT'
  | 'IF'
  | 'THEN'
  | 'ELSE'
  | 'LOOP'
  | 'FOREACH'
  | 'BREAK'
  | 'CONTINUE'
  | 'ERROR'
  | 'HUMAN_BLOCK'
  | 'HUMAN_SUMMARY';

export type TrustLevel = '受控' | '不受控';

export type DocEditMode = 'readonly' | 'incremental' | 'full';

export type NodeSizeMode = 'auto' | 'manual';

export type ObjectKind = 'blob' | 'tree' | 'source';

export type EntityLinkKind = 'synonym' | 'related';

export type EntityBindingStatus = 'bound' | 'ignored';

export interface DocRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  meta: string | null;
  folder_id: number | null;
  doc_sort_order: number;
  axioms_collapsed: number;
  tree_view_state: string;
  nodes_hash_dirty: number;
  edit_mode: DocEditMode;
}

export interface DocFolderRow {
  id: number;
  parent_id: number | null;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface NodeRow {
  id: string;
  doc_id: string;
  parent_id: string | null;
  sort_order: number;
  depth: number;
  address: string;
  node_type: NodeType;
  text: string;
  node_title: string;
  node_note: string;
  source_position: number | null;
  trust_level: TrustLevel | null;
  content_hash: string | null;
  subtree_hash: string | null;
  title_chars: number;
  text_chars: number;
  note_chars: number;
  created_at: string;
  updated_at: string;
}

export interface AxiomRow {
  id: string;
  doc_id: string;
  label: string;
  content: string;
  status: string;
  node_title: string;
  node_note: string;
  node_width: number | null;
  node_height: number | null;
  node_size_mode: NodeSizeMode;
}

export interface RefRow {
  id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  ref_kind: string;
  note: string | null;
}

export interface SourceDocumentRow {
  doc_id: string;
  source_type: string;
  original_path: string | null;
  raw_markdown: string;
  created_at: string;
}

export interface SourceSpanRow {
  id: number;
  doc_id: string;
  node_id: string | null;
  sentence_index: number;
  start_offset: number;
  end_offset: number;
  text: string;
}

export interface SourcePdfPageRow {
  id: number;
  doc_id: string;
  page_number: number;
  width: number;
  height: number;
}

export interface SourcePdfCharRow {
  id: number;
  doc_id: string;
  char_offset: number;
  page_number: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  char_text: string;
}

export interface SourceDocBlockRow {
  id: number;
  doc_id: string;
  block_index: number;
  start_offset: number;
  end_offset: number;
}

export interface CommitRow {
  id: string;
  doc_id: string;
  parent_commit_id: string | null;
  committed_at: string;
  summary: string | null;
  author: string | null;
  root_node_id: string | null;
  root_tree_hash: string | null;
  source_hash: string | null;
  meta: string | null;
}

export interface ObjectRow {
  hash: string;
  kind: ObjectKind;
  data: string;
}

export interface DocHeadRow {
  doc_id: string;
  head_commit_id: string | null;
  updated_at: string;
}

export interface EditBranchRow {
  id: number;
  base_doc_id: string;
  shadow_doc_id: string;
  owner: string;
  status: string;
  created_at: string;
  updated_at: string;
  base_snapshot: string;
  diff: string;
}

export interface EntityRow {
  id: string;
  doc_id: string;
  literal: string;
  normalized_literal: string;
  created_at: string;
  updated_at: string;
}

export interface EntityLinkRow {
  id: number;
  kind: EntityLinkKind;
  entity_a_id: string;
  entity_b_id: string;
  created_at: string;
  updated_at: string;
}

export interface EntityNodeBindingRow {
  id: number;
  entity_id: string;
  node_id: string;
  status: EntityBindingStatus;
  created_at: string;
  updated_at: string;
}

export const AXIOM_ORDER_SQL = "CAST(CASE WHEN label GLOB 'A[0-9]*' THEN substr(label, 2) ELSE 0 END AS INTEGER), id";

// schema 版本号（PRAGMA user_version）：建库/导入时盖章；启动只读它判断要不要迁移，跑过不再全表扫。
// 升版本号 = 需要一次 导出→导入 迁移（本版本不在 init 里做旧库原地升级）。
export const SCHEMA_VERSION = 1;

export const TABLES_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  meta TEXT,
  folder_id INTEGER REFERENCES doc_folders(id) ON DELETE SET NULL,
  doc_sort_order INTEGER NOT NULL DEFAULT 0,
  axioms_collapsed INTEGER NOT NULL DEFAULT 0,
  tree_view_state TEXT NOT NULL DEFAULT '{}',
  nodes_hash_dirty INTEGER NOT NULL DEFAULT 1,
  edit_mode TEXT NOT NULL DEFAULT 'full' CHECK(edit_mode IN ('readonly', 'incremental', 'full'))
);

CREATE TABLE IF NOT EXISTS doc_folders (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES doc_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_doc_folders_parent ON doc_folders(parent_id);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  depth INTEGER NOT NULL DEFAULT 1,
  address TEXT NOT NULL DEFAULT '',
  node_type TEXT NOT NULL DEFAULT 'TEXT' CHECK(node_type IN ('TEXT', 'IF', 'THEN', 'ELSE', 'LOOP', 'FOREACH', 'BREAK', 'CONTINUE', 'ERROR', 'HUMAN_BLOCK', 'HUMAN_SUMMARY')),
  text TEXT NOT NULL DEFAULT '',
  node_title TEXT NOT NULL DEFAULT '',
  node_note TEXT NOT NULL DEFAULT '',
  source_position REAL,
  trust_level TEXT CHECK(trust_level IN ('受控', '不受控') OR trust_level IS NULL),
  content_hash TEXT,
  subtree_hash TEXT,
  title_chars INTEGER NOT NULL DEFAULT 0,
  text_chars INTEGER NOT NULL DEFAULT 0,
  note_chars INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nodes_doc ON nodes(doc_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_doc_parent_order ON nodes(doc_id, parent_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_nodes_doc_depth ON nodes(doc_id, depth);
CREATE INDEX IF NOT EXISTS idx_nodes_doc_address ON nodes(doc_id, address);
CREATE INDEX IF NOT EXISTS idx_nodes_doc_source_position ON nodes(doc_id, source_position, id);

CREATE TABLE IF NOT EXISTS axioms (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  node_title TEXT NOT NULL DEFAULT '',
  node_note TEXT NOT NULL DEFAULT '',
  node_width REAL,
  node_height REAL,
  node_size_mode TEXT NOT NULL DEFAULT 'auto'
);

CREATE TABLE IF NOT EXISTS refs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_refs_source ON refs(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_type, target_id);

CREATE TABLE IF NOT EXISTS source_documents (
  doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL DEFAULT 'md',
  original_path TEXT,
  raw_markdown TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_spans (
  id INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  sentence_index INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_source_spans_doc ON source_spans(doc_id, sentence_index);
CREATE INDEX IF NOT EXISTS idx_source_spans_node ON source_spans(node_id);
CREATE INDEX IF NOT EXISTS idx_source_spans_doc_offsets ON source_spans(doc_id, start_offset, end_offset);
CREATE INDEX IF NOT EXISTS idx_source_spans_doc_node_offset ON source_spans(doc_id, node_id, start_offset);

CREATE TABLE IF NOT EXISTS source_pdf_pages (
  id INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_pdf_pages_doc_page ON source_pdf_pages(doc_id, page_number);

CREATE TABLE IF NOT EXISTS source_pdf_chars (
  id INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  char_offset INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  x0 REAL NOT NULL,
  y0 REAL NOT NULL,
  x1 REAL NOT NULL,
  y1 REAL NOT NULL,
  char_text TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_source_pdf_chars_doc_offset ON source_pdf_chars(doc_id, char_offset);
CREATE INDEX IF NOT EXISTS idx_source_pdf_chars_doc_page ON source_pdf_chars(doc_id, page_number);

-- word(docx) 块锚点：每行一个 XML 块（<w:p>/<w:tbl>）→ 它在重建文本的偏移范围 + 在 document.xml 里的
-- 全局块序号。字符 i（重建文本偏移）定位 = 找包含 i 的块 + (i − start_offset) 块内偏移；前端 docx-preview
-- 渲到第 block_index 个块的 DOM、数块内偏移高亮。块内偏移可推算，故每块一行（不像 pdf 每字符一行）。
CREATE TABLE IF NOT EXISTS source_doc_blocks (
  id INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  block_index INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_doc_blocks_doc_offset ON source_doc_blocks(doc_id, start_offset, end_offset);

-- save_history 已退役：历史以 commits 为事实来源；旧库残留表在 dropLegacySaveHistory 迁移期删除。

CREATE TABLE IF NOT EXISTS commits (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  parent_commit_id TEXT REFERENCES commits(id) ON DELETE SET NULL,
  committed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  summary TEXT,
  author TEXT,
  -- 内容寻址历史（第 4 步）：root_tree_hash 指向对象库节点树、source_hash 指向 raw_markdown source 对象、
  -- meta 内联 doc/axioms/refs 这三块小且重复率低的数据（不进对象库，见 algo-refactor-plan 第 4 步）。
  root_node_id TEXT,
  root_tree_hash TEXT,
  source_hash TEXT,
  meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_commits_doc_time ON commits(doc_id, committed_at, id);

-- 内容寻址对象库（第 4 步 git 对象模型）：commit 只存根 tree 的 hash，节点内容/结构按 hash 去重存进对象库。
-- blob = 单节点内容（merkle CONTENT_FIELDS 5 字段），tree = {自己 blob_hash + 各子 tree_hash 按序}。
-- hash 纯复用 core/merkle 的 contentHash / subtreeHash（位置无关），相同子树跨 commit 跨文档只存一份。
CREATE TABLE IF NOT EXISTS objects (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('blob', 'tree', 'source')),
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_heads (
  doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
  head_commit_id TEXT REFERENCES commits(id) ON DELETE SET NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS edit_branches (
  id INTEGER PRIMARY KEY,
  base_doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  shadow_doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  owner TEXT NOT NULL DEFAULT 'human',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  base_snapshot TEXT NOT NULL,
  diff TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_branches_base_owner_active
ON edit_branches(base_doc_id, owner)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_edit_branches_shadow_status ON edit_branches(shadow_doc_id, status);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  literal TEXT NOT NULL,
  normalized_literal TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(doc_id, normalized_literal)
);

CREATE INDEX IF NOT EXISTS idx_entities_doc ON entities(doc_id);
CREATE INDEX IF NOT EXISTS idx_entities_literal ON entities(literal);

CREATE TABLE IF NOT EXISTS entity_links (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('synonym', 'related')),
  entity_a_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  entity_b_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entity_a_id, entity_b_id),
  CHECK(entity_a_id <> entity_b_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_links_a ON entity_links(entity_a_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_b ON entity_links(entity_b_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_kind ON entity_links(kind);

CREATE TABLE IF NOT EXISTS entity_node_bindings (
  id INTEGER PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('bound', 'ignored')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entity_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_node_bindings_entity ON entity_node_bindings(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_node_bindings_node ON entity_node_bindings(node_id);
CREATE INDEX IF NOT EXISTS idx_entity_node_bindings_status ON entity_node_bindings(status);

-- 派生维护触发器（随表声明，建空库即带，导入/迁移与 init 共用同一份，不再靠 init 单独补建）。
-- 失效触发器：对 nodes 内容/结构列的写把所属 doc 标脏（O(1)，覆盖一切写路径，回写 hash 不自我失效）。
CREATE TRIGGER IF NOT EXISTS trg_nodes_hash_dirty_insert
AFTER INSERT ON nodes BEGIN
  UPDATE docs SET nodes_hash_dirty = 1 WHERE id = NEW.doc_id AND nodes_hash_dirty = 0;
END;
CREATE TRIGGER IF NOT EXISTS trg_nodes_hash_dirty_update
AFTER UPDATE OF text, node_title, node_note, node_type, trust_level, parent_id, sort_order ON nodes BEGIN
  UPDATE docs SET nodes_hash_dirty = 1 WHERE id = NEW.doc_id AND nodes_hash_dirty = 0;
END;
CREATE TRIGGER IF NOT EXISTS trg_nodes_hash_dirty_delete
AFTER DELETE ON nodes BEGIN
  UPDATE docs SET nodes_hash_dirty = 1 WHERE id = OLD.doc_id AND nodes_hash_dirty = 0;
END;
-- 字数缓存触发器：写 text/title/note 即按主键单行同步 *_chars，只更 *_chars 不触发上面的失效、不自我递归。
CREATE TRIGGER IF NOT EXISTS trg_nodes_text_chars_insert
AFTER INSERT ON nodes BEGIN
  UPDATE nodes SET title_chars = LENGTH(COALESCE(NEW.node_title, '')), text_chars = LENGTH(COALESCE(NEW.text, '')), note_chars = LENGTH(COALESCE(NEW.node_note, '')) WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_nodes_text_chars_update
AFTER UPDATE OF text, node_title, node_note ON nodes BEGIN
  UPDATE nodes SET title_chars = LENGTH(COALESCE(NEW.node_title, '')), text_chars = LENGTH(COALESCE(NEW.text, '')), note_chars = LENGTH(COALESCE(NEW.node_note, '')) WHERE id = NEW.id;
END;
`;
