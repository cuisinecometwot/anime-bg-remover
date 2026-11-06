// The model takes a fixed square input. The image is scaled so its long edge fits, then
// centred on a black square; the mask comes back in the same square, so the same plan
// tells us which part of the mask belongs to the image.

export const MODEL_SIZE = 1024;

export function planLetterbox(width, height, size = MODEL_SIZE) {
  if (!(width > 0 && height > 0)) throw new Error(`bad image size ${width}x${height}`);
  const scale = size / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { size, w, h, x: Math.floor((size - w) / 2), y: Math.floor((size - h) / 2) };
}

// Square RGBA pixels (already letterboxed) -> CHW float32 RGB in [0, 1].
export function rgbaToChw(rgba, size) {
  const plane = size * size;
  if (rgba.length !== plane * 4) throw new Error("rgba length does not match size");
  const out = new Float32Array(plane * 3);
  for (let i = 0, s = 0; i < plane; i++, s += 4) {
    out[i] = rgba[s] / 255;
    out[plane + i] = rgba[s + 1] / 255;
    out[2 * plane + i] = rgba[s + 2] / 255;
  }
  return out;
}
