import { handleStreamMutation } from './doc.mjs';
import {
  createMemoryVolume,
  findActiveSessionVolume,
  markMemoryVolumeDistilled
} from '../../memory-volumes.mjs';

// 建卷与节点写入不在同一事务（push 的事务在 store 内自管），先把最常见的违约拦在建卷前，
// 避免写入失败留下空卷。
function assertDeliverNodes(items) {
  for (const item of items || []) {
    const trust = item?.trust_level ?? item?.trustLevel ?? null;
    if (trust !== '不受控') {
      throw new Error('事件卷节点必须显式 trust_level=不受控（projectneed 15-10-3）');
    }
    const children = Array.isArray(item?.children) ? item.children : [];
    if (children.length) assertDeliverNodes(children);
  }
}

// 15-10-4：记忆卷落库即建库内实体锚；建不出就删掉刚建的卷、拒绝创建无锚卷（无锚即拒）。
function anchorMemoryVolumeOrRollback(store, ctx, { docId, agent, sessionId, hostAnchor }) {
  if (typeof ctx?.writeMemoryAnchor !== 'function') {
    store.deleteDoc(docId);
    throw new Error('当前写入上下文未提供记忆卷建锚能力，拒绝创建无锚卷（projectneed 15-10-4）。');
  }
  try {
    ctx.writeMemoryAnchor({ docId, agent, sessionId, hostAnchor });
  } catch (error) {
    store.deleteDoc(docId);
    throw new Error(`记忆卷建锚失败、已回滚（projectneed 15-10-4 非导航文档必有库内实体锚）：${error?.message || error}`);
  }
}

// 完整记忆动词（projectneed 15-10 / 15-11-5 / 18-8-4）。
// deliverVolume = 建卷 + 流式写入一步完成：投递语义就是新建一个文档（15-10-1），
// 节点写入复用 stream.push 同一条链（FTS/向量增量随行），不设第二套机制（15-10-2）。
export async function handleMemoryMutation(store, payload, ctx, action, effects) {
  if (action === 'memory.deliverVolume') {
    // 投递级幂等：网络层重试不该长出第二个卷。
    const dedupeKey = payload.idempotencyKey ?? payload.idempotency_key ?? null;
    const deliverKey = dedupeKey ? `memory.deliverVolume:${dedupeKey}` : null;
    const cached = store._streamPushFromCache(deliverKey);
    if (cached) return { ...cached, deduped: true };

    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    if (!nodes.length) throw new Error('memory.deliverVolume 需要至少一个节点（自述日志骨架见 projectneed 18-8-4）');
    assertDeliverNodes(nodes);

    const created = createMemoryVolume(store, {
      title: payload.title ?? null,
      agent: payload.agent ?? payload.agentId ?? payload.agent_id ?? null,
      sessionId: payload.sessionId ?? payload.session_id ?? null,
      hostAnchor: payload.hostAnchor ?? payload.host_anchor ?? null,
      startedAt: payload.startedAt ?? payload.started_at ?? null,
      endedAt: payload.endedAt ?? payload.ended_at ?? null
    });
    anchorMemoryVolumeOrRollback(store, ctx, {
      docId: created.docId,
      agent: payload.agent ?? payload.agentId ?? payload.agent_id ?? null,
      sessionId: payload.sessionId ?? payload.session_id ?? null,
      hostAnchor: payload.hostAnchor ?? payload.host_anchor ?? null
    });
    const pushed = await handleStreamMutation(store, {
      docId: created.docId,
      nodes,
      embed: payload.embed === true
    }, ctx, 'stream.push', effects);
    const result = {
      ok: true,
      action,
      docId: created.docId,
      title: created.title,
      volume: created.volume,
      createdCount: pushed.createdCount,
      created: pushed.created,
      refresh: { kind: 'doc', docId: created.docId },
      sideEffects: effects
    };
    store._rememberStreamPush(deliverKey, result);
    return result;
  }
  // 内置 agent 逐 turn 增量落卷（15-10-2 内侧）：找该 session 的活跃卷追加；
  // 没有或已物理封卷则新建（续）卷后追加。外部投递请用 memory.deliverVolume。
  if (action === 'memory.appendSessionTurn') {
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    if (!nodes.length) throw new Error('memory.appendSessionTurn 需要至少一个节点');
    assertDeliverNodes(nodes);
    const agent = String(payload.agent ?? '').trim();
    const sessionId = String(payload.sessionId ?? payload.session_id ?? '').trim();
    if (!agent || !sessionId) throw new Error('memory.appendSessionTurn 需要 agent 与 sessionId（15-10-1）');

    const active = findActiveSessionVolume(store, { agent, sessionId });
    let docId = active?.docId ?? null;
    let createdVolume = false;
    if (!docId) {
      const created = createMemoryVolume(store, {
        title: payload.title ?? null,
        agent,
        sessionId,
        hostAnchor: payload.hostAnchor ?? payload.host_anchor ?? null,
        startedAt: payload.startedAt ?? payload.started_at ?? null
      });
      docId = created.docId;
      createdVolume = true;
      anchorMemoryVolumeOrRollback(store, ctx, {
        docId: created.docId,
        agent,
        sessionId,
        hostAnchor: payload.hostAnchor ?? payload.host_anchor ?? null
      });
    }
    const pushed = await handleStreamMutation(store, {
      docId,
      nodes,
      embed: payload.embed === true
    }, ctx, 'stream.push', effects);
    return {
      ok: true,
      action,
      docId,
      createdVolume,
      createdCount: pushed.createdCount,
      refresh: { kind: 'doc', docId },
      sideEffects: effects
    };
  }
  if (action === 'memory.markDistilled') {
    const result = markMemoryVolumeDistilled(store, {
      docId: payload.docId ?? payload.doc_id ?? null,
      force: payload.force === true
    });
    return { ok: true, action, ...result, sideEffects: effects };
  }
  throw new Error(`Unhandled database_write action: ${action}`);
}
