import { writeDatabase } from './database-client.js';

// 字段宽松：IPC 边界 id 可能 unknown，调用方不必先 cast。
interface AddAxiomPayload {
  docId?: unknown;
  content?: unknown;
  status?: unknown;
}

interface AxiomMutationPayload {
  docId?: unknown;
  axiomId?: unknown;
  patch?: Record<string, unknown>;
  direction?: 'up' | 'down';
}

export const axiomRepository = {
  async addAxiom(payload: AddAxiomPayload) {
    return writeDatabase({ action: 'axiom.add', ...(payload || {}) });
  },

  async updateAxiom(payload: AxiomMutationPayload) {
    const result = await writeDatabase({ action: 'axiom.update', ...(payload || {}) }) as { doc?: unknown } | null | undefined;
    return result?.doc || result;
  },

  async deleteAxiom(payload: AxiomMutationPayload) {
    const result = await writeDatabase({ action: 'axiom.delete', ...(payload || {}) }) as { doc?: unknown } | null | undefined;
    return result?.doc || result;
  },

  async moveAxiom(payload: AxiomMutationPayload) {
    const result = await writeDatabase({ action: 'axiom.move', ...(payload || {}) }) as { doc?: unknown } | null | undefined;
    return result?.doc || result;
  }
};
