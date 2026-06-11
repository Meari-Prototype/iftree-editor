// 字符级文本 diff：diff 对比视图的片段级高亮用（删除片段红遮罩、新增片段绿遮罩）。
// 公共前后缀先裁剪，核心走 Myers O(ND)；编辑距离超过 maxEditDistance 时退化为
// 整段 del+ins（视觉等价于整块红/绿），保证大段重写不卡 UI。纯函数、无依赖。

function mergeSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.type === segment.type) last.text += segment.text;
    else merged.push({ type: segment.type, text: segment.text });
  }
  return merged;
}

// Myers 1986 前向算法，逐字符编辑脚本；超过 maxD 返回 null 交调用方退化。
function myersOps(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return [{ type: 'ins', text: b }];
  if (!m) return [{ type: 'del', text: a }];
  const limit = Math.min(maxD, n + m);
  const offset = limit;
  const v = new Int32Array(2 * limit + 1);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d += 1) {
    trace.push(Int32Array.from(v));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  // 回溯：从 (n, m) 沿 trace 逐层回到原点，逆序收集逐字符操作。
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d];
    const k = x - y;
    const fromInsert = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const prevK = fromInsert ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', text: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (fromInsert) {
      ops.push({ type: 'ins', text: b[y - 1] });
      y -= 1;
    } else {
      ops.push({ type: 'del', text: a[x - 1] });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', text: a[x - 1] });
    x -= 1;
    y -= 1;
  }
  ops.reverse();
  return ops;
}

/**
 * @returns {Array<{type: 'equal'|'del'|'ins', text: string}>}
 *   按原文顺序的片段列表：equal 双侧都有，del 只属旧文本，ins 只属新文本。
 */
export function diffTextSegments(before, after, { maxEditDistance = 600 } = {}) {
  const a = String(before ?? '');
  const b = String(after ?? '');
  if (a === b) return a ? [{ type: 'equal', text: a }] : [];

  let start = 0;
  const minLength = Math.min(a.length, b.length);
  while (start < minLength && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const coreA = a.slice(start, endA);
  const coreB = b.slice(start, endB);
  const core = myersOps(coreA, coreB, Math.max(1, maxEditDistance)) ?? [
    { type: 'del', text: coreA },
    { type: 'ins', text: coreB }
  ];
  return mergeSegments([
    { type: 'equal', text: a.slice(0, start) },
    ...core,
    { type: 'equal', text: a.slice(endA) }
  ]);
}
