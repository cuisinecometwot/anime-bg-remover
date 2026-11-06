// Turns the model's square mask back into an alpha channel at any output size.

// mask: Float32Array size*size in [0, 1]; plan: from planLetterbox.
// Returns Uint8ClampedArray outW*outH, bilinear-sampled from the image's part of the mask.
export function maskToAlpha(mask, plan, outW, outH) {
  const { size, w, h, x: ox, y: oy } = plan;
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
    const r0 = (oy + Math.floor(y)) * size;
    const r1 = (oy + Math.min(Math.floor(y) + 1, h - 1)) * size;
    const fy = y - Math.floor(y);
    const row = j * outW;
    for (let i = 0; i < outW; i++) {
      const top = mask[r0 + x0[i]] * (1 - fx[i]) + mask[r0 + x1[i]] * fx[i];
      const bot = mask[r1 + x0[i]] * (1 - fx[i]) + mask[r1 + x1[i]] * fx[i];
      alpha[row + i] = (top * (1 - fy) + bot * fy) * 255;
    }
  }
  return alpha;
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
