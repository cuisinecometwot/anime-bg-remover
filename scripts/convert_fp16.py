"""Make the web model: skytnt anime-seg isnetis.onnx -> fp16 weights, fp32 input/output.

Run:
  uv run --with onnx --with onnxconverter-common --with onnxruntime --with pillow \
      scripts/convert_fp16.py [--check IMAGE ...]

--check runs both models on the given images (CPU) and prints the mask difference.
"""

import argparse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "scripts" / ".cache"
SRC_URL = "https://huggingface.co/skytnt/anime-seg/resolve/main/isnetis.onnx"
SRC = CACHE / "isnetis.onnx"
DST = ROOT / "models" / "isnetis-fp16.onnx"
SIZE = 1024


def download():
    if SRC.exists():
        return
    CACHE.mkdir(parents=True, exist_ok=True)
    print(f"downloading {SRC_URL}")
    tmp = SRC.with_suffix(".part")
    urllib.request.urlretrieve(SRC_URL, tmp)
    tmp.rename(SRC)


def convert():
    import onnx
    from onnxconverter_common import float16

    model = onnx.load(SRC)
    # fp32 I/O keeps the JS side identical for fp16 and fp32 models.
    half = float16.convert_float_to_float16(model, keep_io_types=True)
    DST.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(half, DST)
    print(f"wrote {DST} ({DST.stat().st_size / 1e6:.1f} MB)")
    for t in half.graph.input:
        print("input ", t.name, [d.dim_value or d.dim_param for d in t.type.tensor_type.shape.dim])
    for t in half.graph.output:
        print("output", t.name, [d.dim_value or d.dim_param for d in t.type.tensor_type.shape.dim])


def letterbox(path):
    """Same preprocessing as domain/letterbox.js: fit long edge to 1024, centre-pad with 0."""
    import numpy as np
    from PIL import Image

    img = Image.open(path).convert("RGB")
    w, h = img.size
    scale = SIZE / max(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    canvas = np.zeros((SIZE, SIZE, 3), np.float32)
    x, y = (SIZE - nw) // 2, (SIZE - nh) // 2
    canvas[y : y + nh, x : x + nw] = np.asarray(img.resize((nw, nh), Image.BILINEAR)) / 255
    return canvas.transpose(2, 0, 1)[None]


def check(images):
    import numpy as np
    import onnxruntime as ort

    sessions = [ort.InferenceSession(p, providers=["CPUExecutionProvider"]) for p in (SRC, DST)]
    name = sessions[0].get_inputs()[0].name
    for path in images:
        x = letterbox(path)
        a, b = (s.run(None, {name: x})[0] for s in sessions)
        diff = np.abs(a - b)
        print(
            f"{Path(path).name[:40]:40} max {diff.max() * 255:.1f}/255  mean {diff.mean() * 255:.3f}/255"
            f"  fg {(a > 0.5).mean():.1%}"
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", nargs="*", default=[], metavar="IMAGE")
    args = ap.parse_args()
    download()
    if not DST.exists():
        convert()
    if args.check:
        check(args.check)


if __name__ == "__main__":
    main()
