import assert from "node:assert/strict";
import { test } from "node:test";

import { renderPreview } from "./composite.js";
import { History, applySelection, dilate, magicWand, paintDab, paintStroke } from "./edit.js";
import { maskToAlpha, resizeMask } from "./mask.js";

const at = (m, w, x, y) => m[y * w + x];

test("paintDab fills the disc, softens the edge and reports the dirty rect", () => {
  const w = 20;
  const mask = new Uint8ClampedArray(w * w);
  const rect = paintDab(mask, w, w, 10, 10, 4, 255);
  assert.equal(at(mask, w, 10, 10), 255);
  assert.equal(at(mask, w, 0, 0), 0);
  assert.ok(
    mask.some((v) => v > 0 && v < 255),
    "has a soft edge",
  );
  assert.ok(rect.x <= 6 && rect.x + rect.w >= 14 && rect.y <= 6 && rect.y + rect.h >= 14);
});

test("paintDab clips to the canvas and erases toward 0", () => {
  const mask = new Uint8ClampedArray(25).fill(255);
  const rect = paintDab(mask, 5, 5, 0, 0, 2, 0);
  assert.equal(mask[0], 0);
  assert.equal(mask[24], 255);
  assert.deepEqual({ x: rect.x, y: rect.y }, { x: 0, y: 0 });
  assert.equal(paintDab(mask, 5, 5, -50, -50, 2, 0), null);
});

test("paintStroke covers the whole segment without gaps", () => {
  const w = 40;
  const mask = new Uint8ClampedArray(w * 10);
  paintStroke(mask, w, 10, 2, 5, 37, 5, 2, 255);
  for (let x = 2; x <= 37; x++) assert.equal(at(mask, w, x, 5), 255, `x=${x}`);
});

test("magicWand selects the connected flat area and stops at outlines", () => {
  // 6x3: left 2 columns red, a black outline column, then red again (not connected).
  const w = 6;
  const h = 3;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      rgba.set(x === 2 ? [0, 0, 0, 255] : [220, 30, 30, 255], p);
    }
  }
  const sel = magicWand(rgba, w, h, 0, 0, 20);
  assert.deepEqual([...sel.subarray(0, 6)], [1, 1, 0, 0, 0, 0]);
  assert.equal(
    sel.reduce((a, b) => a + b),
    6,
  );
  const all = magicWand(rgba, w, h, 0, 0, 255);
  assert.equal(
    all.reduce((a, b) => a + b),
    w * h,
    "tolerance 255 takes everything",
  );
  assert.equal(
    magicWand(rgba, w, h, 99, 0, 20).reduce((a, b) => a + b),
    0,
  );
});

test("magicWand tolerance includes near colours", () => {
  const rgba = new Uint8ClampedArray([100, 100, 100, 255, 110, 110, 110, 255, 200, 200, 200, 255]);
  assert.deepEqual([...magicWand(rgba, 3, 1, 0, 0, 5)], [1, 0, 0]);
  assert.deepEqual([...magicWand(rgba, 3, 1, 0, 0, 12)], [1, 1, 0]);
});

test("magicWand handles concave shapes (U turn)", () => {
  // 5x3 "U": white everywhere except a black bar in the top middle.
  const w = 5;
  const rgba = new Uint8ClampedArray(w * 3 * 4).fill(255);
  for (const x of [1, 2, 3]) rgba.set([0, 0, 0, 255], x * 4);
  for (const x of [2]) rgba.set([0, 0, 0, 255], (w + x) * 4);
  const sel = magicWand(rgba, w, 3, 0, 0, 10);
  assert.equal(sel[4], 1, "reaches the other arm through the bottom");
  assert.equal(
    sel.reduce((a, b) => a + b),
    15 - 4,
  );
});

test("dilate grows a selection by r in every direction", () => {
  const sel = new Uint8Array(25);
  sel[12] = 1;
  assert.equal(
    dilate(sel, 5, 5, 1).reduce((a, b) => a + b),
    9,
  );
  assert.equal(dilate(sel, 5, 5, 0), sel);
});

test("applySelection writes the value and returns the bounding rect", () => {
  const mask = new Uint8ClampedArray(12).fill(255);
  const sel = new Uint8Array(12);
  sel[5] = sel[10] = 1;
  assert.deepEqual(applySelection(mask, sel, 4, 0), { x: 1, y: 1, w: 2, h: 2 });
  assert.equal(mask[5], 0);
  assert.equal(mask[10], 0);
  assert.equal(mask[0], 255);
  assert.equal(applySelection(mask, new Uint8Array(12), 4, 0), null);
});

test("History undoes, redoes and caps its size", () => {
  const mask = new Uint8ClampedArray([1, 2]);
  const hist = new History(2);
  assert.equal(hist.undo(mask), false);
  for (const v of [10, 20, 30]) {
    hist.push(mask);
    mask[0] = v;
  }
  assert.equal(hist.undo(mask), true);
  assert.equal(mask[0], 20);
  assert.equal(hist.undo(mask), true);
  assert.equal(mask[0], 10);
  assert.equal(hist.canUndo, false, "oldest state dropped by the cap");
  assert.equal(hist.redo(mask), true);
  assert.equal(mask[0], 20);
  hist.push(mask);
  assert.equal(hist.canRedo, false, "a new edit clears redo");
});

test("resizeMask on bytes matches maskToAlpha on floats", () => {
  const plan = { size: 4, w: 4, h: 2, x: 0, y: 1 };
  const f = Float32Array.from({ length: 16 }, (_, i) => (i % 5) / 4);
  const bytes = Uint8ClampedArray.from(f, (v) => v * 255);
  const a = maskToAlpha(f, plan, 7, 3);
  const b = resizeMask(bytes, 4, plan, 7, 3);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= 1);
});

test("renderPreview: result, background and overlay views", () => {
  const original = new Uint8ClampedArray([200, 100, 0, 255, 200, 100, 0, 255]);
  const mask = new Uint8ClampedArray([255, 0]);
  const rect = { x: 0, y: 0, w: 2, h: 1 };
  const out = new Uint8ClampedArray(8);
  renderPreview(out, original, mask, 2, rect);
  assert.deepEqual([...out], [200, 100, 0, 255, 200, 100, 0, 0]);
  renderPreview(out, original, mask, 2, rect, { bg: [0, 0, 255] });
  assert.deepEqual([...out], [200, 100, 0, 255, 0, 0, 255, 255]);
  renderPreview(out, original, mask, 2, rect, { view: "overlay" });
  assert.deepEqual([...out.subarray(0, 4)], [200, 100, 0, 255], "kept pixels untinted");
  assert.ok(out[4] > 200 && out[5] < 100, "removed pixels tinted red");
  // Only the rect is touched.
  out.fill(7);
  renderPreview(out, original, mask, 2, { x: 1, y: 0, w: 1, h: 1 });
  assert.deepEqual([...out.subarray(0, 4)], [7, 7, 7, 7]);
});

test("History.revert restores the last push without adding a redo step", () => {
  const mask = new Uint8ClampedArray([5]);
  const hist = new History();
  hist.push(mask);
  mask[0] = 99;
  hist.revert(mask);
  assert.equal(mask[0], 5);
  assert.equal(hist.canUndo, false);
  assert.equal(hist.canRedo, false);
});
