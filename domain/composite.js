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
