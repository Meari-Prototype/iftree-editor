// 完整记忆 · session 卷（projectneed 15-10）：卷就是普通文档，卷性记在 docs.meta.memoryVolume。
// 状态机：active →(末次活动+24h 无更新即视为收尾) sealed →(再 +24h 冷却) distillable →(提炼动作) distilled。
// 前三态由时间戳确定性推导，per-卷独立、无全局游标（15-11-5）；物理封卷（edit_mode=readonly +
// sealedAt 落 meta）只是把已成立的事实缓存住——sealedAt 恒等于"末次活动+24h"这个逻辑时点，
// 与谁先扫到无关。末次活动只看 nodes.created_at：封卷/标记等管理动作不重置时钟。
// 中途提炼（"记一下"，15-11-5）记 distilledAt 但不封卷；封卷前的 distilledAt 只算快照备注，
// 卷封卷冷却后照常回到 distillable（尾段仍待提炼）。

export const VOLUME_SEAL_IDLE_MS = 24 * 60 * 60 * 1000;
export const VOLUME_DISTILL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const VOLUME_STATES = Object.freeze(['active', 'sealed', 'distillable', 'distilled']);

function parseMetaJson(meta) {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try {
    return JSON.parse(meta) || {};
  } catch {
    return {};
  }
}

export function memoryVolumeMetaOf(docMeta) {
  const volume = parseMetaJson(docMeta).memoryVolume;
  return volume && typeof volume === 'object' ? volume : null;
}

function parseIsoMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

// SQLite CURRENT_TIMESTAMP 是 UTC 'YYYY-MM-DD HH:MM:SS'；统一在 SQL 侧转 epoch，避免 JS 按本地时区误读。
function lastActivityMsOf(store, docId) {
  const row = store.db.prepare(`
    SELECT MAX(strftime('%s', created_at)) AS node_ts FROM nodes WHERE doc_id = ?
  `).get(docId);
  const docRow = store.db.prepare(`
    SELECT strftime('%s', created_at) AS doc_ts FROM docs WHERE id = ?
  `).get(docId);
  const seconds = Math.max(Number(row?.node_ts) || 0, Number(docRow?.doc_ts) || 0);
  return seconds * 1000;
}

export function deriveVolumeState(volume, lastActivityMs, nowMs) {
  const physicalSealMs = parseIsoMs(volume?.sealedAt);
  const sealAtMs = physicalSealMs ?? (lastActivityMs + VOLUME_SEAL_IDLE_MS);
  const distillableAtMs = sealAtMs + VOLUME_DISTILL_COOLDOWN_MS;
  const distilledMs = parseIsoMs(volume?.distilledAt);
  const sealed = physicalSealMs !== null || nowMs >= sealAtMs;
  let state;
  if (!sealed) {
    state = 'active';
  } else if (distilledMs !== null && distilledMs >= sealAtMs) {
    state = 'distilled';
  } else {
    state = nowMs >= distillableAtMs ? 'distillable' : 'sealed';
  }
  return {
    state,
    sealAt: new Date(sealAtMs).toISOString(),
    distillableAt: new Date(distillableAtMs).toISOString()
  };
}

function volumeRow(store, docRow, nowMs) {
  const volume = memoryVolumeMetaOf(docRow.meta);
  if (!volume) return null;
  const lastActivityMs = Math.max(
    (Number(docRow.last_node_ts) || 0) * 1000,
    (Number(docRow.doc_created_ts) || 0) * 1000
  ) || lastActivityMsOf(store, docRow.id);
  const derived = deriveVolumeState(volume, lastActivityMs, nowMs);
  return {
    docId: docRow.id,
    title: docRow.title,
    agent: volume.agent ?? null,
    sessionId: volume.sessionId ?? null,
    hostAnchor: volume.hostAnchor ?? null,
    state: derived.state,
    editMode: docRow.edit_mode || 'full',
    nodeCount: Number(docRow.node_count) || 0,
    startedAt: volume.startedAt ?? null,
    endedAt: volume.endedAt ?? null,
    lastActivityAt: new Date(lastActivityMs).toISOString(),
    sealAt: derived.sealAt,
    sealedAt: volume.sealedAt ?? null,
    distillableAt: derived.distillableAt,
    distilledAt: volume.distilledAt ?? null,
    createdAt: docRow.created_at
  };
}

