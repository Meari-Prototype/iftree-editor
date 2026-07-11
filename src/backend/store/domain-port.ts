// L2 只声明所需能力；领域实现由上层装配，禁止在 store 内反向 import L3。

import type Database from 'better-sqlite3';
import type { NodeRow } from '../db/schema.js';
import type {
  EditBranchEntry,
  ProjectionBase,
  ProjectedDoc
} from './edit-branch-contract.js';

export type DomainRow = Record<string, unknown>;

export interface DomainStoreCapability {
  db: Database | null;
}

export interface DiffStatsPort extends DomainRow {
  added: number;
  deleted: number;
  modified: number;
  totalRows: number;
  visibleRows: number;
}

export interface DiffResultPort {
  rows: DomainRow[];
  stats: DiffStatsPort;
}

export interface AxiomDiffResultPort {
  rows: DomainRow[];
  stats: DomainRow & { added: number; deleted: number; modified: number };
}

export interface ConflictRowPort extends DomainRow {
  id?: unknown;
  field?: string;
  ours?: unknown;
  theirs?: unknown;
  base?: unknown;
}

export interface ConflictPickPort extends DomainRow {
  id?: unknown;
  field?: string;
  pick?: 'ours' | 'theirs' | 'fill' | string;
  value?: unknown;
}

export interface ConflictResolutionRequest {
  entries?: EditBranchEntry[];
  conflicts?: ConflictRowPort[];
  resolutions?: ConflictPickPort[];
}

export interface ConflictResolutionPort {
  entries: EditBranchEntry[];
  errors: DomainRow[];
}

export interface ApplyExternalEntryContext {
  resolveEntityId(ref: unknown): string | null;
  resolveNodeId(ref: unknown): string | null;
  entityIdByTmp: Map<string, string>;
  baseDocId: string | null;
}

export interface StoreLifecyclePort {
  afterStoreInit(store: DomainStoreCapability): void;
}

export interface DocumentPolicyPort {
  beforeDeleteDoc(store: DomainStoreCapability, docId: unknown): void;
  beforeStreamPush(store: DomainStoreCapability, docId: unknown, nodes: unknown): void;
}

export interface EditBranchProjectionPort {
  activeEditBranchEntries(entries: unknown): EditBranchEntry[];
  undoneEditBranchEntries(entries: unknown): EditBranchEntry[];
  isSupportedEditBranchEntryKind(kind: unknown): boolean;
  isTmpId(value: unknown): value is string;
  nextTmpId(kind?: unknown): string;
  projectEditBranchDoc(base: ProjectionBase, entries?: EditBranchEntry[]): ProjectedDoc;
  resolveConflictEntries(payload: ConflictResolutionRequest): ConflictResolutionPort;
  buildEditBranchDiffRows(base: DomainRow[], projected: DomainRow[], hashes?: unknown): DiffResultPort;
  buildAxiomDiffRows(base: DomainRow[], projected: DomainRow[]): AxiomDiffResultPort;
  nodeRowWithClientAliases(row: NodeRow | null | undefined): DomainRow | null | undefined;
}

export interface ExternalEntryPort {
  resolveExternalEntryDocId(store: DomainStoreCapability, payload: DomainRow): string | null;
  applyExternalEntry(store: DomainStoreCapability, entry: EditBranchEntry, context: ApplyExternalEntryContext): boolean;
}

export interface StoreDomainPorts {
  lifecycle?: StoreLifecyclePort;
  documentPolicy?: DocumentPolicyPort;
  editBranch?: EditBranchProjectionPort;
  externalEntries?: ExternalEntryPort;
}
