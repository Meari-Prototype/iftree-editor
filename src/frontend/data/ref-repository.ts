import { writeDatabase } from './database-client.js';

// 字段宽松：IPC 边界，调用方不必先 cast。
interface AddAxiomRefPayload {
  docId?: unknown;
  nodeId?: unknown;
  axiomId?: unknown;
  note?: string | null;
}

interface DeleteRefPayload {
  docId?: unknown;
  refId?: unknown;
}

export const refRepository = {
  async addAxiomRefToNode(payload: AddAxiomRefPayload) {
    const result = await writeDatabase({ action: 'ref.addAxiomToNode', ...(payload || {}) }) as { doc?: unknown } | null | undefined;
    return result?.doc || result;
  },

  async deleteRef(payload: DeleteRefPayload) {
    const result = await writeDatabase({ action: 'ref.delete', ...(payload || {}) }) as { doc?: unknown } | null | undefined;
    return result?.doc || result;
  }
};
