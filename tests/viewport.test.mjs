import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAMERA_MAX_SCALE,
  boundsFromNodes,
  cameraViewBox,
  fitCameraToBounds,
  panCamera,
  screenToWorld,
  zoomCamera
} from '../src/core/viewport.mjs';

test('zoomCamera keeps the world point under the cursor fixed', () => {
  const viewport = { width: 800, height: 600 };
  const cursor = { x: 320, y: 180 };
  const camera = { x: 100, y: 200, scale: 1 };
  const before = screenToWorld(camera, viewport, cursor);

  const zoomed = zoomCamera(camera, viewport, cursor, -240);
  const after = screenToWorld(zoomed, viewport, cursor);

  assert.ok(zoomed.scale > camera.scale);
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('zoomCamera allows close inspection instead of capping at the old 3x limit', () => {
  const viewport = { width: 800, height: 600 };
  const camera = { x: 0, y: 0, scale: 3 };

  let zoomed = camera;
  for (let i = 0; i < 24; i += 1) {
    zoomed = zoomCamera(zoomed, viewport, { x: 400, y: 300 }, -240);
  }

  assert.equal(zoomed.scale, CAMERA_MAX_SCALE);
  assert.ok(zoomed.scale > 3);
});

test('zoomCamera limits a single extreme wheel delta to avoid scale jumps', () => {
  const viewport = { width: 800, height: 600 };
  const camera = { x: 0, y: 0, scale: 1 };

  const zoomed = zoomCamera(camera, viewport, { x: 400, y: 300 }, -10000);

  assert.ok(zoomed.scale < 2, `single wheel event should not jump to ${zoomed.scale}`);
});

test('panCamera converts screen movement through the drag-start scale', () => {
  const camera = { x: 50, y: -20, scale: 8 };
  const start = { point: { x: 100, y: 100 }, camera };

  const moved = panCamera(camera, start, { x: 220, y: 40 });

  assert.equal(moved.x, 35);
  assert.equal(moved.y, -12.5);
  assert.equal(moved.scale, camera.scale);
});

test('fitCameraToBounds uses viewport size as the camera basis for tall maps', () => {
  const viewport = { width: 800, height: 600 };
  const bounds = { x: 10, y: -50, width: 400, height: 12000 };

  const camera = fitCameraToBounds(bounds, viewport);
  const visible = cameraViewBox(camera, viewport);

  assert.ok(camera.scale > 0);
  assert.ok(visible.height >= bounds.height);
  assert.equal(camera.x + visible.width / 2, bounds.x + bounds.width / 2);
  assert.equal(camera.y + visible.height / 2, bounds.y + bounds.height / 2);
});

test('boundsFromNodes includes node extents and padding', () => {
  const bounds = boundsFromNodes([
    { x: 10, y: 20, width: 100, height: 50 },
    { x: 200, y: 300, width: 80, height: 40 }
  ], 20);

  assert.deepEqual(bounds, { x: -10, y: 0, width: 310, height: 360 });
});
