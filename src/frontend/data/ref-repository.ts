// @ts-nocheck
import { writeDatabase } from './database-client.js';

export const refRepository = {
  async addAxiomRefToNode(payload) {
    const result = await writeDatabase({ action: 'ref.addAxiomToNode', ...(payload || {}) });
    return result?.doc || result;
  },

  async deleteRef(payload) {
    const result = await writeDatabase({ action: 'ref.delete', ...(payload || {}) });
    return result?.doc || result;
  }
};
