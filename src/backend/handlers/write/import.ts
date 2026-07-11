// 导入 / 派生索引服务动词（§6-2c 下沉）：实现体是 host 装配的域服务（import-service 的
// createLibraryDocumentService、derived-index 的 ensureDocVectors），经 WriteContext 注入；
// 本 handler 只校验参数并转发。action 名是这些能力在动作面上的唯一通道——CLI（db import/
// vectors/delete）、MCP 工具、GUI 管道动词殊途同归到同一实现。
import { requireDocId, type WriteContext } from './shared.js';
import { handleDocMutation } from './doc.js';
import type { IftreeStore } from '../../store/index.js';

type WritePayload = Record<string, unknown>;
type EffectList = Array<Record<string, unknown>>;
type ServiceResult = Record<string, unknown> | null | undefined;

export async function handleImportServiceMutation(
  store: IftreeStore,
  payload: WritePayload,
  ctx: WriteContext,
  action: string,
  effects: EffectList
): Promise<Record<string, unknown>> {
  if (action === 'import.libraryDocument') {
    if (typeof ctx.importLibraryDocument !== 'function') {
      throw new Error('import.libraryDocument 不可用：宿主未注入 importLibraryDocument（需 host 装配环境）');
    }
    const relativePath = String(payload.relativePath ?? payload.relative_path ?? '').trim();
    if (!relativePath) throw new Error('import.libraryDocument requires relativePath');
    const request: WritePayload = { relativePath };
    if (payload.mode != null) request.mode = String(payload.mode);
    if (payload.embed === true) request.embed = true;
    return ((await ctx.importLibraryDocument(request)) as ServiceResult) ?? { ok: true, action };
  }
  if (action === 'import.deleteDocument') {
    const docId = requireDocId(payload);
    if (typeof ctx.deleteImportedDocument === 'function') {
      return ((await ctx.deleteImportedDocument({ docId })) as ServiceResult) ?? { ok: true, action, docId };
    }
    // 无宿主注入（独立 database-service 环境）回退纯库删除——与原 db-shell delete 的回退口径一致。
    return (await handleDocMutation(store, { docId }, ctx, 'doc.delete', effects)) as Record<string, unknown>;
  }
  if (action === 'vector.ensureDoc') {
    const docId = requireDocId(payload);
    if (typeof ctx.ensureDocVectors !== 'function') {
      throw new Error('vector.ensureDoc 不可用：向量模块未接入（ensureDocVectors 未注入）');
    }
    return ((await ctx.ensureDocVectors(docId)) as ServiceResult) ?? { ok: true, action, docId };
  }
  throw new Error(`Unhandled database_write action: ${action}`);
}