function selectVolumeDocRows(store) {
  return store.db.prepare(`
    SELECT docs.id, docs.title, docs.meta, docs.edit_mode, docs.created_at,
           strftime('%s', docs.created_at) AS doc_created_ts,
           (SELECT COUNT(*) FROM nodes WHERE nodes.doc_id = docs.id) AS node_count,
           (SELECT MAX(strftime('%s', created_at)) FROM nodes WHERE nodes.doc_id = docs.id) AS last_node_ts
    FROM docs
    WHERE docs.meta LIKE '%"memoryVolume"%'
    ORDER BY docs.id DESC
  `).all();
}

export function listMemoryVolumes(store, { state = null, agent = null, sessionId = null, limit = 50, nowMs = Date.now() } = {}) {
  const wantState = state ? String(state).trim() : null;
  if (wantState && !VOLUME_STATES.includes(wantState)) {
    throw new Error(`未知卷状态：${wantState}；只能是 ${VOLUME_STATES.join(' / ')}`);
  }
  const max = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(500, Number(limit)) : 50;
  const rows = [];
  for (const docRow of selectVolumeDocRows(store)) {
    const row = volumeRow(store, docRow, nowMs);
    if (!row) continue;
    if (wantState && row.state !== wantState) continue;
    if (agent && row.agent !== String(agent)) continue;
    if (sessionId && String(row.sessionId) !== String(sessionId)) continue;
    rows.push(row);
    if (rows.length >= max) break;
  }
  return { kind: 'memory.listVolumes', now: new Date(nowMs).toISOString(), volumes: rows };
}

