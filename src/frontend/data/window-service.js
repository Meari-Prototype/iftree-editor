import { callIftree, closeWindow, minimizeWindow, toggleMaximizeWindow } from './iftree-api.js';

export function openEntityMaintenanceWindow(payload = {}) {
  return callIftree('openEntityMaintenanceWindow', payload);
}

export { closeWindow, minimizeWindow, toggleMaximizeWindow };
