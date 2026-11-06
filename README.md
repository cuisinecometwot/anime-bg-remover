# Free Anime Background Remover

Remove the background from anime, manga and illustration images in your browser. Get a transparent PNG or swap in a solid color or another image. Nothing is uploaded: the AI model runs on your GPU (WebGPU) or CPU.

Live: https://cuisinecometwot.github.io/anime-bg-remover/

## Develop

```sh
npm run vendor   # fetch ONNX Runtime Web + coi-serviceworker into vendor/
npm run serve    # http://localhost:8000
npm test         # domain unit tests
```

The fp16 model is committed. To regenerate it from the original fp32 file:

```sh
uv run --with onnx --with onnxconverter-common --with onnxruntime --with pillow scripts/convert_fp16.py
```

## Credits

Segmentation model: [skytnt/anime-segmentation](https://github.com/SkyTNT/anime-segmentation) (ISNet, `isnetis`), Apache-2.0. Inference: [ONNX Runtime Web](https://onnxruntime.ai/).
