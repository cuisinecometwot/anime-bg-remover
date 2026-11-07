// Manual mask touch-up: brush strokes, magic-wand selections and undo history.
// Masks are Uint8ClampedArray w*h, 255 = keep, 0 = remove. Edit functions return the
// dirty rect {x, y, w, h} (or null) so the caller only redraws what changed.

function rectUnion(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

// One round brush dab with a 1px soft edge. Pixels move toward `value` by coverage, so
// overlapping dabs along a stroke never undo each other.
export function paintDab(mask, w, h, cx, cy, radius, value) {
  const r = Math.max(radius, 0.5);
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
  const y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
  if (x0 > x1 || y0 > y1) return null;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cover = Math.min(1, Math.max(0, r + 0.5 - d));
      if (cover <= 0) continue;
      const i = y * w + x;
      mask[i] = mask[i] + (value - mask[i]) * cover;
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Dabs spaced a quarter radius apart from (x0, y0) to (x1, y1).
export function paintStroke(mask, w, h, x0, y0, x1, y1, radius, value) {
  const step = Math.max(radius / 4, 0.5);
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
  let dirty = null;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    dirty = rectUnion(
      dirty,
      paintDab(mask, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, value),
    );
  }
  return dirty;
}

// Connected pixels (4-neighbour) whose RGB is within `tolerance` (0..255, Euclidean/√3)
// of the clicked pixel. Returns Uint8Array w*h with 1 = selected.
export function magicWand(rgba, w, h, x, y, tolerance) {
  const sel = new Uint8Array(w * h);
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return sel;
  const s = (y * w + x) * 4;
  const [r, g, b] = [rgba[s], rgba[s + 1], rgba[s + 2]];
  const limit = tolerance * tolerance * 3;
  const match = (i) => {
    const p = i * 4;
    const dr = rgba[p] - r;
    const dg = rgba[p + 1] - g;
    const db = rgba[p + 2] - b;
    return dr * dr + dg * dg + db * db <= limit;
  };
  // Scanline fill: fill a whole row span, then queue the rows above and below.
  const stack = [x, y];
  while (stack.length) {
    const sy = stack.pop();
    let sx = stack.pop();
    const row = sy * w;
    if (sel[row + sx] || !match(row + sx)) continue;
    let lx = sx;
    while (lx > 0 && !sel[row + lx - 1] && match(row + lx - 1)) lx--;
    let rx = sx;
    while (rx < w - 1 && !sel[row + rx + 1] && match(row + rx + 1)) rx++;
    for (let i = lx; i <= rx; i++) sel[row + i] = 1;
    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let i = lx; i <= rx; i++) {
        const ok = !sel[nrow + i] && match(nrow + i);
        if (ok && !inRun) stack.push(i, ny);
        inRun = ok;
      }
    }
  }
  return sel;
}

// Grows a selection by r pixels (square), so anti-aliased outline pixels are included.
export function dilate(sel, w, h, r) {
  if (r <= 0) return sel;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!sel[y * w + x]) continue;
      for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) tmp[y * w + i] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!tmp[y * w + x]) continue;
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) out[j * w + x] = 1;
    }
  }
  return out;
}

export function applySelection(mask, sel, w, value) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < sel.length; i++) {
    if (!sel[i]) continue;
    mask[i] = value;
    const x = i % w;
    const y = (i - x) / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Snapshot undo/redo for one mask. push() before each edit.
export class History {
  constructor(limit = 20) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }
  push(mask) {
    this.undoStack.push(mask.slice());
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  // Drops the last push without restoring (e.g. an edit that changed nothing).
  discard() {
    this.undoStack.pop();
  }
  // Restores the last push and forgets it (an edit cancelled midway, e.g. by a pinch).
  revert(mask) {
    if (this.canUndo) mask.set(this.undoStack.pop());
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  undo(mask) {
    if (!this.canUndo) return false;
    this.redoStack.push(mask.slice());
    mask.set(this.undoStack.pop());
    return true;
  }
  redo(mask) {
    if (!this.canRedo) return false;
    this.undoStack.push(mask.slice());
    mask.set(this.redoStack.pop());
    return true;
  }
}
