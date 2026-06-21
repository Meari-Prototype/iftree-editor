// 记忆区目录结构规范（projectneed 15-10-4 多租户隔离）：记忆模块是 .memory / memory 两个目录结构的
// 唯一权威。事件卷锚：<library>/.memory/<租户>/<工作区>/<会话>；长期核心记忆：
// <library>/memory/<租户>/[<工作区>/]CLAUDE.md|AGENTS.md（租户根下=该 agent 的通用核心记忆，
// 工作区下=项目核心记忆）。租户=agent 身份、工作区=真实工作区，二者都不许是占位兜底——占位
// （租户 unknown-agent / 工作区 _local）即结构非法，必须迁到正确位置或清理，绝不让各 agent 记忆混放或游离。
//
// 独立寄生：这里只定义「结构 + 纯路径计算 + 纯校验」，不碰主库写入/事务、不依赖任何后端模块——
// 删掉整个 memory/ 目录主库照常工作，记忆是寄生在主库上的可删除附加层。
import { join } from 'node:path';

export const EVENT_VOLUME_ROOT = '.memory';     // 事件卷锚根（. 开头隐藏目录，检索默认排除——隐藏逻辑是通用规则、不属本模块）
export const LONG_TERM_MEMORY_ROOT = 'memory';  // 长期核心记忆根（非隐藏）
export const PLACEHOLDER_TENANT = 'unknown-agent';
export const PLACEHOLDER_WORKSPACE = '_local';
export const LONG_TERM_MEMORY_FILENAMES = Object.freeze(['CLAUDE.md', 'AGENTS.md']);

export function isPlaceholderTenant(tenant) {
  const value = String(tenant || '').trim();
  return value === '' || value === PLACEHOLDER_TENANT;
}

export function isPlaceholderWorkspace(workspace) {
  const value = String(workspace || '').trim();
  return value === '' || value === PLACEHOLDER_WORKSPACE;
}

// 路径段是否会逃出锚目录或在路径里游走：. / .. 在 join 里被规约成目录跳转（.. 还能逃出 .memory），
// 残留分隔符同理。身份/工作区都必须是不逃逸的单段普通名（健壮性，非安全——本地无攻击者，
// 但畸形 agent/工作区值不许穿透成路径跳转、坏掉「删 .memory 即清空记忆」的结构契约）。
function isUnsafeSegment(value) {
  const v = String(value || '').trim();
  return v === '.' || v === '..' || v.includes('/') || v.includes('\\');
}

// 事件卷锚是否落在合法的 <租户>/<工作区>/ 结构下（两层都非占位、且都是不逃逸的单段普通名）。
export function isLegalEventVolumeLayout(tenant, workspace) {
  if (isUnsafeSegment(tenant) || isUnsafeSegment(workspace)) return false;
  return !isPlaceholderTenant(tenant) && !isPlaceholderWorkspace(workspace);
}

// 事件卷锚目录：<libraryRoot>/.memory/<租户>/<工作区>/
export function eventVolumeAnchorDir(libraryRoot, tenant, workspace) {
  return join(libraryRoot, EVENT_VOLUME_ROOT, tenant, workspace);
}

// 长期核心记忆目录：<libraryRoot>/memory/<租户>/[<工作区>/]（无工作区=通用核心记忆，有=项目核心记忆）。
export function longTermMemoryDir(libraryRoot, tenant, workspace = '') {
  const base = join(libraryRoot, LONG_TERM_MEMORY_ROOT, tenant);
  return workspace ? join(base, workspace) : base;
}

// 锚结构非法时的报错（写入占位目录后冒泡，引导用户迁移或清理，不静默接受）。
/** @param {{ tenant?: string, workspace?: string, linkPath?: string }} [opts] */
export function illegalEventVolumeMessage({ tenant, workspace, linkPath } = {}) {
  const reason = isPlaceholderTenant(tenant) ? '无法确定 agent 身份（租户）' : '无法确定工作区';
  return `记忆卷锚结构非法：${reason}，落在占位目录 ${linkPath || '(.memory 占位)'}。`
    + '记忆区要求 .memory/<租户>/<工作区>/<会话> 三层隔离，不得游离或跨 agent 混放。'
    + '请带可解析工作区与身份的 hostAnchor 重新投递并迁移到对应目录，'
    + '或删除此卷后用运维工具 scripts/purge-orphaned-volumes 清理。';
}
