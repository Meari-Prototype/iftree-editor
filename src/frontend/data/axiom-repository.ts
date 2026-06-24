// @ts-nocheck
import { writeDatabase } from './database-client.js';

export const axiomRepository = {
  async addAxiom(payload) {
    return writeDatabase({ action: 'axiom.add', ...(payload || {}) });
  },

  async updateAxiom(payload) {
    const result = await writeDatabase({ action: 'axiom.update', ...(payload || {}) });
    return result?.doc || result;
  },

  async deleteAxiom(payload) {
    const result = await writeDatabase({ action: 'axiom.delete', ...(payload || {}) });
    return result?.doc || result;
  },

  async moveAxiom(payload) {
    const result = await writeDatabase({ action: 'axiom.move', ...(payload || {}) });
    return result?.doc || result;
  }
};
