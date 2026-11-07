import * as ort from "./vendor/ort.webgpu.min.mjs";
import { compositeOver, coverRect, parseHex } from "./domain/composite.js";
import { MODEL_SIZE, planLetterbox, rgbaToChw } from "./domain/letterbox.js";
import { applyAlpha, maskToAlpha, resizeMask } from "./domain/mask.js";
import { encodePng } from "./domain/png.js";
import { createEditor } from "./editor.js";

// The model is split into ~21 MB parts: GitHub Pages deploys stalled on the single 84 MiB file.
const MODEL_MANIFEST = new URL("./models/isnetis-fp16.json", import.meta.url).href;
// Bump when the model file changes so the Cache Storage copy is replaced.
const MODEL_CACHE = "anime-bg-model-v1";
// Cache Storage key for the joined model bytes.
const MODEL_KEY = new URL("./models/isnetis-fp16.onnx", import.meta.url).href;
// Full-size download keeps ~5 RGBA-sized buffers alive at once.
const MAX_INPUT_PIXELS = 40e6;
// Preview and manual edits use this resolution; the download upsamples the edited mask.
const PREVIEW_MAX_EDGE = 1600;

ort.env.wasm.wasmPaths = new URL("./vendor/", import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(navigator.hardwareConcurrency || 4, 8)
  : 1;
ort.env.webgpu.powerPreference = "high-performance";

const $ = (id) => document.getElementById(id);
const ui = {
  env: $("env-list"),
  drop: $("drop"),
  dropText: $("drop-text"),
  file: $("file"),
  bg: $("bg"),
  bgColor: $("bg-color"),
  bgFile: $("bg-file"),
  format: $("format"),
  backend: $("backend"),
  progress: $("progress"),
  status: $("status"),
  resultCard: $("result-card"),
  download: $("download"),
  compare: $("compare"),
  preview: $("preview"),
};

const editor = createEditor({
  stage: $("stage"),
  zoom: $("zoom"),
  canvas: $("preview"),
  cursor: $("cursor"),
  fit: $("fit"),
  toolButtons: [...document.querySelectorAll("#toolbar .tool")],
  modeButtons: [...document.querySelectorAll("#toolbar .mode")],
  size: $("brush-size"),
  sizeWrap: $("size-wrap"),
  tol: $("wand-tol"),
  tolWrap: $("tol-wrap"),
  undo: $("undo"),
  redo: $("redo"),
  reset: $("reset"),
  overlay: $("overlay"),
});

const state = {
  env: {},
  modelBytes: null,
  sessions: new Map(),
  busy: false,
  // Current image: decoded bitmap, letterbox plan and the model's mask.
  image: null,
  bgImage: null,
};

// ---------- environment ----------

async function detectEnv() {
  const env = { webgpu: false, gpu: "-", f16: false };
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter) {
        const info = adapter.info || {};
        env.webgpu = true;
        env.gpu =
          [info.vendor, info.architecture, info.device, info.description]
            .filter(Boolean)
            .join(" / ") || "unknown";
        env.f16 = adapter.features.has("shader-f16");
      }
    } catch (e) {
      env.gpu = `adapter error: ${e.message}`;
    }
  }
  env.isolated = self.crossOriginIsolated;
  env.threads = ort.env.wasm.numThreads;
  state.env = env;

  const row = (k, v, cls = "") => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;
  ui.env.innerHTML =
    row(
      "WebGPU",
      env.webgpu ? "available" : "not available — CPU only (slower)",
      env.webgpu ? "good" : "bad",
    ) +
    row("GPU", env.gpu) +
    row("shader-f16", env.f16 ? "yes" : "no") +
    row("CPU threads", `${env.threads}${env.isolated ? "" : " (not cross-origin isolated)"}`) +
    row("Browser", navigator.userAgent);
  if (!env.webgpu) ui.backend.value = "wasm";
}

// ---------- model ----------

// The model is 88 MB: keep it in Cache Storage so later visits skip the download.
async function fetchModel(onProgress) {
  if (state.modelBytes) return state.modelBytes;
  const cache = self.caches ? await caches.open(MODEL_CACHE).catch(() => null) : null;
  const cached = cache && (await cache.match(MODEL_KEY));
  if (cached) {
    state.modelBytes = new Uint8Array(await cached.arrayBuffer());
    return state.modelBytes;
  }
  const manifest = await (await fetch(MODEL_MANIFEST)).json();
  const bytes = new Uint8Array(manifest.size);
  let got = 0;
  for (const part of manifest.parts) {
    const res = await fetch(new URL(part, MODEL_MANIFEST));
    if (!res.ok) throw new Error(`model download failed (HTTP ${res.status})`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes.set(value, got);
      got += value.length;
      onProgress(
        got / manifest.size,
        `Downloading AI model (first time only)… ${(got / 1e6).toFixed(0)} / ${(manifest.size / 1e6).toFixed(0)} MB`,
      );
    }
  }
  if (got !== manifest.size) throw new Error("model download incomplete");
  if (cache) await cache.put(MODEL_KEY, new Response(bytes)).catch(() => {});
  state.modelBytes = bytes;
  return bytes;
}

