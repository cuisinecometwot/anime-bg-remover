import assert from "node:assert/strict";
import { test } from "node:test";

import { compositeOver, coverRect, parseHex } from "./composite.js";
import { MODEL_SIZE, planLetterbox, rgbaToChw } from "./letterbox.js";
import { applyAlpha, maskToAlpha } from "./mask.js";

test("letterbox fits the long edge and centres the short one", () => {
  assert.deepEqual(planLetterbox(2000, 1000), { size: 1024, w: 1024, h: 512, x: 0, y: 256 });
  assert.deepEqual(planLetterbox(500, 1000), { size: 1024, w: 512, h: 1024, x: 256, y: 0 });
  assert.deepEqual(planLetterbox(300, 300), { size: 1024, w: 1024, h: 1024, x: 0, y: 0 });
  assert.equal(MODEL_SIZE, 1024);
});

test("letterbox never collapses a thin image to zero pixels", () => {
  const p = planLetterbox(10000, 3);
  assert.equal(p.h, 1);
  assert.equal(p.y, 511);
});

test("letterbox rejects empty images", () => {
  assert.throws(() => planLetterbox(0, 10));
});

test("rgbaToChw splits channels into planes in [0, 1]", () => {
  const rgba = new Uint8ClampedArray([255, 0, 51, 255, 0, 102, 0, 0, 0, 0, 0, 0, 0, 0, 255, 9]);
  const chw = rgbaToChw(rgba, 2);
  assert.deepEqual([...chw.subarray(0, 4)], [1, 0, 0, 0]);
  assert.ok(Math.abs(chw[5] - 0.4) < 1e-6);
  assert.ok(Math.abs(chw[8] - 0.2) < 1e-6);
  assert.equal(chw[11], 1);
});

test("maskToAlpha reads only the image's part of the mask", () => {
  // 4x4 mask, image occupies the middle 4x2 band (y 1..2) and is 1 there, 0 in padding.
  const plan = planLetterbox(8, 4, 4);
  assert.deepEqual(plan, { size: 4, w: 4, h: 2, x: 0, y: 1 });
  const mask = new Float32Array(16);
  mask.fill(1, 4, 12);
  const alpha = maskToAlpha(mask, plan, 8, 4);
  assert.ok(alpha.every((v) => v === 255));
});

test("maskToAlpha interpolates between mask pixels", () => {
  const plan = { size: 2, w: 2, h: 1, x: 0, y: 0 };
  const mask = new Float32Array([0, 1, 0, 0]);
  const alpha = maskToAlpha(mask, plan, 4, 1);
  // Edges clamp, inner pixels blend: 0, 0.25, 0.75, 1.
  assert.deepEqual([...alpha], [0, 64, 191, 255]);
});

test("maskToAlpha at the mask's own size is a copy", () => {
  const plan = planLetterbox(3, 3, 3);
  const mask = Float32Array.from({ length: 9 }, (_, i) => i / 8);
  const alpha = maskToAlpha(mask, plan, 3, 3);
  assert.deepEqual(
    [...alpha],
    [...mask].map((v) => Math.round(v * 255)),
  );
});

test("applyAlpha multiplies with existing alpha and keeps colour", () => {
  const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128]);
  const out = applyAlpha(rgba, new Uint8ClampedArray([255, 255]));
  assert.deepEqual([...out], [10, 20, 30, 255, 40, 50, 60, 128]);
  const half = applyAlpha(rgba, new Uint8ClampedArray([0, 128]));
  assert.deepEqual([...half], [10, 20, 30, 0, 40, 50, 60, 64]);
  assert.equal(rgba[3], 255, "input untouched");
});

test("parseHex", () => {
  assert.deepEqual(parseHex("#ff8000"), [255, 128, 0]);
  assert.deepEqual(parseHex("00FF10"), [0, 255, 16]);
  assert.throws(() => parseHex("#fff"));
});

test("coverRect crops the overflowing axis, centred", () => {
  assert.deepEqual(coverRect(200, 100, 100, 100), { sx: 50, sy: 0, sw: 100, sh: 100 });
  assert.deepEqual(coverRect(100, 400, 100, 200), { sx: 0, sy: 100, sw: 100, sh: 200 });
  assert.deepEqual(coverRect(50, 50, 100, 100), { sx: 0, sy: 0, sw: 50, sh: 50 });
});

test("compositeOver blends with a colour or an image and is opaque", () => {
  const fg = new Uint8ClampedArray([200, 100, 0, 255, 200, 100, 0, 0, 200, 100, 0, 128]);
  assert.deepEqual(
    [...compositeOver(fg, [0, 0, 255])],
    [200, 100, 0, 255, 0, 0, 255, 255, 100, 50, 127, 255],
  );
  const bg = new Uint8ClampedArray([9, 9, 9, 255, 1, 2, 3, 255, 0, 0, 0, 255]);
  assert.deepEqual([...compositeOver(fg, bg)].slice(0, 8), [200, 100, 0, 255, 1, 2, 3, 255]);
});
