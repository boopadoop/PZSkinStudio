// The texture on screen while painting: zooming, moving it around, the guides, and turning the
// mouse into strokes. The guides are only drawn here, so they never reach the texture.
import { footprints } from './paintdoc.js';
import { partCss } from './partcolour.js';

const ZOOMS = [0.25, 0.5, 0.75, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64];
const GRID_MIN_ZOOM = 3;    // any closer together and the lines hide the pixels
const GRID_FULL_ZOOM = 5;   // below this the lines are fainter, for the same reason
const FIT_MARGIN = 16;
const CHECKER_SIZE = 8;
const MIDDLE_BUTTON = 1;

function checkerPattern(context) {
  const tile = document.createElement('canvas');
  tile.width = tile.height = CHECKER_SIZE * 2;
  const paint = tile.getContext('2d');
  paint.fillStyle = '#3a3c44';
  paint.fillRect(0, 0, CHECKER_SIZE * 2, CHECKER_SIZE * 2);
  paint.fillStyle = '#2c2e35';
  paint.fillRect(0, 0, CHECKER_SIZE, CHECKER_SIZE);
  paint.fillRect(CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
  return context.createPattern(tile, 'repeat');
}

export class PaintView {
  // Calls onStrokeChange as a stroke paints, onStrokeEnd when it ends, onPick with a pixel's
  // colour, and onHover whenever the status line needs redoing.
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.handlers = handlers;
    this.checker = checkerPattern(this.context);
    this.tool = { mode: 'paint', brush: 'square', size: 1, tolerance: 12, colour: [0, 0, 0], mirrorX: false, mirrorY: false };
    this.showGrid = false;
    this.showUv = false;
    this.doc = null;
    this.zoom = 1;
    this.offset = { x: 0, y: 0 };
    this.hover = null;
    this.drag = null;
    this.held = false;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.requestDraw(); this.handlers.onHover(); });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  open(doc, mesh) {
    this.doc = doc;
    this.buffer = document.createElement('canvas');
    this.buffer.width = doc.width;
    this.buffer.height = doc.height;
    this.bufferContext = this.buffer.getContext('2d');
    this.image = new ImageData(doc.pixels, doc.width, doc.height);
    this.bufferContext.putImageData(this.image, 0, 0);

    // All the lines, and with colourParts (each corner's object number), the lines of each object.
    this.uvLines = new Path2D();
    this.partLines = new Map();
    const { uv, edges, colourParts } = mesh;
    for (let i = 0; i < edges.length; i += 2) {
      const [a, b] = [edges[i] * 2, edges[i + 1] * 2];
      for (const path of [this.uvLines, colourParts && this.partPath(colourParts[edges[i]])].filter(Boolean)) {
        path.moveTo(uv[a] * doc.width, uv[a + 1] * doc.height);
        path.lineTo(uv[b] * doc.width, uv[b + 1] * doc.height);
      }
    }
    this.resize();
    this.fit();
  }

  partPath(part) {
    if (!this.partLines.has(part)) this.partLines.set(part, new Path2D());
    return this.partLines.get(part);
  }

  close() {
    this.doc = null;
    this.drag = null;
  }

  // Space is the Move tool for as long as it's held.
  set spaceHeld(held) {
    this.held = held;
    this.updateCursor();
  }

  get moving() {
    return this.held || this.tool.mode === 'move';
  }

  updateCursor() {
    let cursor = '';
    if (this.drag?.kind === 'pan') cursor = 'grabbing';
    else if (this.moving) cursor = 'grab';
    this.canvas.style.cursor = cursor;
  }

  resize() {
    const box = this.canvas.parentElement;
    if (!box.clientWidth || !box.clientHeight) return;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = box.clientWidth * ratio;
    this.canvas.height = box.clientHeight * ratio;
    this.requestDraw();
  }

  fit() {
    if (!this.doc) return;
    const { clientWidth, clientHeight } = this.canvas;
    const room = Math.min((clientWidth - FIT_MARGIN) / this.doc.width, (clientHeight - FIT_MARGIN) / this.doc.height);
    this.zoom = ZOOMS.findLast((zoom) => zoom <= room) ?? ZOOMS[0];
    this.offset = {
      x: Math.round((clientWidth - this.doc.width * this.zoom) / 2),
      y: Math.round((clientHeight - this.doc.height * this.zoom) / 2),
    };
    this.requestDraw();
    this.handlers.onHover();
  }

  // The pixel of the texture under a point on the page.
  texelAt(event) {
    const box = this.canvas.getBoundingClientRect();
    return {
      x: Math.floor((event.clientX - box.left - this.offset.x) / this.zoom),
      y: Math.floor((event.clientY - box.top - this.offset.y) / this.zoom),
    };
  }

  onPointerDown(event) {
    if (!this.doc) return;
    this.canvas.setPointerCapture(event.pointerId);
    if (event.button === MIDDLE_BUTTON || (event.button === 0 && this.moving)) {
      this.drag = { kind: 'pan', x: event.clientX - this.offset.x, y: event.clientY - this.offset.y };
      this.updateCursor();
      return;
    }
    if (event.button !== 0) return;
    this.startAt(this.texelAt(event), event.altKey);
  }

  // A stroke, pick or fill starting at a texture pixel: from this canvas, or from the model.
  startAt(texel, alt = false) {
    if (this.tool.mode === 'pick' || alt) {
      this.drag = { kind: 'pick' };
      this.pick(texel);
      return;
    }
    if (this.tool.mode === 'fill') {
      this.doc.beginStroke(this.tool);
      this.doc.fill(texel.x, texel.y);
      this.doc.endStroke();
      this.handlers.onStrokeChange();
      this.handlers.onStrokeEnd();
      return;
    }
    this.drag = { kind: 'paint' };
    this.doc.beginStroke(this.tool);
    this.doc.strokeTo(texel.x, texel.y);
    this.handlers.onStrokeChange();
  }

  // The next point of a drag from the model. joined: whether it carries on from the last one, or
  // jumps (across a seam to somewhere else on the texture).
  dragTo(texel, joined) {
    this.hover = texel;
    if (this.drag?.kind === 'pick') this.pick(texel);
    else if (this.drag?.kind === 'paint') {
      if (!joined) this.doc.liftBrush();
      this.doc.strokeTo(texel.x, texel.y);
      this.handlers.onStrokeChange();
    }
    this.requestDraw();
    this.handlers.onHover();
  }

  // The brush hovering a texture pixel from the model, or null when it's off the model.
  hoverAt(texel) {
    this.hover = texel;
    this.requestDraw();
    this.handlers.onHover();
  }

  onPointerMove(event) {
    if (!this.doc) return;
    this.hover = this.texelAt(event);
    if (this.drag?.kind === 'pan') {
      this.offset = { x: event.clientX - this.drag.x, y: event.clientY - this.drag.y };
    } else if (this.drag?.kind === 'pick') {
      this.pick(this.hover);
    } else if (this.drag?.kind === 'paint') {
      const points = event.getCoalescedEvents?.() ?? [];
      for (const point of points.length ? points : [event]) {
        const { x, y } = this.texelAt(point);
        this.doc.strokeTo(x, y);
      }
      this.handlers.onStrokeChange();
    }
    this.requestDraw();
    this.handlers.onHover();
  }

  onPointerUp() {
    const painting = this.drag?.kind === 'paint';
    this.drag = null;
    this.updateCursor();
    if (painting) {
      this.doc.endStroke();
      this.handlers.onStrokeEnd();
    }
  }

  pick({ x, y }) {
    const pixel = this.doc.sample(x, y);
    if (pixel && pixel[3] > 0) this.handlers.onPick(pixel.slice(0, 3));
  }

  onWheel(event) {
    event.preventDefault();
    if (!this.doc) return;
    const box = this.canvas.getBoundingClientRect();
    this.zoomBy(event.deltaY < 0 ? 1 : -1, event.clientX - box.left, event.clientY - box.top);
  }

  // Steps the zoom in or out around a point on the canvas, so the pixel there stays there. With no
  // point, that's the middle of the view.
  zoomBy(steps, px = this.canvas.clientWidth / 2, py = this.canvas.clientHeight / 2) {
    if (!this.doc) return;
    const index = ZOOMS.indexOf(this.zoom) + steps;
    const zoom = ZOOMS[Math.min(Math.max(index, 0), ZOOMS.length - 1)];
    this.offset = {
      x: Math.round(px - ((px - this.offset.x) / this.zoom) * zoom),
      y: Math.round(py - ((py - this.offset.y) / this.zoom) * zoom),
    };
    this.zoom = zoom;
    this.requestDraw();
    this.handlers.onHover();
  }

  // Brings the screen up to date with what the document changed.
  refresh() {
    const area = this.doc?.takeChanged();
    if (area) {
      const { left, top, right, bottom } = area;
      this.bufferContext.putImageData(this.image, 0, 0, left, top, right - left + 1, bottom - top + 1);
    }
    this.requestDraw();
    return area;
  }

  requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  draw() {
    const { context, doc, offset, zoom } = this;
    const ratio = window.devicePixelRatio || 1;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!doc) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const [width, height] = [doc.width * zoom, doc.height * zoom];
    context.fillStyle = this.checker;
    context.fillRect(offset.x, offset.y, width, height);
    context.imageSmoothingEnabled = false;
    context.drawImage(this.buffer, offset.x, offset.y, width, height);
    if (this.showGrid && this.gridVisible) this.drawGrid();
    if (this.showUv) this.drawUvLines();
    this.drawMirrorLines();
    this.drawBrush();
  }

  get gridVisible() {
    return this.zoom >= GRID_MIN_ZOOM;
  }

  // Zooms in just far enough for the pixel grid to show.
  zoomToGrid() {
    this.zoomBy(ZOOMS.indexOf(GRID_MIN_ZOOM) - ZOOMS.indexOf(this.zoom));
  }

  drawGrid() {
    const { context, doc, offset, zoom } = this;
    context.strokeStyle = zoom < GRID_FULL_ZOOM ? 'rgba(0, 0, 0, 0.16)' : 'rgba(0, 0, 0, 0.35)';
    context.lineWidth = 1;
    context.beginPath();
    for (let x = 0; x <= doc.width; x++) {
      context.moveTo(offset.x + x * zoom + 0.5, offset.y);
      context.lineTo(offset.x + x * zoom + 0.5, offset.y + doc.height * zoom);
    }
    for (let y = 0; y <= doc.height; y++) {
      context.moveTo(offset.x, offset.y + y * zoom + 0.5);
      context.lineTo(offset.x + doc.width * zoom, offset.y + y * zoom + 0.5);
    }
    context.stroke();
  }

  drawUvLines() {
    const { context, offset, zoom } = this;
    const ratio = window.devicePixelRatio || 1;
    context.save();
    context.setTransform(ratio * zoom, 0, 0, ratio * zoom, ratio * offset.x, ratio * offset.y);
    // Dark under light, to show up on any colour of skin.
    context.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    context.lineWidth = 3 / zoom;
    context.stroke(this.uvLines);
    context.lineWidth = 1 / zoom;
    if (this.partLines.size) {
      for (const [part, path] of this.partLines) {
        context.strokeStyle = partCss(part, 0.95);
        context.stroke(path);
      }
    } else {
      context.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      context.stroke(this.uvLines);
    }
    context.restore();
  }

  drawMirrorLines() {
    const { context, doc, offset, zoom, tool } = this;
    if (!tool.mirrorX && !tool.mirrorY) return;
    const [right, bottom] = [offset.x + doc.width * zoom, offset.y + doc.height * zoom];
    const [middleX, middleY] = [offset.x + (doc.width * zoom) / 2, offset.y + (doc.height * zoom) / 2];
    context.save();
    context.lineWidth = 1;
    context.setLineDash([8, 6]);
    for (const [colour, shift] of [['rgba(0, 0, 0, 0.7)', 1.5], ['#e8944a', 0.5]]) {
      context.strokeStyle = colour;
      context.beginPath();
      if (tool.mirrorX) {
        context.moveTo(middleX + shift, offset.y);
        context.lineTo(middleX + shift, bottom);
      }
      if (tool.mirrorY) {
        context.moveTo(offset.x, middleY + shift);
        context.lineTo(right, middleY + shift);
      }
      context.stroke();
    }
    context.restore();
  }

  drawBrush() {
    if (!this.hover || this.moving || this.drag?.kind === 'pan') {
      this.handlers.onBrush?.(null);
      return;
    }
    const { context, doc, offset, zoom, tool } = this;
    const picking = tool.mode === 'pick';
    const onePixel = picking || tool.mode === 'fill';
    const size = onePixel ? 1 : tool.size;
    const across = size * zoom;
    const spots = footprints(this.hover.x, this.hover.y, size, doc.width, doc.height, !picking && tool.mirrorX, !picking && tool.mirrorY);
    // The same outlines, for the model: boxes in UV space.
    this.handlers.onBrush?.({
      round: !(tool.brush === 'square' || onePixel),
      spots: spots.map(({ left, top }) => [left / doc.width, top / doc.height, (left + size) / doc.width, (top + size) / doc.height]),
    });
    const outline = (left, top, shift, colour) => {
      context.strokeStyle = colour;
      context.lineWidth = 1;
      context.beginPath();
      if (tool.brush === 'square' || onePixel) context.rect(left + shift, top + shift, across, across);
      else context.arc(left + across / 2 + shift, top + across / 2 + shift, across / 2, 0, Math.PI * 2);
      context.stroke();
    };
    for (const spot of spots) {
      const [left, top] = [offset.x + spot.left * zoom, offset.y + spot.top * zoom];
      outline(left, top, 1.5, 'rgba(0, 0, 0, 0.8)');
      outline(left, top, 0.5, '#ffffff');
    }
  }
}
