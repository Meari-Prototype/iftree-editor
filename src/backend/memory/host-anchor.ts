// 事件卷宿主锚的写入与判存（自 headless-agent-host 拆入 memory 域，§6-8「运维动作归各域」）：
// 锚 symlink 落盘（library/.memory/<身份>/<工作区>/<会话>.jsonl，15-10-4）、hostAnchor 解析、
// 锚存在性判断（lstat 不解引用——悬空 symlink / 占位文件都算「锚还在」）。
// 布局规则住 anchor-layout；store 写入经注入的 setMemoryAnchorSource，本件不直摸库。
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import {
  eventVolumeAnchorDir,
  illegalEventVolumeMessage,
  isLegalEventVolumeLayout,
  PLACEHOLDER_TENANT,
  PLACEHOLDER_WORKSPACE
} from './index.js';

// hostAnchor（路径#sessionid）→ 目标文件路径 + 推断的宿主工作区名。
export function memoryAnchorTargetWorkspace(anchor: unknown): { targetPath: string; workspace: string } {
  const raw = String(anchor || '');
  const targetPath = raw.split('#')[0].trim();
  const matched = targetPath.match(/[\\/]\.claude[\\/]projects[\\/]([^\\/]+)[\\/]/);
  return { targetPath, workspace: matched ? matched[1] : '' };
}

function sanitizeAnchorSegment(value: unknown, fallback: string): string {
  const text = String(value || '').replace(/[\\/:*?"<>|]+/g, '_').trim();
  // 纯 . / .. 是路径跳转（join 会规约、.. 能逃出 .memory 锚目录），空段同样非法——一律落占位 fallback，
  // 再由 isLegalEventVolumeLayout 当占位拦下报错（健壮性：畸形 agent/工作区不许穿透成目录跳转）。
  if (!text || text === '.' || text === '..') return fallback;
  return text;
}

// lstatSync 不解引用：路径本身（含悬空 symlink、空占位文件）存在即视为「锚还在」，
// 仅当锚文件被真正删除（lstat 抛 ENOENT）才判脱锚。
export function anchorPathExists(anchorPath: string): boolean {
  try {
    return Boolean(lstatSync(anchorPath));
  } catch {
    return false;
  }
}

export interface WriteMemoryAnchorInput {
  docId?: unknown;
  agent?: unknown;
  sessionId?: unknown;
  hostAnchor?: unknown;
}

export interface MemoryAnchorWriterDeps {
  libraryRoot: string;
  setMemoryAnchorSource: (docId: unknown, linkPath: string) => unknown;
}

// 记忆卷库内实体锚（projectneed 15-10-4）：library/.memory/<身份>/<工作区>/<会话>.jsonl
// 作 symlink 指向宿主原始记录（jsonl / agent.sqlite，允许悬空）；无可用目标则落真实占位文件，绝不留无锚。
// 建链后写 source_documents；任何失败抛出，由调用方回滚删卷（无锚即拒，15-10-4）。
export function createMemoryAnchorWriter({ libraryRoot, setMemoryAnchorSource }: MemoryAnchorWriterDeps) {
  return function writeMemoryAnchor({ docId, agent, sessionId, hostAnchor }: WriteMemoryAnchorInput = {}): string {
    if (!docId) throw new Error('writeMemoryAnchor requires docId');
    const { targetPath, workspace } = memoryAnchorTargetWorkspace(hostAnchor);
    const tenant = sanitizeAnchorSegment(agent, PLACEHOLDER_TENANT);
    const ws = sanitizeAnchorSegment(workspace, PLACEHOLDER_WORKSPACE);
    const dir = eventVolumeAnchorDir(libraryRoot, tenant, ws);
    mkdirSync(dir, { recursive: true });
    const linkPath = join(dir, `${sanitizeAnchorSegment(sessionId, 'session')}.jsonl`);
    try {
      if (lstatSync(linkPath)) rmSync(linkPath, { force: true });
    } catch {
      // 锚位不存在即可，直接建
    }
    // 不空卷直接造（projectneed 15-10-4）：事件卷必须锚定真实 session 文件，去掉悬空占位兜底——
    // targetPath 的存在性由 deliverVolume 的 sessionVolumeNodes（existsSync）先行校验，这里是落库前的双保险。
    if (!targetPath || !existsSync(targetPath)) {
      throw new Error(`session 文件不存在、无法锚定：${targetPath || '(空)'}（不接受悬空锚，projectneed 15-10-4）`);
    }
    symlinkSync(targetPath, linkPath, 'file');
    setMemoryAnchorSource(docId, linkPath);
    // 多租户隔离校验（projectneed 15-10-4）：锚落占位目录（_local / unknown-agent）即结构非法。锚已写、
    // 卷已落库——抛 illegalMemoryLayout 让投递报错但不回滚（卷留下由用户迁移或清理），绝不静默接受游离 / 跨 agent 混放。
    if (!isLegalEventVolumeLayout(tenant, ws)) {
      const error = new Error(illegalEventVolumeMessage({ tenant, workspace: ws, linkPath })) as Error & { illegalMemoryLayout?: boolean };
      error.illegalMemoryLayout = true;
      throw error;
    }
    return linkPath;
  };
}
