// Interactive preview: draws the cut-out and lets the user fix the mask with a brush or
// magic wand, with undo, zoom and pan (mouse, pen and touch). The mask lives at preview
// resolution; app.js upsamples it for the full-size download.

import { renderPreview } from "./domain/composite.js";
import { History, applySelection, dilate, magicWand, paintStroke } from "./domain/edit.js";

const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
// A wand "click" may wobble a little, especially with a finger.
const CLICK_SLOP = 8;

export function createEditor(el) {
  const ctx = el.canvas.getContext("2d");
  const history = new History(20);
  const ed = {
    w: 0,
    h: 0,
    original: null,
    mask: null,
    aiMask: null,
    out: null,
    image: null,
    bg: null,
    tool: "brush",
    mode: "keep",
    overlay: false,
    showingOriginal: false,
  };
  const view = { scale: 1, tx: 0, ty: 0 };
  const pointers = new Map();
  let action = null; // {type: "paint" | "wand" | "pan" | "pinch", ...}
  let dirty = null;
  let spaceHeld = false;

  // ---------- drawing ----------

  function addDirty(r) {
    if (!r) return;
    if (!dirty) dirty = { ...r };
    else {
      const x = Math.min(dirty.x, r.x);
      const y = Math.min(dirty.y, r.y);
      dirty.w = Math.max(dirty.x + dirty.w, r.x + r.w) - x;
      dirty.h = Math.max(dirty.y + dirty.h, r.y + r.h) - y;
      dirty.x = x;
      dirty.y = y;
    }
    requestAnimationFrame(flush);
  }

  function flush() {
    if (!dirty || !ed.mask) return;
    const r = dirty;
    dirty = null;
    if (ed.showingOriginal) return;
    renderPreview(ed.out, ed.original, ed.mask, ed.w, r, {
      view: ed.overlay ? "overlay" : "result",
      bg: ed.bg,
    });
    ctx.putImageData(ed.image, 0, 0, r.x, r.y, r.w, r.h);
  }

  function redrawAll() {
    if (!ed.mask) return;
    el.canvas.classList.toggle("checker", !ed.bg && !ed.overlay && !ed.showingOriginal);
    if (ed.showingOriginal) {
      ctx.putImageData(new ImageData(ed.original, ed.w, ed.h), 0, 0);
      return;
    }
    addDirty({ x: 0, y: 0, w: ed.w, h: ed.h });
    flush();
  }

  function syncButtons() {
    el.undo.disabled = !history.canUndo;
    el.redo.disabled = !history.canRedo;
    for (const b of el.toolButtons) b.setAttribute("aria-pressed", b.dataset.tool === ed.tool);
    for (const b of el.modeButtons) b.setAttribute("aria-pressed", b.dataset.mode === ed.mode);
    el.sizeWrap.hidden = ed.tool !== "brush";
    el.tolWrap.hidden = ed.tool !== "wand";
    el.fit.hidden = view.scale === 1;
    el.stage.dataset.tool = ed.tool;
  }

  // ---------- zoom / pan ----------

  function applyView() {
    el.zoom.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
    el.canvas.style.setProperty("--checker", `${20 / view.scale}px`);
    el.fit.hidden = view.scale === 1;
  }

  function resetView() {
    view.scale = 1;
    view.tx = view.ty = 0;
    applyView();
  }

  // Zoom by `factor` keeping the client point (cx, cy) fixed on screen.
  function zoomAt(cx, cy, factor) {
    const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.scale * factor));
    if (s === MIN_ZOOM) return resetView();
    const stage = el.stage.getBoundingClientRect();
    // Untransformed origin of the zoom wrapper; offsetLeft/Top ignore CSS transforms.
    const ox = stage.left + el.zoom.offsetLeft;
    const oy = stage.top + el.zoom.offsetTop;
    const k = s / view.scale;
    view.tx = cx - ox - (cx - ox - view.tx) * k;
    view.ty = cy - oy - (cy - oy - view.ty) * k;
    view.scale = s;
    applyView();
  }

  // ---------- pointer input ----------

  // Client point -> canvas pixel; getBoundingClientRect already includes the zoom.
  function toCanvas(cx, cy) {
    const r = el.canvas.getBoundingClientRect();
    return {
      x: ((cx - r.left) * ed.w) / r.width,
      y: ((cy - r.top) * ed.h) / r.height,
      perPx: ed.w / r.width,
    };
  }

  function brushRadius(perPx) {
    return (Number(el.size.value) / 2) * perPx;
  }

  const value = () => (ed.mode === "keep" ? 255 : 0);

  function updateCursor(e) {
    const show = ed.mask && ed.tool === "brush" && e.pointerType !== "touch" && !spaceHeld;
    el.cursor.hidden = !show;
    if (!show) return;
    const stage = el.stage.getBoundingClientRect();
    const d = Number(el.size.value);
    el.cursor.style.width = el.cursor.style.height = `${d}px`;
    el.cursor.style.transform = `translate(${e.clientX - stage.left - d / 2}px, ${e.clientY - stage.top - d / 2}px)`;
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    action = {
      type: "pinch",
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
    };
  }

  function onDown(e) {
    if (!ed.mask || e.target.closest("button")) return;
    el.stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.preventDefault();

    if (pointers.size === 2) {
      // Second finger: this is a zoom gesture, so take back what the first finger painted.
      if (action?.type === "paint") {
        history.revert(ed.mask);
        redrawAll();
        syncButtons();
      }
      return startPinch();
    }
    if (pointers.size > 2) return;
    if (e.button === 1 || spaceHeld || (e.button === 2 && view.scale > 1)) {
      action = { type: "pan", x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    const p = toCanvas(e.clientX, e.clientY);
    if (ed.tool === "brush") {
      history.push(ed.mask);
      const r = brushRadius(p.perPx);
      addDirty(paintStroke(ed.mask, ed.w, ed.h, p.x, p.y, p.x, p.y, r, value()));
      action = { type: "paint", x: p.x, y: p.y };
      syncButtons();
    } else {
      action = { type: "wand", cx: e.clientX, cy: e.clientY };
    }
  }

  function onMove(e) {
    updateCursor(e);
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!action) return;
    if (action.type === "pinch" && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      view.tx += mx - action.mx;
      view.ty += my - action.my;
      zoomAt(mx, my, dist / action.dist);
      Object.assign(action, { dist, mx, my });
    } else if (action.type === "pan") {
      if (view.scale === 1) return;
      view.tx += e.clientX - action.x;
      view.ty += e.clientY - action.y;
      action.x = e.clientX;
      action.y = e.clientY;
      applyView();
    } else if (action.type === "paint") {
      // Coalesced events give the full path of fast strokes.
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ce of events.length ? events : [e]) {
        const p = toCanvas(ce.clientX, ce.clientY);
        const r = brushRadius(p.perPx);
        addDirty(paintStroke(ed.mask, ed.w, ed.h, action.x, action.y, p.x, p.y, r, value()));
        action.x = p.x;
        action.y = p.y;
      }
    } else if (action.type === "wand") {
      if (Math.hypot(e.clientX - action.cx, e.clientY - action.cy) > CLICK_SLOP) action = null;
    }
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (action?.type === "wand" && e.type === "pointerup") {
      const p = toCanvas(e.clientX, e.clientY);
      wandAt(p.x, p.y);
    }
    // Lifting one finger of a pinch ends the gesture; the other must not start painting.
    action = pointers.size ? { type: "idle" } : null;
  }

  function wandAt(x, y) {
    const tol = Number(el.tol.value);
    const sel = dilate(magicWand(ed.original, ed.w, ed.h, x, y, tol), ed.w, ed.h, 1);
    history.push(ed.mask);
    const r = applySelection(ed.mask, sel, ed.w, value());
    if (!r) history.discard();
    addDirty(r);
    syncButtons();
  }

  el.stage.addEventListener("pointerdown", onDown);
  el.stage.addEventListener("pointermove", onMove);
  el.stage.addEventListener("pointerup", onUp);
  el.stage.addEventListener("pointercancel", onUp);
  el.stage.addEventListener("pointerleave", () => (el.cursor.hidden = true));
  el.stage.addEventListener("contextmenu", (e) => e.preventDefault());
  el.stage.addEventListener(
    "wheel",
    (e) => {
      if (!ed.mask) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.002)));
    },
    { passive: false },
  );
  el.stage.addEventListener("dblclick", resetView);

  // ---------- toolbar ----------

  function undo() {
    if (history.undo(ed.mask)) redrawAll();
    syncButtons();
  }
  function redo() {
    if (history.redo(ed.mask)) redrawAll();
    syncButtons();
  }
  function setTool(t) {
    ed.tool = t;
    syncButtons();
  }
  function setMode(m) {
    ed.mode = m;
    syncButtons();
  }

  for (const b of el.toolButtons) b.addEventListener("click", () => setTool(b.dataset.tool));
  for (const b of el.modeButtons) b.addEventListener("click", () => setMode(b.dataset.mode));
  el.undo.addEventListener("click", undo);
  el.redo.addEventListener("click", redo);
  el.fit.addEventListener("click", resetView);
  el.reset.addEventListener("click", () => {
    if (!ed.mask) return;
    history.push(ed.mask);
    ed.mask.set(ed.aiMask);
    redrawAll();
    syncButtons();
  });
  el.overlay.addEventListener("change", () => {
    ed.overlay = el.overlay.checked;
    redrawAll();
  });

  document.addEventListener("keydown", (e) => {
    if (!ed.mask || e.target.closest?.("input, select, textarea")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if ((e.ctrlKey || e.metaKey) && k === "y") {
      e.preventDefault();
      return redo();
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === " " && !e.target.closest?.("button")) {
      e.preventDefault();
      spaceHeld = true;
      el.cursor.hidden = true;
      el.stage.classList.add("panning");
    } else if (k === "b") setTool("brush");
    else if (k === "w") setTool("wand");
    else if (k === "x") setMode(ed.mode === "keep" ? "remove" : "keep");
    else if (k === "[" || k === "]") {
      const s = Number(el.size.value) * (k === "]" ? 1.25 : 0.8);
      el.size.value = Math.round(Math.min(Number(el.size.max), Math.max(Number(el.size.min), s)));
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      spaceHeld = false;
      el.stage.classList.remove("panning");
    }
  });

  syncButtons();

  return {
    // New image: original RGBA and the AI mask, both w×h at preview resolution.
    load(original, aiMask, w, h) {
      Object.assign(ed, { w, h, original, aiMask, mask: aiMask.slice() });
      ed.out = new Uint8ClampedArray(w * h * 4);
      ed.image = new ImageData(ed.out, w, h);
      el.canvas.width = w;
      el.canvas.height = h;
      history.undoStack = [];
      history.redoStack = [];
      resetView();
      syncButtons();
      redrawAll();
    },
    setBackground(bg) {
      ed.bg = bg;
      redrawAll();
    },
    showOriginal(on) {
      ed.showingOriginal = on;
      redrawAll();
    },
    get mask() {
      return ed.mask;
    },
    get size() {
      return { w: ed.w, h: ed.h };
    },
  };
}
