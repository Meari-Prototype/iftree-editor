export const CAMERA_MIN_SCALE = 0.000001;
export const CAMERA_MAX_SCALE = 24;
export const CAMERA_MAX_WHEEL_DELTA = 240;
const DEFAULT_FIT_PADDING = 80;

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeViewport(viewport) {
  return {
    width: Math.max(1, finiteOr(viewport?.width ?? viewport?.w, 1)),
    height: Math.max(1, finiteOr(viewport?.height ?? viewport?.h, 1))
  };
}

export function clampScale(scale, minScale = CAMERA_MIN_SCALE, maxScale = CAMERA_MAX_SCALE) {
  return Math.min(maxScale, Math.max(minScale, finiteOr(scale, 1)));
}

export function boundsFromNodes(nodes, padding = DEFAULT_FIT_PADDING) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const x = finiteOr(node.x, 0);
    const y = finiteOr(node.y, 0);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + finiteOr(node.width, 0));
    maxY = Math.max(maxY, y + finiteOr(node.height, 0));
  }
  const pad = Math.max(0, finiteOr(padding, DEFAULT_FIT_PADDING));

  return {
    x: minX - pad,
    y: minY - pad,
    width: Math.max(1, maxX - minX + pad * 2),
    height: Math.max(1, maxY - minY + pad * 2)
  };
}

export function cameraViewBox(camera, viewport) {
  const size = normalizeViewport(viewport);
  const scale = clampScale(camera?.scale);

  return {
    x: finiteOr(camera?.x, 0),
    y: finiteOr(camera?.y, 0),
    width: size.width / scale,
    height: size.height / scale
  };
}

export function fitCameraToBounds(bounds, viewport, options = {}) {
  const size = normalizeViewport(viewport);
  if (!bounds) return { x: 0, y: 0, scale: 1 };

  const fitRatio = finiteOr(options.fitRatio, 0.92);
  const boundsWidth = Math.max(1, finiteOr(bounds.width, 1));
  const boundsHeight = Math.max(1, finiteOr(bounds.height, 1));
  const scale = clampScale(
    Math.min(size.width / boundsWidth, size.height / boundsHeight) * fitRatio,
    options.minScale ?? CAMERA_MIN_SCALE,
    options.maxScale ?? CAMERA_MAX_SCALE
  );
  const centerX = finiteOr(bounds.x, 0) + boundsWidth / 2;
  const centerY = finiteOr(bounds.y, 0) + boundsHeight / 2;

  return {
    x: centerX - size.width / (2 * scale),
    y: centerY - size.height / (2 * scale),
    scale
  };
}

export function screenToWorld(camera, viewport, point) {
  const scale = clampScale(camera?.scale);

  return {
    x: finiteOr(camera?.x, 0) + finiteOr(point?.x, 0) / scale,
    y: finiteOr(camera?.y, 0) + finiteOr(point?.y, 0) / scale
  };
}

export function zoomCamera(camera, viewport, point, deltaY, options = {}) {
  const size = normalizeViewport(viewport);
  const currentScale = clampScale(camera?.scale, options.minScale ?? CAMERA_MIN_SCALE, options.maxScale ?? CAMERA_MAX_SCALE);
  const sensitivity = finiteOr(options.sensitivity, 0.0018);
  const maxDelta = Math.max(1, finiteOr(options.maxDelta, CAMERA_MAX_WHEEL_DELTA));
  const clampedDelta = Math.min(maxDelta, Math.max(-maxDelta, finiteOr(deltaY, 0)));
  const nextScale = clampScale(
    currentScale * Math.exp(-clampedDelta * sensitivity),
    options.minScale ?? CAMERA_MIN_SCALE,
    options.maxScale ?? CAMERA_MAX_SCALE
  );
  const cursor = {
    x: Math.min(size.width, Math.max(0, finiteOr(point?.x, size.width / 2))),
    y: Math.min(size.height, Math.max(0, finiteOr(point?.y, size.height / 2)))
  };
  const world = screenToWorld({ ...camera, scale: currentScale }, size, cursor);

  return {
    x: world.x - cursor.x / nextScale,
    y: world.y - cursor.y / nextScale,
    scale: nextScale
  };
}

export function panCamera(camera, start, point) {
  if (!start?.camera || !start?.point) return camera;

  const startScale = clampScale(start.camera.scale);
  const dx = finiteOr(point?.x, start.point.x) - finiteOr(start.point.x, 0);
  const dy = finiteOr(point?.y, start.point.y) - finiteOr(start.point.y, 0);

  return {
    ...camera,
    x: finiteOr(start.camera.x, 0) - dx / startScale,
    y: finiteOr(start.camera.y, 0) - dy / startScale,
    scale: finiteOr(camera?.scale, startScale)
  };
}
