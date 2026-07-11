// E2E 启动验收的截图分析与缩放取样（自 electron/main.ts 拆出，架构 §6-8）：
// 像素级探针（暗色遮罩 / 文本墨水 / 贝塞尔连线）判断主界面是否真实渲染完成。
// 纯分析 + 窗口输入事件，不碰设置与启动流程；只被 main 的 E2E IPC handler 消费。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow, NativeImage } from 'electron';

import { clampNumber } from '../src/backend/llm/defaults.js';

type RowObject = Record<string, unknown>;

export type RectLike = {
  x: number;
  y: number;
  width: number;
  height: number;
  imageHeight?: number;
};

export type CaptureAnalysis = RowObject & {
  ok: boolean;
  width: number;
  height: number;
  hasDarkLoadingOverlay: boolean;
  overlayDarkPixels: number;
  overlaySamplePixels: number;
  mainCanvasDarkPixels: number;
  textProbeRectCount: number;
  textDarkPixels: number;
  textRectsWithDark: number;
  textInkPixels: number;
  textRectsWithInk: number;
  hasReadableTextPixels: boolean;
  edgeProbeRectCount: number;
  edgeColorPixels: number;
  edgeRectsWithColor: number;
  hasBezierCurvePixels: boolean;
  fontShot?: RowObject;
};

