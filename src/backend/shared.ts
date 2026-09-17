type JsonObject = Record<string, unknown>;

// 记忆卷元标记（docs.meta.memoryVolume）的纯解析；memory 域策略与装配层共用。
// 与 parseJsonObject 不同：meta 可能已是解析过的对象，对象输入原样返回。
export function memoryVolumeMetaOf(docMeta: unknown): Record<string, unknown> | null {
  let meta: unknown = docMeta;
  if (meta && typeof meta !== 'object') {
    try {
      meta = JSON.parse(meta as string);
    } catch {
      meta = null;
    }
  }
  const volume = (meta as JsonObject | null)?.memoryVolume;
  return volume && typeof volume === 'object' ? (volume as Record<string, unknown>) : null;
}

export function parseJsonObject(value: unknown, fallback: JsonObject = {}): JsonObject {
  try {
    const parsed = value ? JSON.parse(value as string) : fallback;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// 时间戳比较归一：库里 created_at/updated_at 两种格式混存——表默认 CURRENT_TIMESTAMP 产
// 'YYYY-MM-DD HH:MM:SS'（空格、UTC、无毫秒），restore/导入等 JS 写入路径产 ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'。
// 直接字典序比较在异格式相遇时出错（' ' 0x20 < 'T' 0x54：ISO 格式的 since 会把同日下午的空格格式行
// 错误排除——「放进去了却搜不出来」）。归一到同一形态（'YYYY-MM-DDTHH:MM:SS.sssZ'）后字典序=时间序。
// 归一是同构映射（两格式表示同一时间轴），比较双方同过此函数即数学等价。
// 输入必须是无偏移 UTC：带 ±hh:mm 时区尾的输入不匹配本正则、原样返回（与垃圾输入同策略——
// 静默丢弃偏移会把本地时刻错标成 UTC）。不用 Date.parse：非 ISO 串按本地时区解析，反而引入新漂移。
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z?)?$/;

export function normalizeTimestampForCompare(value: unknown): string {
  const text = String(value ?? '').trim();
  const m = TIMESTAMP_RE.exec(text);
  if (!m) return text;
  const [, year, month, day, hour = '00', minute = '00', second = '00', ms = '0'] = m;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${(ms as string).padEnd(3, '0')}Z`;
}

interface AddressedNode {
  id?: unknown;
  address?: unknown;
}

export function compareNodeAddress(a: AddressedNode | null | undefined, b: AddressedNode | null | undefined): number {
  const aParts = String(a?.address || '').split('-').filter(Boolean).map(Number);
  const bParts = String(b?.address || '').split('-').filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) return diff;
  }
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

// 文档编辑模式三态标签（projectneed 4-16-8）：只读 / 增量编辑（流式写入）/ 完整编辑（2way/3way）。
export const EDIT_MODE_LABELS = Object.freeze({
  readonly: '只读',
  incremental: '增量编辑（流式写入）',
  full: '完整编辑'
});

// 编辑模式不符时的统一报错（projectneed 4-16-8 / NOW 1-2）：写入动词自报当前模式、所需模式与切换办法，
// 调用方据此一步切模式即可，不必预先建模"现在处于什么模式"的状态机。
// 后端为 GUI / db 外壳 / MCP 共用，故同时给出两条文字通道的切模式动词。
interface EditModeMismatchOptions {
  docId: unknown;
  current?: string | null;
  required: string;
  intent: string;
}

export function editModeMismatchMessage({ docId, current, required, intent }: EditModeMismatchOptions): string {
  const labels = EDIT_MODE_LABELS as Record<string, string>;
  const cur = (current ? labels[current] : undefined) || current || '未知';
  const req = labels[required] || required;
  return `${intent}要求文档 ${docId} 处于${req}模式，当前为${cur}；请先 set_mode 切到 ${required}（db 外壳：db set-mode ${docId} ${required}）`;
}

// 节点补丁字段校验：底座 updateNode 与编辑分支 stage/nodePatchForEditBranch 共用，故下沉到这里。
// human_tag 已退场（改 node_type）、trust_level 只走 human certify（18-3），补丁里夹这些字段一律报错。
export function hasOwnValue(source: unknown, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(source || {}, key));
}

export function assertNoHumanTagField(source: unknown, context = 'node patch'): void {
  if (hasOwnValue(source, 'human_tag', 'humanTag')) {
    throw new Error(`${context} no longer supports human_tag; set node_type instead`);
  }
}

export function assertNoEditTrustField(source: unknown, context = 'node patch'): void {
  if (hasOwnValue(source, 'trust_level', 'trustLevel', 'trust')) {
    throw new Error(`${context} no longer supports trust_level; use human certify to set trust_level`);
  }
}

// 节点间引用的 refKind 卫生校验：按 15-5-2-1 它是必填的自由分类词（不设枚举、不提供默认值），
// 但自由不等于不设防——挡长文本误传、控制字符、以及 axiom→node 的系统保留值。
// 草稿 stage（edit-branch）与落库重放（store.addNodeRefToNode）共用，故下沉到这里。
export function assertValidNodeRefKind(kind: string, context = 'ref.addNodeToNode'): void {
  if (/[\r\n\t]/.test(kind)) {
    throw new Error(`${context}: refKind 不能含换行/制表符——它是简短分类词（如 相关/参见/依赖），说明文字请放 note`);
  }
  if (kind.length > 32) {
    throw new Error(`${context}: refKind 过长（${kind.length} > 32 字符）——它是简短分类词（如 相关/参见/依赖），说明文字请放 note`);
  }
  if (kind === '事实前提') {
    throw new Error(`${context}: refKind「事实前提」是 axiom→node 引用的系统保留值；节点间引用请换其它分类词（挂公理用 ref.addAxiomToNode）`);
  }
}
