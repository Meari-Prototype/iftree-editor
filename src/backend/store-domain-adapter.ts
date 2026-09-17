// L3 → L2 装配点：领域实现集中在这里注入 store 声明的窄端口。

import {
  activeEditBranchEntries,
  isSupportedEditBranchEntryKind,
  isTmpId,
  nextTmpId,
  patchNodeRow,
  projectEditBranchDoc,
  resolveConflictEntries,
  undoneEditBranchEntries
} from './projection/edit-branch-projection.js';
import { buildEditBranchDiffRows, buildAxiomDiffRows, nodeRowWithClientAliases } from './diff/diff-view.js';
import {
  resolveEntityEntryDocId,
  tryApplyEntityEntry
} from './entities/write.js';
import {
  assertMemoryVolumeDeleteAllowed,
  assertMemoryVolumeEditModeAllowed,
  validateMemoryVolumeStreamPush
} from './memory/volumes.js';
import { ensureLibraryNavigationDoc } from './library/virtual-docs.js';
import type { DomainStoreCapability, StoreDomainPorts } from './store/domain-port.js';
import { IftreeStore } from './store/index.js';

function initializedStore(store: DomainStoreCapability) {
  if (!store.db) throw new Error('Store domain port called before database initialization');
  return { db: store.db };
}

export function createStoreDomainPorts(): StoreDomainPorts {
  return {
    lifecycle: {
      afterStoreInit: (store) => ensureLibraryNavigationDoc(initializedStore(store))
    },
    documentPolicy: {
      beforeDeleteDoc: (store, docId) => assertMemoryVolumeDeleteAllowed(initializedStore(store), docId),
      beforeStreamPush: (store, docId, nodes) => validateMemoryVolumeStreamPush(initializedStore(store), docId, nodes),
      beforeSetEditMode: (store, docId, nextMode) => assertMemoryVolumeEditModeAllowed(initializedStore(store), docId, nextMode)
    },
    editBranch: {
      activeEditBranchEntries,
      undoneEditBranchEntries,
      isSupportedEditBranchEntryKind,
      isTmpId,
      nextTmpId,
      projectEditBranchDoc,
      resolveConflictEntries,
      buildEditBranchDiffRows,
      buildAxiomDiffRows,
      nodeRowWithClientAliases,
      patchProjectedNode: (row, patch) => patchNodeRow(row as never, patch)
    },
    externalEntries: {
      resolveExternalEntryDocId: (store, payload) => resolveEntityEntryDocId(store, payload),
      applyExternalEntry: (store, entry, context) => tryApplyEntityEntry(store, entry, context)
    }
  };
}

export function createConfiguredIftreeStore(dbPath: string) {
  return new IftreeStore(dbPath, createStoreDomainPorts());
}
