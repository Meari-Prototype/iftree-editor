const ID_COLUMNS = [
  'ids',
  'parentIds'
] as const;

const INT_COLUMNS = [
  'sortOrders',
  'depths',
  'childCounts',
  'firstChildSlot',
  'nextSibSlot'
] as const;

const FLOAT_COLUMNS = [
  'x',
  'y',
  'width',
  'height',
  'cardHeight'
] as const;

interface FlatTreeRow {
  id?: unknown;
  parent_id?: unknown;
  parentId?: unknown;
  sort_order?: unknown;
  sortOrder?: unknown;
  depth?: unknown;
  child_count?: unknown;
  childCount?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  cardHeight?: unknown;
  card_height?: unknown;
  address?: unknown;
  doc_id?: unknown;
  docId?: unknown;
  [key: string]: unknown;
}

interface FlatTreeSlotRow {
  id: string | null;
  doc_id: string | null;
  parent_id: string | null;
  sort_order: number;
  depth: number;
  address: string;
  child_count: number;
  width: number | null;
  height: number | null;
  cardHeight: number;
}

function hasOwn(source: object | null, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

function numberValue(source: FlatTreeRow, keys: string[], fallback = 0): number {
  for (const key of keys) {
    if (!hasOwn(source, key)) continue;
    const value = Number(source[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function intValue(source: FlatTreeRow, keys: string[], fallback = 0): number {
  return Math.trunc(numberValue(source, keys, fallback));
}

function parentIdValue(row: FlatTreeRow): string | null {
  const value = row.parent_id ?? row.parentId;
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function compareSlots(tree: FlatTree, left: number, right: number): number {
  const order = tree.sortOrders[left] - tree.sortOrders[right];
  if (order !== 0) return order;
  return String(tree.ids[left] || '').localeCompare(String(tree.ids[right] || ''));
}

function copyArrayColumn(oldColumn: (string | null)[], nextCapacity: number, fillValue: string | null = null): (string | null)[] {
  const next: (string | null)[] = new Array(nextCapacity).fill(fillValue);
  for (let index = 0; index < Math.min(oldColumn.length, nextCapacity); index += 1) {
    next[index] = oldColumn[index];
  }
  return next;
}

function copyTypedColumn<T extends Int32Array | Float64Array>(
  ColumnType: { new(length: number): T },
  oldColumn: T,
  nextCapacity: number,
  fillValue: number | null = null
): T {
  const next = new ColumnType(nextCapacity);
  next.set(oldColumn.subarray(0, Math.min(oldColumn.length, nextCapacity)));
  if (fillValue !== null && nextCapacity > oldColumn.length) {
    next.fill(fillValue, oldColumn.length);
  }
  return next;
}

export class FlatTree {
  capacity: number;
  length: number;
  ids: (string | null)[];
  parentIds: (string | null)[];
  sortOrders: Int32Array;
  depths: Int32Array;
  childCounts: Int32Array;
  firstChildSlot: Int32Array;
  nextSibSlot: Int32Array;
  x: Float64Array;
  y: Float64Array;
  width: Float64Array;
  height: Float64Array;
  cardHeight: Float64Array;
  addresses: string[];
  idToSlot: Map<string, number>;
  rootSlot: number;
  docId: string | null;
  readonly __flatTree: true = true;

  constructor(capacity: number = 0) {
    this.capacity = Math.max(0, Math.floor(Number(capacity) || 0));
    this.length = 0;

    this.ids = new Array(this.capacity).fill(null);
    this.parentIds = new Array(this.capacity).fill(null);
    this.sortOrders = new Int32Array(this.capacity);
    this.depths = new Int32Array(this.capacity);
    this.childCounts = new Int32Array(this.capacity);
    this.firstChildSlot = new Int32Array(this.capacity);
    this.nextSibSlot = new Int32Array(this.capacity);

    this.x = new Float64Array(this.capacity);
    this.y = new Float64Array(this.capacity);
    this.width = new Float64Array(this.capacity);
    this.height = new Float64Array(this.capacity);
    this.cardHeight = new Float64Array(this.capacity);
    this.addresses = new Array(this.capacity).fill('');

    this.firstChildSlot.fill(-1);
    this.nextSibSlot.fill(-1);

    this.idToSlot = new Map();
    this.rootSlot = -1;
    this.docId = null;
    Object.defineProperty(this, '__flatTree', { value: true });
  }

  static fromRows(rows: FlatTreeRow[] = []): FlatTree {
    const list = Array.isArray(rows) ? rows : [];
    const tree = new FlatTree(list.length);
    tree.fillFromRows(list);
    return tree;
  }

  grow(minCapacity: number = this.capacity + 1): number {
    const nextCapacity = Math.max(1, this.capacity * 2, Math.floor(Number(minCapacity) || 0));
    if (nextCapacity <= this.capacity) return this.capacity;

    for (const column of ID_COLUMNS) {
      this[column] = copyArrayColumn(this[column], nextCapacity, null);
    }
    for (const column of INT_COLUMNS) {
      const fillValue = column === 'firstChildSlot' || column === 'nextSibSlot' ? -1 : null;
      this[column] = copyTypedColumn(Int32Array, this[column], nextCapacity, fillValue);
    }
    for (const column of FLOAT_COLUMNS) {
      this[column] = copyTypedColumn(Float64Array, this[column], nextCapacity);
    }
    const nextAddresses = new Array(nextCapacity).fill('');
    for (let index = 0; index < Math.min(this.addresses.length, nextCapacity); index += 1) {
      nextAddresses[index] = this.addresses[index] || '';
    }
    this.addresses = nextAddresses;

    this.capacity = nextCapacity;
    return this.capacity;
  }

  fillFromRows(rows: FlatTreeRow[] = []): this {
    const list = Array.isArray(rows) ? rows.filter((row) => row && row.id !== null && row.id !== undefined) : [];
    if (list.length > this.capacity) this.grow(list.length);

    this.length = list.length;
    this.docId = null;
    this.idToSlot.clear();
    this.ids.fill(null, 0, this.length);
    this.parentIds.fill(null, 0, this.length);
    this.firstChildSlot.fill(-1, 0, this.length);
    this.nextSibSlot.fill(-1, 0, this.length);

    for (let slot = 0; slot < list.length; slot += 1) {
      const row = list[slot];
      const id = String(row.id);
      this.ids[slot] = id;
      this.parentIds[slot] = parentIdValue(row);
      this.sortOrders[slot] = intValue(row, ['sort_order', 'sortOrder'], 0);
      this.depths[slot] = Math.max(1, intValue(row, ['depth'], 1));
      this.childCounts[slot] = Math.max(0, intValue(row, ['child_count', 'childCount'], 0));

      this.x[slot] = numberValue(row, ['x'], 0);
      this.y[slot] = numberValue(row, ['y'], 0);
      this.width[slot] = numberValue(row, ['width'], 0);
      this.height[slot] = numberValue(row, ['height'], 0);
      this.cardHeight[slot] = numberValue(row, ['cardHeight', 'card_height'], 0);
      this.addresses[slot] = String(row.address || '');

      if (this.docId === null && (hasOwn(row, 'doc_id') || hasOwn(row, 'docId'))) {
        this.docId = String(row.doc_id ?? row.docId ?? '');
      }
      this.idToSlot.set(id, slot);
    }

    this.rebuildChildLinks();
    return this;
  }

  rebuildChildLinks(): void {
    this.rootSlot = -1;
    this.firstChildSlot.fill(-1, 0, this.length);
    this.nextSibSlot.fill(-1, 0, this.length);

    const childrenByParent = new Map<string | null, number[]>();
    for (let slot = 0; slot < this.length; slot += 1) {
      const parentId = this.parentIds[slot];
      const key = parentId === null ? null : parentId;
      if (!childrenByParent.has(key)) childrenByParent.set(key, []);
      childrenByParent.get(key)!.push(slot);
    }

    for (const children of childrenByParent.values()) {
      children.sort((left, right) => compareSlots(this, left, right));
      for (let index = 0; index < children.length - 1; index += 1) {
        this.nextSibSlot[children[index]] = children[index + 1];
      }
    }

    for (const [parentId, children] of childrenByParent) {
      if (parentId === null) {
        this.rootSlot = children[0] ?? -1;
        continue;
      }
      const parentSlot = this.idToSlot.get(parentId);
      if (parentSlot === undefined) continue;
      this.firstChildSlot[parentSlot] = children[0] ?? -1;
      this.childCounts[parentSlot] = Math.max(this.childCounts[parentSlot], children.length);
    }
  }

  slotOf(nodeId: unknown): number {
    const id = String(nodeId ?? '').trim();
    return id && this.idToSlot.has(id) ? this.idToSlot.get(id)! : -1;
  }

  slotToId(slot: number): string | null {
    return slot >= 0 && slot < this.length ? this.ids[slot] : null;
  }

  rowAtSlot(slot: number): FlatTreeSlotRow | null {
    if (slot < 0 || slot >= this.length) return null;
    return {
      id: this.ids[slot],
      doc_id: this.docId,
      parent_id: this.parentIds[slot] === null ? null : this.parentIds[slot],
      sort_order: this.sortOrders[slot],
      depth: this.depths[slot],
      address: this.addresses[slot] || '',
      child_count: this.childCounts[slot],
      width: this.width[slot] || null,
      height: this.height[slot] || null,
      cardHeight: this.cardHeight[slot]
    };
  }

  childSlots(slot: number): number[] {
    const result: number[] = [];
    let childSlot = slot < 0 ? this.rootSlot : this.firstChildSlot[slot];
    while (childSlot >= 0 && childSlot < this.length) {
      result.push(childSlot);
      childSlot = this.nextSibSlot[childSlot];
    }
    return result;
  }

  ancestorSlots(slot: number): number[] {
    const result: number[] = [];
    let current = slot;
    while (current >= 0 && current < this.length) {
      result.push(current);
      const parentId = this.parentIds[current];
      if (parentId === null) break;
      current = this.slotOf(parentId);
    }
    return result;
  }

  connectedSubtree(slotSet: Iterable<number> | null | undefined): Set<number> {
    const result = new Set<number>();
    for (const rawSlot of slotSet || []) {
      const slot = Math.trunc(Number(rawSlot));
      if (!Number.isInteger(slot) || slot < 0 || slot >= this.length) continue;
      for (const ancestorSlot of this.ancestorSlots(slot)) {
        result.add(ancestorSlot);
      }
    }
    return result;
  }

  slotsPreOrder(startSlot: number = -1): number[] {
    const roots = startSlot >= 0 ? [startSlot] : this.childSlots(-1);
    const result: number[] = [];
    const stack = roots.slice().reverse();
    while (stack.length > 0) {
      const slot = stack.pop()!;
      if (slot < 0 || slot >= this.length) continue;
      result.push(slot);
      const children = this.childSlots(slot);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]);
      }
    }
    return result;
  }
}

export function isFlatTree(value: unknown): boolean {
  return Boolean(value && (value as FlatTree).__flatTree === true && (value as FlatTree).idToSlot instanceof Map);
}