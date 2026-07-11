// c2d-persistence.ts
// C2D 视图热点（需求 9-2-9 最后点击地址）的 localStorage 持久化。
// 只保存一个最后点击地址、不保存完整展开集合、不写入主文档数据库（条文原文约束）。

function hotspotKey(docId: string | number) {
  return `c2d:last:${docId}`;
}

export function readC2dLastAddress(docId: string | number | null | undefined): string | null {
  if (!docId) return null;
  try {
    return localStorage.getItem(hotspotKey(docId));
  } catch {
    return null;
  }
}

export function writeC2dLastAddress(docId: string | number | null | undefined, address: string) {
  if (!docId || !address) return;
  try {
    localStorage.setItem(hotspotKey(docId), address);
  } catch {}
}