async function getSession(backend, onProgress) {
  if (!state.sessions.has(backend)) {
    const bytes = await fetchModel(onProgress);
    onProgress(1, "Preparing AI model…");
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
    });
    state.sessions.set(backend, session);
  }
  return state.sessions.get(backend);
}

// ---------- pixels ----------

function readPixels(source, w, h, sx = 0, sy = 0, sw = source.width, sh = source.height) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

function modelInput(bitmap, plan) {
  const canvas = new OffscreenCanvas(plan.size, plan.size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, plan.size, plan.size);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, plan.x, plan.y, plan.w, plan.h);
  const rgba = ctx.getImageData(0, 0, plan.size, plan.size).data;
  return new ort.Tensor("float32", rgbaToChw(rgba, plan.size), [1, 3, plan.size, plan.size]);
}

function fitSize(w, h, maxEdge) {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// Background as either a colour or an RGBA buffer the size of the output; null = transparent.
function background(w, h) {
  const mode = bgMode();
  if (mode === "white") return [255, 255, 255];
  if (mode === "color") return parseHex(ui.bgColor.value);
  if (mode === "image" && state.bgImage) {
    const b = state.bgImage;
    const r = coverRect(b.width, b.height, w, h);
    return readPixels(b, w, h, r.sx, r.sy, r.sw, r.sh);
  }
  return null;
}

function bgMode() {
  return ui.bg.querySelector("input[name=bg]:checked").value;
}

// ---------- preview ----------

function loadEditor() {
  const { bitmap, mask, plan } = state.image;
  const { w, h } = fitSize(bitmap.width, bitmap.height, PREVIEW_MAX_EDGE);
  editor.load(readPixels(bitmap, w, h), maskToAlpha(mask, plan, w, h), w, h);
  refreshBackground();
}

function refreshBackground() {
  const { w, h } = editor.size;
  if (w) editor.setBackground(background(w, h));
}

// ---------- pipeline ----------

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

function isImage(file) {
  // Some OS/browser combos give dropped files an empty type.
  return file.type ? file.type.startsWith("image/") : IMAGE_EXT.test(file.name);
}

function setProgress(p, msg) {
  ui.progress.hidden = false;
  ui.progress.value = p;
  ui.status.textContent = msg;
}

async function removeBackground(file) {
  if (!file || state.busy) return;
  if (!isImage(file)) {
    ui.status.textContent = `Not an image: ${file.name || file.type}`;
    return;
  }
  state.busy = true;
  ui.dropText.textContent = `${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
  try {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > MAX_INPUT_PIXELS) {
      bitmap.close();
      throw new Error(
        `Image too large (${bitmap.width}x${bitmap.height}). The limit is about 40 megapixels.`,
      );
    }
    const plan = planLetterbox(bitmap.width, bitmap.height, MODEL_SIZE);
    let backend = ui.backend.value;
    let session;
    try {
      session = await getSession(backend, setProgress);
    } catch (e) {
      if (backend !== "webgpu") throw e;
      // Some GPUs/drivers can't run the model; the CPU always can, just slower.
      console.warn("WebGPU failed, falling back to CPU", e);
      backend = ui.backend.value = "wasm";
      session = await getSession(backend, setProgress);
    }

    setProgress(1, `Removing background (${backend === "webgpu" ? "GPU" : "CPU"})…`);
    const t0 = performance.now();
    const input = modelInput(bitmap, plan);
    const out = await session.run({ img: input });
    const mask = new Float32Array(out.mask.data);
    input.dispose();
    out.mask.dispose();
    const secs = (performance.now() - t0) / 1000;

    state.image?.bitmap.close();
    state.image = { bitmap, plan, mask, name: file.name.replace(/\.[^.]+$/, "") || "image" };
    ui.resultCard.hidden = false;
    loadEditor();
    ui.status.textContent = `Done in ${secs.toFixed(1)}s. Fix any mistakes with Brush or Magic wand, then download.`;
  } catch (e) {
    console.error(e);
    ui.status.textContent = `Error: ${e.message}`;
  } finally {
    state.busy = false;
    ui.progress.hidden = true;
  }
}

async function download() {
  const img = state.image;
  if (!img || state.busy) return;
  state.busy = true;
  ui.download.disabled = true;
  ui.status.textContent = "Preparing full-size image…";
  try {
    const { bitmap } = img;
    const W = bitmap.width;
    const H = bitmap.height;
    const { w, h } = editor.size;
    const alpha = resizeMask(editor.mask, w, { x: 0, y: 0, w, h }, W, H);
    let cutout = applyAlpha(readPixels(bitmap, W, H), alpha);
    const bg = background(W, H);
    if (bg) cutout = compositeOver(cutout, bg);
    const jpg = bg && ui.format.value === "image/jpeg";
    const blob = jpg
      ? await encodeJpeg(cutout, W, H)
      : await encodePng(cutout, W, H, { alpha: !bg });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${img.name}_nobg.${jpg ? "jpg" : "png"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    ui.status.textContent = `Saved ${a.download} (${(blob.size / 1e6).toFixed(1)} MB).`;
  } catch (e) {
    console.error(e);
    ui.status.textContent = `Error: ${e.message}`;
  } finally {
    state.busy = false;
    ui.download.disabled = false;
  }
}

async function encodeJpeg(rgba, w, h) {
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

// ---------- input events ----------

// An image dragged from another tab usually arrives as HTML/URL, not as a file.
// Must run synchronously in the drop handler: dataTransfer is emptied afterwards.
function droppedUrl(dt) {
  const uriList = dt
    .getData("text/uri-list")
    .split(/\r?\n/)
    .find((l) => l && !l.startsWith("#"));
  // Prefer the <img> itself: for a linked image the uri-list is the link target.
  const html = dt.getData("text/html");
  const src = html && new DOMParser().parseFromString(html, "text/html").querySelector("img[src]");
  if (src) return new URL(src.getAttribute("src"), uriList || location.href).href;
  if (uriList) return uriList;
  const text = dt.getData("text/plain").trim();
  return /^(https?:|data:image\/)/.test(text) ? text : null;
}

async function fileFromUrl(url) {
  let blob;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch {
    // Almost always CORS: the other site doesn't let pages read its images.
    throw new Error(
      "That site doesn't allow reading the image from here. Copy the image and paste it (Ctrl+V), or save it and drop the file.",
    );
  }
  const name = url.startsWith("data:")
    ? "image"
    : decodeURIComponent(new URL(url).pathname.split("/").pop() || "image");
  return new File([blob], name, { type: blob.type });
}

ui.file.addEventListener("change", () => removeBackground(ui.file.files[0]));
for (const ev of ["dragenter", "dragover"]) {
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    ui.drop.classList.add("over");
  });
}
for (const ev of ["dragleave", "drop"]) {
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    ui.drop.classList.remove("over");
  });
}
document.addEventListener("drop", async (e) => {
  const file = e.dataTransfer.files[0];
  if (file) return removeBackground(file);
  const url = droppedUrl(e.dataTransfer);
  if (!url) return;
  ui.status.textContent = "Fetching dropped image…";
  try {
    removeBackground(await fileFromUrl(url));
  } catch (err) {
    ui.status.textContent = err.message;
  }
});
document.addEventListener("paste", (e) => {
  const file = [...e.clipboardData.files].find(isImage);
  if (file) removeBackground(file);
});

// ---------- background + result controls ----------

function syncFormat() {
  // A transparent result is always PNG; JPG has no alpha.
  ui.format.disabled = bgMode() === "none";
  if (ui.format.disabled) ui.format.value = "image/png";
}

ui.bg.addEventListener("change", (e) => {
  if (e.target === ui.bgFile) return;
  if (bgMode() === "image" && !state.bgImage) ui.bgFile.click();
  syncFormat();
  refreshBackground();
});
ui.bgColor.addEventListener("input", () => {
  ui.bg.querySelector("input[value=color]").checked = true;
  syncFormat();
  refreshBackground();
});
ui.bgFile.addEventListener("change", async () => {
  const f = ui.bgFile.files[0];
  if (!f) return;
  try {
    state.bgImage?.close();
    state.bgImage = await createImageBitmap(f);
    ui.bg.querySelector("input[value=image]").checked = true;
    syncFormat();
    refreshBackground();
  } catch {
    ui.status.textContent = `Can't read background image: ${f.name}`;
  }
});

ui.download.addEventListener("click", download);
for (const [ev, show] of [
  ["pointerdown", true],
  ["pointerup", false],
  ["pointerleave", false],
  ["pointercancel", false],
]) {
  ui.compare.addEventListener(ev, () => editor.showOriginal(show));
}
ui.compare.addEventListener("keydown", (e) => e.key === " " && editor.showOriginal(true));
ui.compare.addEventListener("keyup", (e) => e.key === " " && editor.showOriginal(false));

syncFormat();
detectEnv();
