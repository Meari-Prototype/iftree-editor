export const AXIOM_ORDER_SQL = "CAST(CASE WHEN label GLOB 'A[0-9]*' THEN substr(label, 2) ELSE 0 END AS INTEGER), id";

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
  tree_view_state TEXT NOT NULL DEFAULT '{}'
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
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nodes_doc ON nodes(doc_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_doc_parent_order ON nodes(doc_id, parent_id, sort_order, id);

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

CREATE TABLE IF NOT EXISTS save_history (
  id INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  commit_id TEXT REFERENCES commits(id) ON DELETE SET NULL,
  saved_at TEXT DEFAULT CURRENT_TIMESTAMP,
  summary TEXT,
  diff TEXT
);

CREATE TABLE IF NOT EXISTS commits (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  parent_commit_id TEXT REFERENCES commits(id) ON DELETE SET NULL,
  committed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  summary TEXT,
  diff TEXT NOT NULL DEFAULT '{}',
  snapshot TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_commits_doc_time ON commits(doc_id, committed_at, id);

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
`;
