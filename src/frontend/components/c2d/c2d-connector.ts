// c2d-connector.ts
// 归属线 SVG 图层的命令式同步（需求 9-2-6）。
// 连接线层完全在 React 之外维护：path 池按需增删、逐条写 d 与
// data-edge-*（e2e 视觉探针读这些属性），不触发任何 React 渲染。

import type { ConnectorMeasure } from './c2d-types.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function syncConnectorLayer(svg: SVGSVGElement | null, conn: ConnectorMeasure) {
  if (!svg) return;
  svg.setAttribute('width', String(conn.w));
  svg.setAttribute('height', String(conn.h));
  svg.setAttribute('viewBox', `0 0 ${conn.w} ${conn.h}`);
  while (svg.children.length > conn.lines.length) {
    svg.removeChild(svg.lastElementChild!);
  }
  while (svg.children.length < conn.lines.length) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'c2d-connector-line');
    svg.appendChild(path);
  }
  for (let i = 0; i < conn.lines.length; i++) {
    const line = conn.lines[i];
    const path = svg.children[i] as SVGPathElement;
    path.setAttribute('d', line.d);
    path.setAttribute('data-edge-left', String(line.bounds?.left ?? 0));
    path.setAttribute('data-edge-top', String(line.bounds?.top ?? 0));
    path.setAttribute('data-edge-width', String(line.bounds?.width ?? 0));
    path.setAttribute('data-edge-height', String(line.bounds?.height ?? 0));
  }
}
