import { safeDebugLabel } from '../../lib/debug-log.js';

export function debugElementTarget(target: EventTarget | null): Record<string, string> | null {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
  const control = target.closest([
    '[data-debug-label]',
    'button',
    '[role="button"]',
    'a',
    'select',
    'input[type="button"]',
    'input[type="checkbox"]',
    'input[type="radio"]',
    'input[type="range"]',
    'input[type="submit"]',
    'summary'
  ].join(','));
  if (!control) return null;

  const label = control.getAttribute('data-debug-label') ||
    control.getAttribute('aria-label') ||
    control.getAttribute('title') ||
    control.textContent ||
    control.getAttribute('name') ||
    control.id ||
    '';
  const descriptor: Record<string, string> = {
    tag: control.tagName.toLowerCase(),
    id: safeDebugLabel(control.id),
    role: safeDebugLabel(control.getAttribute('role') || ''),
    type: safeDebugLabel(control.getAttribute('type') || ''),
    label: safeDebugLabel(label)
  };
  const value = (control as { value?: unknown }).value;
  if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(value)) descriptor.value = value;
  return descriptor;
}

export function debugShouldLogKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  return ['Escape', 'Enter', 'Delete', 'Backspace'].includes(event.key);
}
