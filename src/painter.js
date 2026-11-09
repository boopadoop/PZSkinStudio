// Paint mode: the tools, the colours, and keeping the 3D preview in step with the brush.
import { PaintDocument, resample } from './paintdoc.js';
import { PaintView } from './paintview.js';
import { encodePng } from './pngcolour.js';

const $ = (id) => document.getElementById(id);

const PALETTE = [
  '#ffffff', '#d9d9d9', '#a6a6a6', '#737373', '#404040', '#000000', '#fff1e0', '#f5d6b3', '#e0b088', '#c68a5c',
  '#8d5a3b', '#5a3a26', '#f2e2c4', '#d6b370', '#a67c3d', '#6e4f2a', '#3d2c1c', '#241a12', '#7a1f1f', '#1f3a5f',
  '#e63b2e', '#f28c28', '#f7d038', '#4caf50', '#2ecc71', '#7fdbff', '#2f80ed', '#8e44ad', '#ff8fab', '#c0c0ff',
];
const MODES = ['paint', 'erase', 'fill', 'smudge', 'pick', 'move'];
const PANELS = ['paintColours', 'paintBox', 'paintSide'];
// Texture sizes on offer: 16 to 2048, each twice the last.
const SIZES = [16, 32, 64, 128, 256, 512, 1024, 2048];
const RECENT_COLOURS = 10;
const MAX_BRUSH = 64;
const MAX_TOLERANCE = 128;
const START_COLOUR = '#c68a5c';