export function countDarkPixels(bitmap: Uint8Array, width: number, rect: RectLike, step = 1) {
  const left = Math.floor(clampNumber(rect.x, 0, width, 0));
  const top = Math.floor(clampNumber(rect.y, 0, rect.imageHeight || 0, 0));
  const right = Math.ceil(clampNumber(rect.x + rect.width, 0, width, 0));
  const bottom = Math.ceil(clampNumber(rect.y + rect.height, 0, rect.imageHeight || 0, 0));
  let dark = 0;
  let total = 0;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const offset = (y * width + x) * 4;
      const b = bitmap[offset];
      const g = bitmap[offset + 1];
      const r = bitmap[offset + 2];
      const a = bitmap[offset + 3];
      if (a > 180 && r < 120 && g < 120 && b < 120) dark += 1;
      total += 1;
    }
  }
  return { dark, total, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function countTextInkPixels(bitmap: Uint8Array, width: number, rect: RectLike, step = 1) {
  const left = Math.floor(clampNumber(rect.x, 0, width, 0));
  const top = Math.floor(clampNumber(rect.y, 0, rect.imageHeight || 0, 0));
  const right = Math.ceil(clampNumber(rect.x + rect.width, 0, width, 0));
  const bottom = Math.ceil(clampNumber(rect.y + rect.height, 0, rect.imageHeight || 0, 0));
  let ink = 0;
  let total = 0;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const offset = (y * width + x) * 4;
      const b = bitmap[offset];
      const g = bitmap[offset + 1];
      const r = bitmap[offset + 2];
      const a = bitmap[offset + 3];
      if (a > 180 && r < 225 && g < 225 && b < 225 && (r + g + b) < 650) ink += 1;
      total += 1;
    }
  }
  return { ink, total, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function countBezierPixels(bitmap: Uint8Array, width: number, rect: RectLike, step = 1) {
  const left = Math.floor(clampNumber(rect.x, 0, width, 0));
  const top = Math.floor(clampNumber(rect.y, 0, rect.imageHeight || 0, 0));
  const right = Math.ceil(clampNumber(rect.x + rect.width, 0, width, 0));
  const bottom = Math.ceil(clampNumber(rect.y + rect.height, 0, rect.imageHeight || 0, 0));
  let edge = 0;
  let total = 0;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const offset = (y * width + x) * 4;
      const b = bitmap[offset];
      const g = bitmap[offset + 1];
      const r = bitmap[offset + 2];
      const a = bitmap[offset + 3];
      const treeEdge = a > 160 && r >= 160 && r <= 245 && g >= 155 && g <= 240 && b >= 145 && b <= 235;
      const flowEdge = a > 160 && r >= 70 && r <= 120 && g >= 95 && g <= 140 && b >= 80 && b <= 125;
      if (treeEdge || flowEdge) edge += 1;
      total += 1;
    }
  }
  return { edge, total, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function analyzeE2ECapture(image: NativeImage, textProbeRects: unknown[] = [], edgeProbeRects: unknown[] = [], contentSize: Partial<RectLike> = {}): CaptureAnalysis {
  const size = image.getSize();
  const width = Math.max(1, Number(size.width) || 1);
  const height = Math.max(1, Number(size.height) || 1);
  const bitmap = image.toBitmap();
  const overlayRegion = {
    x: Math.floor(width * 0.12),
    y: 0,
    width: Math.floor(width * 0.76),
    height: Math.min(height, Math.max(120, Math.floor(height * 0.22))),
    imageHeight: height
  };
  const overlay = countDarkPixels(bitmap, width, overlayRegion, 2);
  const hasDarkLoadingOverlay = overlay.dark > 1200 && overlay.dark / Math.max(1, overlay.total) > 0.035;
  const scaleX = width / Math.max(1, Number(contentSize.width) || width);
  const scaleY = height / Math.max(1, Number(contentSize.height) || height);
  const mainCanvasRegion = {
    x: Math.floor(width * 0.22),
    y: Math.floor(height * 0.16),
    width: Math.floor(width * 0.56),
    height: Math.floor(height * 0.76),
    imageHeight: height
  };
  const mainCanvasText = countDarkPixels(bitmap, width, mainCanvasRegion, 1);
  let textProbeRectCount = 0;
  let textDarkPixels = 0;
  let textRectsWithDark = 0;
  let textInkPixels = 0;
  let textRectsWithInk = 0;
  for (const rect of Array.isArray(textProbeRects) ? textProbeRects.slice(0, 30) as Array<Partial<RectLike>> : []) {
    const probe = {
      x: Number(rect?.x || 0) * scaleX,
      y: Number(rect?.y || 0) * scaleY,
      width: Number(rect?.width || 0) * scaleX,
      height: Number(rect?.height || 0) * scaleY,
      imageHeight: height
    };
    if (probe.width < 8 || probe.height < 6) continue;
    const sample = countTextInkPixels(bitmap, width, probe, 1);
    if (sample.width < 8 || sample.height < 6) continue;
    textProbeRectCount += 1;
    textInkPixels += sample.ink;
    textDarkPixels += sample.ink;
    if (sample.ink >= 5) {
      textRectsWithInk += 1;
      textRectsWithDark += 1;
    }
  }
  let edgeProbeRectCount = 0;
  let edgeColorPixels = 0;
  let edgeRectsWithColor = 0;
  for (const rect of Array.isArray(edgeProbeRects) ? edgeProbeRects.slice(0, 30) as Array<Partial<RectLike>> : []) {
    const probe = {
      x: Number(rect?.x || 0) * scaleX,
      y: Number(rect?.y || 0) * scaleY,
      width: Number(rect?.width || 0) * scaleX,
      height: Number(rect?.height || 0) * scaleY,
      imageHeight: height
    };
    if (probe.width < 12 || probe.height < 6) continue;
    const sample = countBezierPixels(bitmap, width, probe, 1);
    if (sample.width < 12 || sample.height < 6) continue;
    edgeProbeRectCount += 1;
    edgeColorPixels += sample.edge;
    if (sample.edge >= 6) edgeRectsWithColor += 1;
  }
  const hasReadableTextPixels = (
    textProbeRectCount >= 2 &&
    textInkPixels >= Math.max(10, textProbeRectCount * 4) &&
    textRectsWithInk >= 1
  ) || mainCanvasText.dark >= 180;
  const hasBezierCurvePixels = edgeProbeRectCount > 0 &&
    edgeColorPixels >= Math.max(12, edgeProbeRectCount * 4) &&
    edgeRectsWithColor >= 1;
  return {
    ok: !hasDarkLoadingOverlay && hasReadableTextPixels && hasBezierCurvePixels,
    width,
    height,
    hasDarkLoadingOverlay,
    overlayDarkPixels: overlay.dark,
    overlaySamplePixels: overlay.total,
    mainCanvasDarkPixels: mainCanvasText.dark,
    textProbeRectCount,
    textDarkPixels,
    textRectsWithDark,
    textInkPixels,
    textRectsWithInk,
    hasReadableTextPixels,
    edgeProbeRectCount,
    edgeColorPixels,
    edgeRectsWithColor,
    hasBezierCurvePixels
  };
}

export async function captureZoomedE2EWindow(win: BrowserWindow) {
  const target = process.env.IFTREE_E2E_FONT_SCREENSHOT_PATH;
  if (!target) return null;
  const steps = Math.max(1, Number(process.env.IFTREE_E2E_FONT_ZOOM_STEPS) || 5);
  const configuredDelta = Number(process.env.IFTREE_E2E_FONT_ZOOM_DELTA);
  const deltaY = Number.isFinite(configuredDelta) && configuredDelta !== 0 ? configuredDelta : 720;
  const contentBounds = win.getContentBounds();
  const x = Math.floor(Math.max(1, contentBounds.width) * 0.5);
  const y = Math.floor(Math.max(1, contentBounds.height) * 0.5);
  for (let index = 0; index < steps; index += 1) {
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
      wheelTicksX: 0,
      wheelTicksY: deltaY > 0 ? 1 : -1
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  const dragX = Math.floor(Math.max(1, contentBounds.width) * 0.36);
  const dragY = Math.floor(Math.max(1, contentBounds.height) * 0.5);
  const dragDx = 96;
  const dragDy = 18;
  win.webContents.sendInputEvent({ type: 'mouseDown', x: dragX, y: dragY, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: dragX + dragDx,
    y: dragY + dragDy,
    button: 'left',
    movementX: dragDx,
    movementY: dragDy
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: dragX + dragDx,
    y: dragY + dragDy,
    button: 'left',
    clickCount: 1
  });
  await new Promise((resolve) => setTimeout(resolve, 240));
  const image = await win.webContents.capturePage();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, image.toPNG());
  return {
    path: target,
    zoomSteps: steps,
    deltaY
  };
}
