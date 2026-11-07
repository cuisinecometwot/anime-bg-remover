// Places the cut-out over a new background.

// "#rrggbb" -> [r, g, b]
export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`bad colour ${hex}`);
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

// Source crop that fills dstW×dstH without distortion (CSS object-fit: cover), centred.
export function coverRect(srcW, srcH, dstW, dstH) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const sw = Math.min(srcW, dstW / scale);
  const sh = Math.min(srcH, dstH / scale);
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

// fg: RGBA cut-out. bg: RGBA buffer of the same size, or an [r, g, b] colour.
// Returns an opaque RGBA image.
export function compositeOver(fg, bg) {
  const out = new Uint8ClampedArray(fg.length);
  const solid = bg.length !== fg.length;
  for (let i = 0; i < fg.length; i += 4) {
    const a = fg[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      out[i + c] = fg[i + c] * a + (solid ? bg[c] : bg[i + c]) * (1 - a);
    }
    out[i + 3] = 255;
  }
  return out;
}

const OVERLAY = [255, 40, 60];
const OVERLAY_STRENGTH = 0.55;

// Redraws rect {x, y, w, h} of the w-wide preview buffer `out` from the original pixels and
// the 0..255 mask. "result" shows the cut-out (transparent, or over bg colour/buffer);
// "overlay" shows the original with removed areas tinted red, so they can be restored.
export function renderPreview(out, original, mask, w, rect, { view = "result", bg = null } = {}) {
  const solid = bg && bg.length === 3;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = y * w + x;
      const p = i * 4;
      if (view === "overlay") {
        const t = (1 - mask[i] / 255) * OVERLAY_STRENGTH;
        for (let c = 0; c < 3; c++) out[p + c] = original[p + c] * (1 - t) + OVERLAY[c] * t;
        out[p + 3] = 255;
        continue;
      }
      const a = (original[p + 3] * mask[i]) / 255;
      if (!bg) {
        out[p] = original[p];
        out[p + 1] = original[p + 1];
        out[p + 2] = original[p + 2];
        out[p + 3] = a;
        continue;
      }
      const f = a / 255;
      for (let c = 0; c < 3; c++) {
        out[p + c] = original[p + c] * f + (solid ? bg[c] : bg[p + c]) * (1 - f);
      }
      out[p + 3] = 255;
    }
  }
}
