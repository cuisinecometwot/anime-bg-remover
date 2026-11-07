// Resamples masks to any output size and applies them as alpha.

// Bilinear resize of the crop {x, y, w, h} of a mask whose rows are `stride` values apart.
// `scale` maps source values to 0..255 (255 for the model's [0, 1] floats, 1 for bytes).
export function resizeMask(src, stride, crop, outW, outH, scale = 1) {
  const { x: ox, y: oy, w, h } = crop;
  const alpha = new Uint8ClampedArray(outW * outH);
  const sx = w / outW;
  const sy = h / outH;
  // Precompute horizontal taps once; they are the same for every row.
  const x0 = new Int32Array(outW);
  const x1 = new Int32Array(outW);
  const fx = new Float32Array(outW);
  for (let i = 0; i < outW; i++) {
    const x = Math.min(Math.max((i + 0.5) * sx - 0.5, 0), w - 1);
    x0[i] = ox + Math.floor(x);
    x1[i] = ox + Math.min(Math.floor(x) + 1, w - 1);
    fx[i] = x - Math.floor(x);
  }
  for (let j = 0; j < outH; j++) {
    const y = Math.min(Math.max((j + 0.5) * sy - 0.5, 0), h - 1);
    const r0 = (oy + Math.floor(y)) * stride;
    const r1 = (oy + Math.min(Math.floor(y) + 1, h - 1)) * stride;
    const fy = y - Math.floor(y);
    const row = j * outW;
    for (let i = 0; i < outW; i++) {
      const top = src[r0 + x0[i]] * (1 - fx[i]) + src[r0 + x1[i]] * fx[i];
      const bot = src[r1 + x0[i]] * (1 - fx[i]) + src[r1 + x1[i]] * fx[i];
      alpha[row + i] = (top * (1 - fy) + bot * fy) * scale;
    }
  }
  return alpha;
}

// mask: the model's Float32Array size*size in [0, 1]; plan: from planLetterbox.
// Returns 0..255 alpha for the image's part of the mask at outW×outH.
export function maskToAlpha(mask, plan, outW, outH) {
  return resizeMask(mask, plan.size, plan, outW, outH, 255);
}

// New RGBA with alpha = original alpha × mask, so already-transparent areas stay transparent.
export function applyAlpha(rgba, alpha) {
  if (rgba.length !== alpha.length * 4) throw new Error("rgba and alpha sizes differ");
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < alpha.length; i++) {
    out[i * 4 + 3] = (rgba[i * 4 + 3] * alpha[i]) / 255;
  }
  return out;
}
