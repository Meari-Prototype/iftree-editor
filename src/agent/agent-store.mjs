import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

function json(value, fallback = null) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function rowToSession(row) {
  if (!row) return null;
  return {
    ...row,
    context: parseJson(row.context_json, {}),
    result: parseJson(row.result_json, {})
  };
}

function rowToSessionSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    prompt: row.prompt,
    doc_id: row.doc_id,
    selected_node_id: row.selected_node_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    pending_diff_count: row.pending_diff_count || 0
  };
}

function legacyMessagesFromSession(session) {
  if (!session) return [];
  const result = session.result || {};
  if (Array.isArray(result.messages)) return result.messages;
  const createdAt = session.created_at || new Date().toISOString();
  const updatedAt = session.updated_at || createdAt;
  const messages = [];
  if (session.prompt) {
    messages.push({
      role: 'user',
      mode: session.mode,
      content: session.prompt,
      createdAt
    });
  }
  if (result.answer || result.error) {
    messages.push({
      role: 'assistant',
      mode: session.mode,
      content: result.answer || result.error,
      status: result.error ? '失败' : '已保存',
      error: Boolean(result.error),
      diffCount: Number(result.pendingDiffCount || session.pending_diff_count || 0),
      usage: result.usage || null,
      toolEvents: Array.isArray(result.toolEvents) ? result.toolEvents : [],
      createdAt: updatedAt
    });
  }
  return messages;
}

export class AgentStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.init();
  }

  init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        doc_id INTEGER,
        selected_node_id INTEGER,
        context_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // agent_diffs 物理退役（projectneed 18-1）：A2A 待审已统一为 owner=llm:<会话> 编辑分支，
    // 独立待审 diff 表与 commits/edit_branches 不再有等价用途；旧库残留表在此删除（零数据迁移，
    // 索引随表删除），等价于主库的 dropLegacySaveHistory。
    this.db.exec('DROP TABLE IF EXISTS agent_diffs');
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }

  createSession({ mode, prompt, docId = null, selectedNodeId = null, context = {} }) {
    const result = this.db.prepare(`
      INSERT INTO agent_sessions (mode, prompt, doc_id, selected_node_id, context_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(mode, prompt, docId, selectedNodeId, json(context, {}));
    return this.getSession(Number(result.lastInsertRowid));
  }

  startSessionTurn({ sessionId = null, mode, prompt, docId = null, selectedNodeId = null, context = {} }) {
    const id = Number(sessionId);
    const existing = Number.isInteger(id) && id > 0 ? this.getSession(id) : null;
    if (!existing) return this.createSession({ mode, prompt, docId, selectedNodeId, context });
    this.db.prepare(`
      UPDATE agent_sessions
      SET mode = ?, doc_id = ?, selected_node_id = ?, context_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(mode, docId, selectedNodeId, json(context, {}), existing.id);
    return this.getSession(existing.id);
  }

  finishSession(sessionId, result = {}) {
    this.db.prepare(`
      UPDATE agent_sessions
      SET result_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(json(result, {}), sessionId);
    return this.getSession(sessionId);
  }

  finishSessionTurn(sessionId, result = {}, turnMessages = []) {
    const current = this.getSession(sessionId);
    const previousResult = current?.result || {};
    const previousMessages = Array.isArray(previousResult.messages)
      ? previousResult.messages
      : ((previousResult.answer || previousResult.error) ? legacyMessagesFromSession(current) : []);
    return this.finishSession(sessionId, {
      ...previousResult,
      ...result,
      messages: [...previousMessages, ...turnMessages]
    });
  }

  getSession(sessionId) {
    return rowToSession(this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sessionId));
  }

  listSessions({ limit = 40 } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40));
    // 待审计数（pending_diff_count）不再由本库子查询提供（agent_diffs 已退役）：
    // 待审已是 owner=llm:<会话> 编辑分支，跨库归属，由 agent-runtime.listAgentSessions
    // 合并主库分支后补齐该字段。
    return this.db.prepare(`
      SELECT
        s.id,
        s.mode,
        s.prompt,
        s.doc_id,
        s.selected_node_id,
        s.created_at,
        s.updated_at
      FROM agent_sessions s
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT ?
    `).all(safeLimit).map(rowToSessionSummary);
  }

  deleteSession(sessionId) {
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const result = this.db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