// 该 session 当前可追加的卷：最新一卷未物理封卷即活跃；已封则返回 null，
// 由调用方新建续卷（同 session id 新文档，分卷对投递方透明，15-10-1）。
// 只看物理封卷：逻辑到期但未物理落卷时迟来的 push 照常追加、时钟重置（Master 拍板的语义）。
// 不走 selectVolumeDocRows——那是管理视图的查询，对每卷拖着节点 COUNT/MAX 统计，
// 而卷只增不删、这里每个对话回合都要问一次，成本会随总卷数单调涨；
// 这里只需要最新一卷的 meta 与编辑模式，json_extract 过滤 + LIMIT 1 即停。
export function findActiveSessionVolume(store, { agent = null, sessionId = null } = {}) {
  const row = store.db.prepare(`
    SELECT id, meta, edit_mode FROM docs
    WHERE json_extract(meta, '$.memoryVolume.agent') = ?
      AND json_extract(meta, '$.memoryVolume.sessionId') = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(String(agent ?? ''), String(sessionId ?? ''));
  if (!row) return null;
  const volume = memoryVolumeMetaOf(row.meta);
  if (!volume) return null;
  if (volume.sealedAt || (row.edit_mode || 'full') !== 'incremental') return null;
  return { docId: row.id, volume };
}

function mergeVolumeMeta(store, docId, patch) {
  const docRow = store.db.prepare('SELECT id, meta FROM docs WHERE id = ?').get(docId);
  if (!docRow) throw new Error(`Doc not found: ${docId}`);
  const meta = parseMetaJson(docRow.meta);
  const volume = meta.memoryVolume && typeof meta.memoryVolume === 'object' ? meta.memoryVolume : null;
  if (!volume) throw new Error(`文档 ${docId} 不是记忆卷`);
  meta.memoryVolume = { ...volume, ...patch };
  store.db.prepare('UPDATE docs SET meta = ? WHERE id = ?').run(JSON.stringify(meta), docId);
  return meta.memoryVolume;
}

// 卷必带元信息（15-10-1）：agent 身份 + session id 必填；宿主原始记录锚允许悬空（15-10-2）。
export function createMemoryVolume(store, {
  title = null,
  agent = null,
  sessionId = null,
  hostAnchor = null,
  startedAt = null,
  endedAt = null
} = {}) {
  const agentName = String(agent || '').trim();
  const session = String(sessionId ?? '').trim();
  if (!agentName) throw new Error('记忆卷必须带 agent 身份（15-10-1）');
  if (!session) throw new Error('记忆卷必须带 session id（15-10-1）');
  const startIso = parseIsoMs(startedAt) !== null ? new Date(parseIsoMs(startedAt)).toISOString() : new Date().toISOString();
  const endIso = parseIsoMs(endedAt) !== null ? new Date(parseIsoMs(endedAt)).toISOString() : null;
  const docTitle = String(title || '').trim() || `记忆卷 ${agentName} ${startIso.slice(0, 10)} #${session}`;
  const volume = {
    agent: agentName,
    sessionId: session,
    hostAnchor: hostAnchor ? String(hostAnchor) : null,
    startedAt: startIso,
    endedAt: endIso,
    sealedAt: null,
    distilledAt: null
  };
  return store.withTransaction(() => {
    const created = store.createDoc({ title: docTitle, meta: JSON.stringify({ memoryVolume: volume }) });
    store.setDocEditMode(created.id, 'incremental');
    return { docId: created.id, rootNodeId: created.rootNodeId, title: docTitle, volume };
  });
}

// 物理封卷到期扫描：把"末次活动+24h 已过"的卷落成 readonly（结构保证不可变，15-10-1）。
// sealedAt 写逻辑时点（末次活动+24h）而非扫描时刻，保证可提炼判定与扫描节奏无关。
export function sealDueMemoryVolumes(store, { nowMs = Date.now() } = {}) {
  const sealed = [];
  for (const docRow of selectVolumeDocRows(store)) {
    const volume = memoryVolumeMetaOf(docRow.meta);
    if (!volume || volume.sealedAt) continue;
    const lastMs = Math.max(
      (Number(docRow.last_node_ts) || 0) * 1000,
      (Number(docRow.doc_created_ts) || 0) * 1000
    );
    const sealAtMs = lastMs + VOLUME_SEAL_IDLE_MS;
    if (nowMs < sealAtMs) continue;
    store.withTransaction(() => {
      mergeVolumeMeta(store, docRow.id, {
        sealedAt: new Date(sealAtMs).toISOString(),
        endedAt: volume.endedAt || new Date(lastMs).toISOString()
      });
      store.setDocEditMode(docRow.id, 'readonly');
    });
    sealed.push({ docId: docRow.id, title: docRow.title, sealedAt: new Date(sealAtMs).toISOString() });
  }
  return { kind: 'memory.sealDue', sealedCount: sealed.length, sealed };
}

// 提炼状态标记（15-11-5）：默认守冷却期（封卷+24h，不抢在反转前固化）；
// force=用户明确指示（"记一下"）立即触发——活跃卷上是"截至当下快照"备注、不封卷。
export function markMemoryVolumeDistilled(store, { docId = null, force = false, nowMs = Date.now() } = {}) {
  if (!docId) throw new Error('memory.markDistilled requires docId');
  const docRow = store.db.prepare('SELECT id, title, meta FROM docs WHERE id = ?').get(docId);
  if (!docRow) throw new Error(`Doc not found: ${docId}`);
  const volume = memoryVolumeMetaOf(docRow.meta);
  if (!volume) throw new Error(`文档 ${docId} 不是记忆卷`);
  const lastMs = lastActivityMsOf(store, docId);
  const derived = deriveVolumeState(volume, lastMs, nowMs);
  if (derived.state === 'distilled') {
    return { kind: 'memory.markDistilled', docId, alreadyDistilled: true, distilledAt: volume.distilledAt };
  }
  if ((derived.state === 'active' || derived.state === 'sealed') && !force) {
    throw new Error(`卷 ${docId} 尚在冷却期（${derived.distillableAt} 起可提炼）；用户明确指示时加 force 立即触发`);
  }
  const nowIso = new Date(nowMs).toISOString();
  return store.withTransaction(() => {
    if (derived.state !== 'active' && !volume.sealedAt) {
      // 逻辑已封但物理未落：补落，保持 sealedAt=逻辑时点。
      mergeVolumeMeta(store, docId, {
        sealedAt: derived.sealAt,
        endedAt: volume.endedAt || new Date(lastMs).toISOString()
      });
      store.setDocEditMode(docId, 'readonly');
    }
    const updated = mergeVolumeMeta(store, docId, { distilledAt: nowIso });
    return {
      kind: 'memory.markDistilled',
      docId,
      state: derived.state === 'active' ? 'active' : 'distilled',
      snapshotOnly: derived.state === 'active',
      distilledAt: updated.distilledAt
    };
  });
}
