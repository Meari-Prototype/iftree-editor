// 语义向量状态标准化。写入侧（derived-index-reconciler.refreshDocSemanticMeta 持久化到
// docs.meta.semantic）与读取侧（query-api 直接读列）共用同一份分类，避免两处逻辑漂移。
// 输入可来自 docVectorStatus（{enabled, available, vectorCount, nodeCount, reason}），
// 也可来自已持久化、再读出的 meta.semantic（已带 status 字段）——对两者皆幂等：
// 持久化的 disabled 没有 enabled:false 字段，故额外认 status==='disabled'，免得被回判成 missing。
export function normalizeSemanticStatus(status = {}) {
  const vectorCount = Math.max(0, Number(status.vectorCount ?? status.vector_count) || 0);
  const nodeCount = Math.max(0, Number(status.nodeCount ?? status.node_count) || 0);
  const enabled = status.enabled !== false && status.status !== 'disabled';
  if (!enabled) return { status: 'disabled', available: false, vectorCount, nodeCount, reason: status.reason || 'vector_disabled' };
  if (status.available === true || (nodeCount > 0 ? vectorCount >= nodeCount : vectorCount > 0)) {
    return { status: 'ready', available: true, vectorCount, nodeCount };
  }
  return {
    status: 'missing',
    available: false,
    vectorCount,
    nodeCount,
    reason: vectorCount > 0 ? 'vector_partial' : (status.reason || 'vector_missing')
  };
}
