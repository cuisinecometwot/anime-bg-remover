# anime-bg-remover

Free online background remover for anime/illustration images that runs entirely in the browser (no upload), hosted on GitHub Pages. Goal: validate the tool as a sibling of the image-upscaler web page.

## Product
- User: anyone who needs anime art cut-outs (stickers, edits, thumbnails). Non-commercial, English, international.
- One-off utility, no accounts. Core flow is 3 steps: drop/paste image → automatic cutout → download.
- v1: transparent PNG cutout + replace background with white, a picked color, or an uploaded image (cover fit).
- Images stay on the device. Main target desktop Chrome/Edge (WebGPU); wasm CPU fallback for other browsers/phones.
- Same look as the image-upscaler page; the two sites link to each other.
- SEO like the upscaler: keyword title/description, canonical, OG image, JSON-LD WebApplication, how-to + FAQ, sitemap listed in the root robots.txt of the cuisinecometwot.github.io repo.

## Stack & architecture
- Static site at the repo root, vanilla ES modules, no build step. ONNX Runtime Web (WebGPU build, also does wasm) + coi-serviceworker, fetched into gitignored `vendor/` by `scripts/fetch-vendor.sh`.
- Model: skytnt `anime-seg` `isnetis.onnx` (ISNet, Apache-2.0), converted to fp16 weights with fp32 I/O by `scripts/convert_fp16.py` and committed (`models/isnetis-fp16.onnx`, ~88 MB). Input 1×3×1024×1024 RGB/255 letterboxed; output 1×1×1024×1024 mask.
- `domain/` (pure JS, `node --test`): letterbox planning, mask resize/apply, background compositing, streaming PNG encoder (copied from image-upscaler).
- The model runs once per image; background changes only re-composite.

## Progress
- Next: build v1 (see plan), deploy to Pages.
