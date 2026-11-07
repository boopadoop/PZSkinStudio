// The texture being painted: its pixels, the brushes and undo. Nothing here needs a page.
//
// The pixels are plain RGBA numbers rather than a canvas, because a canvas rounds the colours of
// see-through pixels and forgets them under fully clear ones.

const HISTORY_BYTES = 256 * 1024 * 1024;
const ROUND_TRIM = 0.1;     // so a 3 pixel round brush is a plus, not a square
const SOFT_CORE = 0.25;     // how far out a soft brush stays solid, as a share of its radius

function smoothstep(edge0, edge1, value) {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// How much of each pixel a brush covers, from 0 to 1.
export function brushMask(brush, size) {
  const mask = new Float32Array(size * size);
  const centre = (size - 1) / 2;
  const radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre);
      let cover = 1;
      if (brush === 'round') cover = distance <= radius - ROUND_TRIM ? 1 : 0;
      if (brush === 'soft') cover = 1 - smoothstep(SOFT_CORE, 1, distance / radius);
      mask[y * size + x] = cover;
    }
  }
  return mask;
}

// The top left corner of a brush at a pixel, and of each mirrored copy. Working from the corner
// keeps a copy exact: a brush of even size has no centre pixel to reflect.
export function footprints(cx, cy, size, width, height, mirrorX, mirrorY) {
  const left = cx - Math.floor((size - 1) / 2);
  const top = cy - Math.floor((size - 1) / 2);
  const [otherLeft, otherTop] = [width - size - left, height - size - top];
  const out = [{ left, top }];
  if (mirrorX) out.push({ left: otherLeft, top });
  if (mirrorY) out.push({ left, top: otherTop });
  if (mirrorX && mirrorY) out.push({ left: otherLeft, top: otherTop });
  return out;
}

export class PaintDocument {
  constructor(width, height, pixels) {
    this.width = width;
    this.height = height;
    this.pixels = pixels;
    this.base = new Uint8ClampedArray(pixels.length);
    this.cover = new Float32Array(width * height);
    this.done = [];
    this.undone = [];
    this.savedAt = null;
    this.stroke = null;
    this.changed = null;
  }

  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
  get unsaved() { return (this.done.at(-1) ?? null) !== this.savedAt; }

  markSaved() {
    this.savedAt = this.done.at(-1) ?? null;
  }

  sample(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return [...this.pixels.subarray((y * this.width + x) * 4, (y * this.width + x) * 4 + 4)];
  }

  // tool: { mode: 'paint' or 'erase', brush: 'square', 'round' or 'soft', size, colour: [r, g, b],
  // mirrorX, mirrorY }. Mirror X repeats a stroke across the texture's centre from left to right, and
  // Mirror Y from top to bottom.
  beginStroke(tool) {
    this.base.set(this.pixels);
    this.cover.fill(0);
    this.stroke = { ...tool, mask: brushMask(tool.brush, tool.size), last: null, area: null };
  }

  // Every point of a drag, joined up so a fast one leaves no gaps.
  strokeTo(x, y) {
    const { last } = this.stroke;
    if (!last) {
      this.dab(x, y);
    } else {
      const steps = Math.max(Math.abs(x - last.x), Math.abs(y - last.y));
      for (let i = 1; i <= steps; i++) {
        this.dab(Math.round(last.x + ((x - last.x) * i) / steps), Math.round(last.y + ((y - last.y) * i) / steps));
      }
    }
    this.stroke.last = { x, y };
  }

  dab(cx, cy) {
    const { size, mirrorX, mirrorY } = this.stroke;
    for (const { left, top } of footprints(cx, cy, size, this.width, this.height, mirrorX, mirrorY)) {
      this.stamp(left, top);
    }
  }

  stamp(left, top) {
    const { size, mask } = this.stroke;
    for (let y = 0; y < size; y++) {
      const py = top + y;
      if (py < 0 || py >= this.height) continue;
      for (let x = 0; x < size; x++) {
        const px = left + x;
        if (px < 0 || px >= this.width) continue;
        const cover = mask[y * size + x];
        const at = py * this.width + px;
        // A stroke keeps the most any dab gave a pixel, and paints it fresh from the state before
        // the stroke. Going over a soft edge twice in one stroke doesn't build it up to solid.
        if (cover <= this.cover[at]) continue;
        this.cover[at] = cover;
        this.blend(at * 4, cover);
        this.grow(px, py);
      }
    }
  }

  blend(i, cover) {
    const { pixels, base, stroke } = this;
    if (stroke.mode === 'erase') {
      pixels[i + 3] = base[i + 3] * (1 - cover);
      return;
    }
    const under = (base[i + 3] / 255) * (1 - cover);
    const alpha = cover + under;
    for (let c = 0; c < 3; c++) pixels[i + c] = (stroke.colour[c] * cover + base[i + c] * under) / alpha;
    pixels[i + 3] = alpha * 255;
  }

  grow(x, y) {
    const area = this.stroke.area ?? { left: x, top: y, right: x, bottom: y };
    area.left = Math.min(area.left, x);
    area.top = Math.min(area.top, y);
    area.right = Math.max(area.right, x);
    area.bottom = Math.max(area.bottom, y);
    this.stroke.area = area;
    this.mark(area);
  }

  // The part of the texture changed since the last call, for redrawing.
  mark({ left, top, right, bottom }) {
    const c = this.changed ?? { left, top, right, bottom };
    this.changed = {
      left: Math.min(c.left, left),
      top: Math.min(c.top, top),
      right: Math.max(c.right, right),
      bottom: Math.max(c.bottom, bottom),
    };
  }

  takeChanged() {
    const { changed } = this;
    this.changed = null;
    return changed;
  }

  copyArea(source, { left, top, right, bottom }) {
    const stride = (right - left + 1) * 4;
    const out = new Uint8ClampedArray(stride * (bottom - top + 1));
    for (let y = top; y <= bottom; y++) {
      const from = (y * this.width + left) * 4;
      out.set(source.subarray(from, from + stride), (y - top) * stride);
    }
    return out;
  }

  pasteArea(data, area) {
    const { left, top, right, bottom } = area;
    const stride = (right - left + 1) * 4;
    for (let y = top; y <= bottom; y++) {
      this.pixels.set(data.subarray((y - top) * stride, (y - top + 1) * stride), (y * this.width + left) * 4);
    }
    this.mark(area);
  }

  // Undo keeps only the area each stroke touched, so a long session stays small.
  endStroke() {
    const { area } = this.stroke;
    this.stroke = null;
    if (!area) return;
    const before = this.copyArea(this.base, area);
    const after = this.copyArea(this.pixels, area);
    if (before.every((value, i) => value === after[i])) return;
    this.done.push({ area, before, after });
    this.undone = [];
    let bytes = this.done.reduce((sum, step) => sum + step.before.length * 2, 0);
    while (bytes > HISTORY_BYTES && this.done.length > 1) bytes -= this.done.shift().before.length * 2;
  }

  undo() {
    const step = this.done.pop();
    if (!step) return;
    this.pasteArea(step.before, step.area);
    this.undone.push(step);
  }

  redo() {
    const step = this.undone.pop();
    if (!step) return;
    this.pasteArea(step.after, step.area);
    this.done.push(step);
  }
}
