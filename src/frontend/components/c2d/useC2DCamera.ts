// useC2DCamera.ts
// C2D 列视图镜头状态机：定位意图（pendingLocate）、热点记录（9-2-9，含 localStorage 持久化）、
// 列自动居中、axiom 列开启居中、surface 横向滚动记忆，统一收敛于此。
//
// 原实现把这些散在 MindMapView 的六个标志 ref 与四个 layoutEffect 里、靠 flag 互相躲避
// （skipNextColumnAutoCenter 等）；本 hook 保持完全相同的判定与执行时序，只是给了它们
// 一个边界：外部只能经 requestLocate / setHotspot / getHotspot / noteSurfaceScroll 表达意图。
//
// layoutEffect 声明顺序刻意与原组件一致（播种 → axiom 列 → 定位消费 → 列变化居中），
// 且本 hook 的调用点须在组件其余 layoutEffect（测量、渲染就绪）之前——顺序即行为。

import { useLayoutEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { clampCenterScrollTop } from './c2d-measure.js';
import { ancestorAddresses } from './c2d-depth-logic.js';
import { readC2dLastAddress, writeC2dLastAddress } from './c2d-persistence.js';
import type { C2DColumn } from './c2d-types';

export interface C2DCameraOptions {
  docId: string | number | null;
  /** 本轮渲染的展开集：播种 effect 经本轮闭包读取（docId 变化那一轮 ref 还是旧文档的集合）。 */
  expanded: Set<string>;
  displayColumns: C2DColumn[];
  showAxiomColumn: boolean;
  surfaceRef: RefObject<HTMLDivElement | null>;
  colEls: RefObject<Map<number, HTMLElement>>;
  cards: RefObject<Map<string, HTMLElement>>;
  scheduleMeasure(): void;
  /** 换文档播种：当前展开集为空且热点祖先链非空时上抛（组件写 expandedRef 并上抛 onExpandedChange）。 */
  onSeedExpanded(restored: Set<string>): void;
  /** 换文档时组件侧非镜头重置（colWidths 清空、readyFired 复位）。 */
  onDocumentReset(): void;
}

export interface C2DCameraApi {
  /** 声明下一次布局完成后要定位居中的地址；null 清除意图。 */
  requestLocate(address: string | null): void;
  /** 更新热点记录并持久化（9-2-9 最后点击地址）。 */
  setHotspot(address: string): void;
  getHotspot(): string | null;
  /** surface 横向滚动时记忆位置，列变化后无新列时恢复。 */
  noteSurfaceScroll(): void;
}

export function useC2DCamera({
  docId, expanded, displayColumns, showAxiomColumn,
  surfaceRef, colEls, cards,
  scheduleMeasure, onSeedExpanded, onDocumentReset
}: C2DCameraOptions): C2DCameraApi {
  const pendingLocate = useRef<string | null>(null);
  const lastHotspot = useRef<string | null>(null);
  const savedScrollX = useRef(0);
  const prevColCount = useRef(0);
  const skipNextColumnAutoCenter = useRef(false);
  const previousShowAxiomColumn = useRef<boolean | null>(null);

  // ── 换文档播种：热点祖先链恢复 + 镜头/组件侧标志复位 ──
  useLayoutEffect(() => {
    const restored = new Set<string>();
    let hotspot: string | null = null;
    lastHotspot.current = null;
    const last = readC2dLastAddress(docId);
    if (last) {
      hotspot = last;
      lastHotspot.current = last;
      for (const ancestor of ancestorAddresses(last)) restored.add(ancestor);
    }
    // 受控后 session view 是真相：集合已有内容（同文档 remount，如设置屏往返）不播种，
    // 保留用户即时展开态；空集（新开文档）才用 localStorage hotspot 祖先链播种。
    if (expanded.size === 0 && restored.size > 0) {
      pendingLocate.current = hotspot;
      onSeedExpanded(restored);
    } else {
      pendingLocate.current = expanded.size === 0 ? hotspot : null;
    }
    prevColCount.current = 0;
    previousShowAxiomColumn.current = null;
    onDocumentReset();
  }, [docId]); // deps 刻意只有 docId：仅换文档/重挂载时播种一次，其余经本轮闭包读取

  // ── axiom 列开启时居中事实前提列 ──────────
  useLayoutEffect(() => {
    const prev = previousShowAxiomColumn.current;
    if (prev === null) {
      previousShowAxiomColumn.current = showAxiomColumn;
      return;
    }
    if (prev !== showAxiomColumn) {
      if (showAxiomColumn) {
        const axiomCol = colEls.current?.get(0);
        const blocks = displayColumns[0]?.groups.flatMap(g => g.blocks) || [];
        const first = blocks.length ? cards.current?.get(blocks[0].address) : null;
        const last = blocks.length ? cards.current?.get(blocks[blocks.length - 1].address) : null;
        if (axiomCol && first && last) {
          const center = (first.offsetTop + last.offsetTop + last.offsetHeight) / 2;
          const max = Math.max(0, axiomCol.scrollHeight - axiomCol.clientHeight);
          axiomCol.scrollTop = clampCenterScrollTop(center - axiomCol.clientHeight / 2, first.offsetTop, max);
        }
      }
      previousShowAxiomColumn.current = showAxiomColumn;
      scheduleMeasure();
    }
  }, [showAxiomColumn, displayColumns, scheduleMeasure]);

  // ── 定位意图消费：目标卡片列内居中 + 横向入画，随后跳过一次列自动居中 ──
  useLayoutEffect(() => {
    const addr = pendingLocate.current;
    if (!addr) return;
    const el = cards.current?.get(addr);
    if (!el) return;
    pendingLocate.current = null;
    skipNextColumnAutoCenter.current = true;
    for (let i = 0; i < displayColumns.length; i++) {
      const blocks = displayColumns[i].groups.flatMap(g => g.blocks);
      if (!blocks.find(b => b.address === addr)) continue;
      const colEl = colEls.current?.get(i);
      if (!colEl) break;
      const target = el.offsetTop + el.offsetHeight / 2 - colEl.clientHeight / 2;
      const max = Math.max(0, colEl.scrollHeight - colEl.clientHeight);
      colEl.scrollTo({ top: clampCenterScrollTop(target, el.offsetTop, max), behavior: 'smooth' });
      const surface = surfaceRef.current;
      if (surface) {
        const colRect = colEl.getBoundingClientRect();
        const surfaceRect = surface.getBoundingClientRect();
        if (colRect.right > surfaceRect.right || colRect.left < surfaceRect.left) {
          surface.scrollTo({
            left: Math.max(0, colEl.offsetLeft - surfaceRect.width / 2 + colRect.width / 2),
            behavior: 'smooth'
          });
        }
      }
      break;
    }
    scheduleMeasure();
  }, [displayColumns, scheduleMeasure]);

  // ── 列变化后：新列居中、横向滚动/恢复 ──────
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!displayColumns.length) {
      prevColCount.current = 0;
      skipNextColumnAutoCenter.current = false;
      return;
    }
    if (skipNextColumnAutoCenter.current) {
      skipNextColumnAutoCenter.current = false;
      prevColCount.current = displayColumns.length;
      return;
    }
    const prev = prevColCount.current;
    prevColCount.current = displayColumns.length;

    const startFrom = prev === 0 ? 0 : prev;
    for (let i = startFrom; i < displayColumns.length; i++) {
      const el = colEls.current?.get(i);
      if (!el) continue;
      const blocks = displayColumns[i].groups.flatMap(g => g.blocks);
      if (!blocks.length) continue;
      const first = cards.current?.get(blocks[0].address);
      const last = cards.current?.get(blocks[blocks.length - 1].address);
      if (!first || !last) continue;
      const c = (first.offsetTop + last.offsetTop + last.offsetHeight) / 2;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = clampCenterScrollTop(c - el.clientHeight / 2, first.offsetTop, max);
    }

    if (surface) {
      if (displayColumns.length > prev && prev > 0) {
        const lastEl = colEls.current?.get(displayColumns.length - 1);
        if (lastEl) {
          const r = lastEl.getBoundingClientRect();
          const sr = surface.getBoundingClientRect();
          if (r.right > sr.right) {
            surface.scrollBy({ left: r.right - sr.right + 20, behavior: 'smooth' });
          }
        }
      } else if (savedScrollX.current > 0) {
        surface.scrollLeft = savedScrollX.current;
      }
    }
  }, [displayColumns]);

  // api 对象身份随 docId 稳定：方法只碰内部 ref（setHotspot 闭包 docId 做持久化键）。
  return useMemo<C2DCameraApi>(() => ({
    requestLocate(address) {
      pendingLocate.current = address;
    },
    setHotspot(address) {
      lastHotspot.current = address;
      writeC2dLastAddress(docId, address);
    },
    getHotspot() {
      return lastHotspot.current;
    },
    noteSurfaceScroll() {
      if (surfaceRef.current) savedScrollX.current = surfaceRef.current.scrollLeft;
    }
  }), [docId]);
}
