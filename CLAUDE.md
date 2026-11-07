# anime-bg-remover

Free online background remover for anime/illustration images that runs entirely in the browser (no upload), hosted on GitHub Pages. Goal: validate the tool as a sibling of the image-upscaler web page.

## Product
- User: anyone who needs anime art cut-outs (stickers, edits, thumbnails). Non-commercial, English, international.
- One-off utility, no accounts. Core flow is 3 steps: drop/paste image → automatic cutout → download.
- v1: transparent PNG cutout + replace background with white, a picked color, or an uploaded image (cover fit).
- v1.1: manual touch-up — Keep/Remove brush, magic wand (one click selects a connected similar-color area), undo/redo, reset to AI; works with mouse and touch (pinch zoom, pan). AI click-to-segment (SAM) deferred unless the wand isn't enough.
- Images stay on the device. Main target desktop Chrome/Edge (WebGPU); wasm CPU fallback for other browsers/phones.
- Same look as the image-upscaler page; the two sites link to each other.
- SEO like the upscaler: keyword title/description, canonical, OG image, JSON-LD WebApplication, how-to + FAQ, sitemap listed in the root robots.txt of the cuisinecometwot.github.io repo.

## Stack & architecture
- Deploy: `.github/workflows/pages.yml` copies only site files into `_site` (no scripts/tests/docs).
- Static site at the repo root, vanilla ES modules, no build step. ONNX Runtime Web (WebGPU build, also does wasm) + coi-serviceworker, fetched into gitignored `vendor/` by `scripts/fetch-vendor.sh`.
- Model: skytnt `anime-seg` `isnetis.onnx` (ISNet, Apache-2.0), converted to fp16 weights with fp32 I/O by `scripts/convert_fp16.py` and committed as 4 × 21 MB parts + `models/isnetis-fp16.json` manifest (88 MB total), joined in JS. The single 84 MiB file made GitHub Pages deploys hang at `syncing_files`. Input 1×3×1024×1024 RGB/255 letterboxed; output 1×1×1024×1024 mask.
- `domain/` (pure JS, `node --test`): letterbox planning, mask resize/apply, background compositing, streaming PNG encoder (copied from image-upscaler).
- The model runs once per image; background changes only re-composite.
- Editor (`editor.js`): the editable mask is a Uint8 mask at preview resolution (≤1600px), initialized from the AI mask; the download upsamples it (`resizeMask`) and multiplies with the original alpha. Pure logic in `domain/edit.js` (brush dabs/strokes, scanline-fill wand + dilate, snapshot `History`) and `renderPreview` (dirty-rect redraw, red overlay view).

## Progress
- Done: v1 page — transparent PNG + white/color/image background, PNG/JPG download, hold-to-compare, model cached in Cache Storage, WebGPU→CPU fallback.
- Measured headless Chromium 131 on HD 620, 2456x1736: GPU 2.7s, CPU (wasm) 19.4s; second visit skips the model download. fp16 vs fp32 mask max diff 2.2/255.
- Done: SEO (Lighthouse SEO/a11y/best-practices 100), sitemap in root robots.txt, cross-links from the upscaler FAQ and the profile homepage.
- Done: live at https://cuisinecometwot.github.io/anime-bg-remover/ (verified end to end in headless Chromium). First deploys hung in `syncing_files` (GitHub-side); deploy-pages timeout raised to 30 min.
- Done: manual fix tools (`feature/edit-tools`) — verified headless (desktop wand/brush/undo/redo/reset/zoom, touch stroke + pinch).
- Next: test on Windows/Android Chrome; submit sitemap in Google Search Console.
- Ideas: edge refine/threshold slider, batch + zip, chain with the upscaler.
