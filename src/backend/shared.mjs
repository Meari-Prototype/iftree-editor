export function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = value ? JSON.parse(value) : fallback;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function compareNodeAddress(a, b) {
  const aParts = String(a?.address || '').split('-').filter(Boolean).map(Number);
  const bParts = String(b?.address || '').split('-').filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) return diff;
  }
  return (Number(a?.id) || 0) - (Number(b?.id) || 0);
}
