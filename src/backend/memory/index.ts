// 外部 agent 记忆子系统（projectneed 15-10 / 15-11）：三层时态记忆里的「完整记忆」层——
// 事件卷投递 / 长期核心记忆提炼 / 召回（列卷）/ 封卷·孤儿清理。单向依赖 store 做持久化
// （store 实例运行时作参数传入，模块不反向 import store），是 memory 自己的语义边界。
// 消费者：外部 agent（MCP memory_*）、内嵌 agent（逐 turn 落卷）、host（孤儿清理运维）。
// query-api / mutation-api / host 只把动作转发到这里，不内联 memory 语义。
export { runMemoryRead, MEMORY_READ_ACTIONS } from './read.js';
export { handleMemoryMutation } from './write.js';
export { purgeOrphanedMemoryVolumes } from './maintenance.js';

// 记忆区目录结构规范（.memory / memory 两目录的结构权威）：host 建事件卷锚、迁移脚本、将来读长期记忆
// 都从这里取路径构造与合法性校验，记忆模块自管这两个目录的结构，不散落在 host / query-api。
export {
  EVENT_VOLUME_ROOT,
  LONG_TERM_MEMORY_ROOT,
  LONG_TERM_MEMORY_FILENAMES,
  PLACEHOLDER_TENANT,
  PLACEHOLDER_WORKSPACE,
  isPlaceholderTenant,
  isPlaceholderWorkspace,
  isLegalEventVolumeLayout,
  eventVolumeAnchorDir,
  longTermMemoryDir,
  illegalEventVolumeMessage
} from './anchor-layout.js';

// 供别的模块单向只读 memory 标记用（不经动作分发）：store 删除保护 / 信任断言读 memoryVolumeMetaOf；
// 检索侧另走 SQL 直读 meta 判 doc 类型（event/memory/knowledge），不依赖这里。
export {
  memoryVolumeMetaOf,
  listMemoryVolumes,
  createMemoryVolume,
  findActiveSessionVolume,
  markMemoryVolumeDistilled,
  sealDueMemoryVolumes,
  listMemoryVolumeAnchors,
  selectOrphanedMemoryVolumes,
  deriveVolumeState,
  VOLUME_STATES,
  VOLUME_SEAL_IDLE_MS,
  VOLUME_DISTILL_COOLDOWN_MS
} from './volumes.js';