const toHex = (rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
const toRgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

export class Painter {
  // viewer: the 3D view. onClosed runs when the user leaves paint mode. onSave gets the PNG and a
  // suggested name, once the user has chosen to save.
  constructor(viewer, { onClosed, onSaveRequest }) {
    this.viewer = viewer;
    this.onClosed = onClosed;
    this.onSaveRequest = onSaveRequest;
    this.doc = null;
    this.recent = [];
    this.previewDue = false;
    this.view = new PaintView($('paintCanvas'), {
      onStrokeChange: () => this.showChanges(),
      onStrokeEnd: () => {
        if (['paint', 'fill'].includes(this.view.tool.mode)) this.remember(this.view.tool.colour);
        this.updateButtons();
      },
      onPick: (rgb) => { this.setColour(toHex(rgb)); this.remember(rgb); },
      onHover: () => this.updateStatus(),
      onBrush: (brush) => this.showBrushOnModel(brush),
    });
    this.buildPalette();
    this.bindControls();
    this.setColour(START_COLOUR);
  }

  get isOpen() { return this.doc !== null; }
  get unsaved() { return this.doc ? this.doc.unsaved || this.resized : false; }

  buildPalette() {
    $('palette').replaceChildren(...PALETTE.map((hex) => this.swatch(hex)));
  }

  swatch(hex) {
    const button = document.createElement('button');
    button.className = 'swatch';
    button.style.background = hex;
    button.title = hex;
    button.setAttribute('aria-label', `Colour ${hex}`);
    button.onclick = () => this.setColour(hex);
    return button;
  }

  bindControls() {
    for (const mode of MODES) $(`tool-${mode}`).onclick = () => this.setMode(mode);
    for (const brush of ['square', 'round', 'soft']) $(`brush-${brush}`).onclick = () => this.setBrush(brush);
    $('brushSize').oninput = (event) => this.setAmount(Number(event.target.value));
    $('brushSmaller').onclick = () => this.nudgeAmount(-1);
    $('brushBigger').onclick = () => this.nudgeAmount(1);
    $('paintColour').oninput = (event) => this.setColour(event.target.value);
    $('paintUndo').onclick = () => this.undo();
    $('paintRedo').onclick = () => this.redo();
    $('mirrorX').onclick = () => this.toggleMirror('mirrorX');
    $('mirrorY').onclick = () => this.toggleMirror('mirrorY');
    $('paintGrid').onclick = () => this.toggleGuide('showGrid', 'paintGrid');
    $('paintUv').onclick = () => this.toggleGuide('showUv', 'paintUv');
    $('zoomIn').onclick = () => this.view.zoomBy(1);
    $('zoomOut').onclick = () => this.view.zoomBy(-1);
    $('paintFit').onclick = () => this.view.fit();
    $('previewBig').onclick = () => this.toggleBigPreview();
    $('paintClose').onclick = () => this.requestClose();
    $('paintSave').onclick = () => this.onSaveRequest();
    $('paintSize').onchange = (event) => this.resize(Number(event.target.value));
    $('paintOnModel').checked = localStorage.getItem('pzSkinStudio.paintOnModel') === '1';
    $('paintOnModel').onchange = (event) => {
      localStorage.setItem('pzSkinStudio.paintOnModel', event.target.checked ? '1' : '0');
      this.updateModelPainting();
    };
    $('hideOthers').checked = localStorage.getItem('pzSkinStudio.hideOthers') === '1';
    $('hideOthers').onchange = (event) => {
      localStorage.setItem('pzSkinStudio.hideOthers', event.target.checked ? '1' : '0');
      this.viewer.showGhost(!event.target.checked);
    };
    $('brushOnModel').checked = localStorage.getItem('pzSkinStudio.brushOnModel') !== '0';
    $('brushOnModel').onchange = (event) => {
      localStorage.setItem('pzSkinStudio.brushOnModel', event.target.checked ? '1' : '0');
      this.showBrushOnModel(this.lastBrush);
    };
    addEventListener('keydown', (event) => this.onKeyDown(event));
    addEventListener('keyup', (event) => { if (event.code === 'Space') this.view.spaceHeld = false; });
  }

  setMode(mode) {
    this.view.tool.mode = mode;
    for (const name of MODES) $(`tool-${name}`).classList.toggle('active', name === mode);
    this.showAmount();
    this.view.updateCursor();
    this.view.requestDraw();
  }

  // The one slider is the brush size, except for Fill, which has no brush and needs a tolerance.
  get fillSelected() {
    return this.view.tool.mode === 'fill';
  }

  showAmount() {
    const { tool } = this.view;
    const fill = this.fillSelected;
    $('sizeLabel').textContent = fill ? 'Tolerance' : 'Size';
    $('brushSize').min = fill ? 0 : 1;
    $('brushSize').max = fill ? MAX_TOLERANCE : MAX_BRUSH;
    $('brushSize').value = fill ? tool.tolerance : tool.size;
    $('brushSize').setAttribute('aria-label', fill ? 'Fill tolerance' : 'Brush size');
    $('brushSizeValue').textContent = fill ? tool.tolerance : tool.size;
    $('sizeRow').title = fill ? 'How different a colour can be and still get filled' : 'Brush size in texture pixels';
  }

  setAmount(value) {
    if (this.fillSelected) this.view.tool.tolerance = Math.min(Math.max(value, 0), MAX_TOLERANCE);
    else this.setSize(value);
    this.showAmount();
  }

  nudgeAmount(step) {
    const { tool } = this.view;
    this.setAmount((this.fillSelected ? tool.tolerance : tool.size) + step);
  }

  toggleMirror(axis) {
    const on = !this.view.tool[axis];
    this.view.tool[axis] = on;
    $(axis).classList.toggle('active', on);
    $(axis).setAttribute('aria-pressed', on);
    this.view.requestDraw();
  }

  toggleGuide(setting, buttonId) {
    const on = !this.view[setting];
    this.view[setting] = on;
    $(buttonId).classList.toggle('active', on);
    $(buttonId).setAttribute('aria-pressed', on);
    // A button that visibly does nothing looks broken, so go to where the grid can be seen.
    if (setting === 'showGrid' && on && !this.view.gridVisible) this.view.zoomToGrid();
    this.view.requestDraw();
    this.updateStatus();
  }

  setBrush(brush) {
    this.view.tool.brush = brush;
    for (const name of ['square', 'round', 'soft']) $(`brush-${name}`).classList.toggle('active', name === brush);
    this.view.requestDraw();
  }

  setSize(size) {
    this.view.tool.size = Math.min(Math.max(size, 1), MAX_BRUSH);
    this.showAmount();
    this.view.requestDraw();
  }

  setColour(hex) {
    this.view.tool.colour = toRgb(hex);
    $('paintColour').value = hex;
    $('paintHex').textContent = hex;
    // Picking up a colour means you want to use it next, by painting unless you're filling.
    if (!['paint', 'fill'].includes(this.view.tool.mode)) this.setMode('paint');
  }

  remember(rgb) {
    const hex = toHex(rgb);
    this.recent = [hex, ...this.recent.filter((other) => other !== hex)].slice(0, RECENT_COLOURS);
    $('recentColours').replaceChildren(...this.recent.map((colour) => this.swatch(colour)));
  }

  open({ width, height, pixels, mesh, name, what }) {
    this.doc = new PaintDocument(width, height, pixels);
    this.mesh = mesh;
    // Earlier sizes of the texture, for Undo to go back to.
    this.sizes = [];
    this.resized = false;
    document.body.classList.add('painting');
    for (const id of PANELS) $(id).hidden = false;
    $('toolbar').hidden = true;
    $('browse').hidden = true;
    $('previewSlot').append($('canvasBox'));
    this.setName(name);
    $('paintWhat').textContent = what;
    this.setMode('paint');
    this.setBrush('square');
    this.setSize(this.view.tool.size);
    this.viewer.setPaintPixels(pixels, width, height);
    this.view.open(this.doc, mesh);
    this.showSize();
    // Painting on the model is for one object at a time: with several, a messy UV map would spread a
    // stroke over them all.
    const parts = mesh.cornerPart ? new Set(Array.from({ length: mesh.index.length / 3 }, (_, t) => mesh.cornerPart[mesh.index[t * 3]])) : null;
    this.oneObject = !parts || parts.size <= 1;
    $('paintOnModel').disabled = !this.oneObject;
    $('paintOnModelHint').hidden = this.oneObject;
    $('hideOthersRow').hidden = !this.viewer.ghost;
    this.viewer.showGhost(!$('hideOthers').checked);
    this.updateModelPainting();
    this.updateButtons();
    this.updateStatus();
  }

  // Strokes on the model go through the same brush as strokes on the texture, at the texture pixel
  // under the pointer. Where two points in a row are far apart on the texture, the stroke has
  // crossed a seam, so the brush lifts rather than drawing a line across the texture between them.
  updateModelPainting() {
    const on = this.isOpen && this.oneObject && $('paintOnModel').checked;
    if (!on) {
      this.viewer.setSurfacePainting(null);
      return;
    }
    const texel = (hit) => ({
      x: Math.min(this.doc.width - 1, Math.floor(hit.u * this.doc.width)),
      y: Math.min(this.doc.height - 1, Math.floor(hit.v * this.doc.height)),
    });
    let last = null;
    const near = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= Math.max(4 * this.view.tool.size, this.doc.width * 0.02);
    this.viewer.setSurfacePainting({
      wants: () => this.isOpen && !this.view.moving && !this.view.drag,
      start: (hit, event) => {
        last = texel(hit);
        this.view.startAt(last, event.altKey);
      },
      move: (hit) => {
        if (!hit) {
          last = null;
          return;
        }
        const at = texel(hit);
        this.view.dragTo(at, !!last && near(at, last));
        last = at;
      },
      end: () => this.view.onPointerUp(),
      hover: (hit) => this.view.hoverAt(hit ? texel(hit) : null),
    });
  }

  // The paint canvas's brush outline, drawn on the model too when that's ticked.
  showBrushOnModel(brush) {
    this.lastBrush = brush;
    const show = brush && this.isOpen && $('brushOnModel').checked;
    this.viewer.setBrush(show ? brush.spots : [], brush?.round);
  }

  showSize() {
    const { width, height } = this.doc;
    const sizes = SIZES.includes(width) && width === height ? SIZES : [...SIZES, `${width} × ${height}`];
    $('paintSize').replaceChildren(...sizes.map((size) => {
      const option = document.createElement('option');
      option.value = typeof size === 'number' ? size : '';
      option.textContent = typeof size === 'number' ? `${size} × ${size}` : size;
      option.selected = typeof size === 'number' ? size === width && width === height : true;
      if (typeof size !== 'number') option.disabled = true;
      return option;
    }));
  }

  // A new size for the texture. The old one is kept so Undo can bring it back.
  resize(size) {
    if (!this.doc || !size || this.view.drag) return;
    const { width, height, pixels } = this.doc;
    if (size === width && size === height) return;
    this.sizes.push({ doc: this.doc, resized: this.resized });
    this.useDoc(new PaintDocument(size, size, resample(pixels, width, height, size, size)));
    this.resized = true;
    this.onResized?.(size);
    this.updateButtons();
  }

  useDoc(doc) {
    this.doc = doc;
    this.viewer.setPaintPixels(doc.pixels, doc.width, doc.height);
    this.view.open(doc, this.mesh);
    this.showSize();
    this.updateStatus();
  }

  setName(name) {
    this.name = name;
    $('paintTitle').textContent = name;
  }

  requestClose() {
    // eslint-disable-next-line no-alert
    if (this.unsaved && !window.confirm('Close without saving your changes?')) return;
    this.close();
  }

  close() {
    this.doc = null;
    this.viewer.setSurfacePainting(null);
    this.viewer.showGhost(true);
    this.resized = false;
    this.sizes = [];
    this.viewer.setBrush([]);
    this.view.close();
    document.body.classList.remove('painting', 'bigPreview');
    for (const id of PANELS) $(id).hidden = true;
    $('toolbar').hidden = false;
    $('browse').hidden = false;
    $('previewBig').textContent = 'Enlarge preview';
    $('stage').insertBefore($('canvasBox'), $('welcome'));
    this.onClosed();
  }

  png() {
    return encodePng(this.doc.width, this.doc.height, this.doc.pixels);
  }

  markSaved(name) {
    this.doc.markSaved();
    this.resized = false;
    this.setName(name);
    this.updateButtons();
  }

  // Sends new pixels to the texture view and the model, at most once a frame.
  showChanges() {
    this.view.refresh();
    if (this.previewDue) return;
    this.previewDue = true;
    requestAnimationFrame(() => {
      this.previewDue = false;
      if (this.isOpen) this.viewer.repaint();
    });
  }

  undo() {
    if (!this.doc || this.view.drag) return;
    if (!this.doc.canUndo && this.sizes.length) {
      const before = this.sizes.pop();
      this.useDoc(before.doc);
      this.resized = before.resized;
      this.updateButtons();
      return;
    }
    if (!this.doc.canUndo) return;
    this.doc.undo();
    this.showChanges();
    this.updateButtons();
  }

  redo() {
    if (!this.doc?.canRedo || this.view.drag) return;
    this.doc.redo();
    this.showChanges();
    this.updateButtons();
  }

  updateButtons() {
    $('paintUndo').disabled = !this.doc?.canUndo && !this.sizes?.length;
    $('paintRedo').disabled = !this.doc?.canRedo;
    $('paintUnsaved').hidden = !this.unsaved;
  }

  updateStatus() {
    if (!this.doc) return;
    const { hover, zoom, showGrid, gridVisible } = this.view;
    const parts = [`${this.doc.width} × ${this.doc.height}`, `${Math.round(zoom * 100)}%`];
    if (hover && this.doc.sample(hover.x, hover.y)) parts.push(`x ${hover.x}, y ${hover.y}`);
    if (showGrid && !gridVisible) parts.push('Zoom in to see the pixel grid again');
    $('paintStatus').textContent = parts.join('  ·  ');
  }

  toggleBigPreview() {
    const big = document.body.classList.toggle('bigPreview');
    $('previewBig').textContent = big ? 'Shrink preview' : 'Enlarge preview';
    // The texture's space just changed size, so it may not be on screen any more.
    requestAnimationFrame(() => this.view.fit());
  }

  onKeyDown(event) {
    if (!this.isOpen || event.target.matches('input[type=text], select, dialog *')) return;
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    if (command && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
    } else if (command && key === 'y') {
      event.preventDefault();
      this.redo();
    } else if (event.code === 'Space') {
      event.preventDefault();
      this.view.spaceHeld = true;
    } else if (!command) {
      const actions = {
        b: () => this.setMode('paint'),
        e: () => this.setMode('erase'),
        k: () => this.setMode('fill'),
        s: () => this.setMode('smudge'),
        i: () => this.setMode('pick'),
        m: () => this.setMode('move'),
        x: () => this.toggleMirror('mirrorX'),
        y: () => this.toggleMirror('mirrorY'),
        '[': () => this.nudgeAmount(-1),
        ']': () => this.nudgeAmount(1),
        g: () => $('paintGrid').click(),
        u: () => $('paintUv').click(),
        '-': () => this.view.zoomBy(-1),
        '=': () => this.view.zoomBy(1),
        '+': () => this.view.zoomBy(1),
        f: () => this.view.fit(),
      };
      actions[key]?.();
    }
  }
}
