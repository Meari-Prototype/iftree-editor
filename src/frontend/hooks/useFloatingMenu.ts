// @ts-nocheck
import { useEffect, useRef, useState } from 'react';

// 单一浮层菜单 hook —— 按钮触发 + portal 菜单的通用骨架。
// 收掉原 WorkspaceHeader ×3 (summary/view/diff) 与 DocBrowser ×1 (doc) 的复制：
//   - 菜单定位算法（getBoundingClientRect + 视口夹紧 + 上下翻转）
//   - pointerdown 外部 + Escape + resize 关闭三件套 effect
//   - state / ref / toggle 骨架
// 同一 hook 实例只允许一个菜单开（openId 互斥），点其它 trigger 自然关旧开新。
//
// trigger button 由 toggle() 在事件回调里把 event.currentTarget 写进 controlRef，
// 调用方无需提供 wrapper ref。DocBrowser 原来用 `click + stopPropagation`（无 ref）——
// 升级为 pointerdown 等价且更早关闭。
//
// specs: (id) => { className, width, height } | null
//   className 用于 outside.closest 双判；id 是任意字符串（WorkspaceHeader 用
//   'summary'/'view'/'diff'，DocBrowser 用各 menuKey）。
//
// 不适用：CSS 锚点定位（AgentPanel ×3、common.tsx ×1，无 JS 位置计算）；
//         鼠标坐标 + 挂载夹紧（MindMapView 右键/拖拽菜单）——定位机制不同。

function computeMenuPosition(button, width, height, offset) {
  const rect = button.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || width;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || height;
  const left = Math.max(8, Math.min(rect.right - width, viewportWidth - width - 8));
  const below = rect.bottom + offset;
  const above = rect.top - height - offset;
  const top = below + height <= viewportHeight - 8 ? below : Math.max(8, above);
  return { left, top, width };
}

export function useFloatingMenu({
  specs,
  offset = 6
}: { specs?: any, offset?: number } = {}) {
  const [openId, setOpenId] = useState(null);
  const [position, setPosition] = useState(null);
  const controlRef = useRef(null);
  // specs 一般是每次渲染新函数引用；用 ref 让 effect 不订阅它，只挂在 openId 上。
  const specsRef = useRef(specs);
  specsRef.current = specs;
  const lookup = (id) => specsRef.current?.(id) || {};

  function toggle(id, event) {
    event.stopPropagation();
    setOpenId((current) => {
      if (current === id) return null;
      const spec = lookup(id);
      controlRef.current = event.currentTarget;
      setPosition(computeMenuPosition(event.currentTarget, spec.width, spec.height, offset));
      return id;
    });
  }

  function close() {
    setOpenId(null);
    setPosition(null);
  }

  useEffect(() => {
    if (!openId) return undefined;
    const menuClassName = lookup(openId).className;
    const closeOnPointerDown = (event) => {
      if (controlRef.current?.contains(event.target)) return;
      if (menuClassName && event.target?.closest?.(`.${menuClassName}`)) return;
      close();
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', close);
    };
  }, [openId]);

  return { openId, position, controlRef, toggle, close };
}