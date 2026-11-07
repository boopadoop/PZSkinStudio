// The painter, with real mouse input, against the real pack in models/.
//   node tools/test-paint.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pngjs from 'pngjs';
import { brushMask, PaintDocument } from '../src/paintdoc.js';
import { colourOf } from '../src/pngcolour.js';
import { unpackSkin } from '../src/skinfile.js';
import { newProfile, openFolder, root, start } from './harness.mjs';

const { PNG } = pngjs;
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== '' ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- The engine, with no page ---
{
  const blank = (fill = 0) => new PaintDocument(32, 32, new Uint8ClampedArray(32 * 32 * 4).fill(fill));
  const tool = (changes) => ({ mode: 'paint', brush: 'square', size: 1, colour: [200, 100, 50], ...changes });
  const stroke = (doc, options, points) => {
    doc.beginStroke(tool(options));
    for (const [x, y] of points) doc.strokeTo(x, y);
    doc.endStroke();
  };
  const painted = (doc) => {
    let n = 0;
    for (let i = 3; i < doc.pixels.length; i += 4) if (doc.pixels[i] > 0) n++;
    return n;
  };

  let doc = blank();
  stroke(doc, {}, [[5, 5]]);
  check(painted(doc) === 1 && doc.sample(5, 5).join() === '200,100,50,255', 'a size 1 brush paints exactly one pixel', doc.sample(5, 5).join());
  doc = blank();
  stroke(doc, { size: 4 }, [[10, 10]]);
  check(painted(doc) === 16, 'a size 4 square paints 16 pixels', painted(doc));
  const round = [...brushMask('round', 3)].join('');
  check(round === '010111010', 'a size 3 round brush is a plus shape', round);
  const soft = brushMask('soft', 9);
  check(soft[4 * 9 + 4] === 1 && soft[0] === 0 && [...soft].some((v) => v > 0.1 && v < 0.9), 'a soft brush is solid in the middle and fades out');

  doc = blank();
  stroke(doc, {}, [[0, 0], [31, 20]]);
  check(painted(doc) === 32, 'a fast drag leaves no gaps', painted(doc));
  doc = blank();
  stroke(doc, { size: 8 }, [[-20, -20], [-3, -3], [40, 40]]);
  check(painted(doc) > 0, 'painting off the edge is fine');

  doc = blank(255);
  stroke(doc, { brush: 'soft', size: 15 }, [[16, 16]]);
  const once = doc.sample(23, 16)[0];
  stroke(doc, { brush: 'soft', size: 15, colour: [200, 100, 50] }, [[16, 16]]);
  const twice = doc.sample(23, 16)[0];
  doc = blank(255);
  stroke(doc, { brush: 'soft', size: 15 }, [[16, 16], [16, 16], [16, 16], [16, 16]]);
  check(doc.sample(23, 16)[0] === once, 'going over a soft edge in one stroke doesn\'t build up', once);
  check(twice < once, 'a second stroke does', `${once} to ${twice}`);

  doc = blank(255);
  stroke(doc, { mode: 'erase' }, [[3, 3]]);
  check(doc.sample(3, 3).join() === '255,255,255,0', 'erasing makes a pixel transparent and keeps its colour', doc.sample(3, 3).join());
  doc = blank();
  stroke(doc, { brush: 'soft', size: 9 }, [[10, 10]]);
  const edge = doc.sample(13, 10);
  check(edge[0] === 200 && edge[1] === 100 && edge[2] === 50 && edge[3] > 0 && edge[3] < 255, 'a soft edge on clear pixels keeps its true colour', edge.join());

  doc = blank(255);
  const original = doc.pixels.slice();
  stroke(doc, { size: 3 }, [[4, 4], [9, 9]]);
  const first = doc.pixels.slice();
  stroke(doc, { mode: 'erase', size: 5 }, [[8, 8]]);
  const second = doc.pixels.slice();
  doc.undo();
  check(doc.pixels.every((v, i) => v === first[i]), 'undo goes back exactly');
  doc.undo();
  check(doc.pixels.every((v, i) => v === original[i]) && !doc.unsaved, 'all the way to the start, which counts as unchanged');
  doc.redo();
  doc.redo();
  check(doc.pixels.every((v, i) => v === second[i]) && doc.unsaved, 'redo comes back exactly');
  doc.undo();
  stroke(doc, {}, [[20, 20]]);
  check(!doc.canRedo, 'a new stroke clears redo');
  doc.markSaved();
  check(!doc.unsaved, 'saving clears the unsaved mark');
  doc.undo();
  check(doc.unsaved, 'undoing past a save counts as a change');
  // Mirroring.
  const lit = (d) => {
    const out = [];
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) if (d.sample(x, y)[3] > 0) out.push(`${x},${y}`);
    return out.join(' ');
  };
  doc = blank();
  stroke(doc, { mirrorX: true }, [[5, 9]]);
  check(lit(doc) === '5,9 26,9', 'Mirror X repeats a pixel left to right', lit(doc));
  doc = blank();
  stroke(doc, { mirrorY: true }, [[5, 9]]);
  check(lit(doc) === '5,9 5,22', 'Mirror Y repeats it top to bottom', lit(doc));
  doc = blank();
  stroke(doc, { mirrorX: true, mirrorY: true }, [[5, 9]]);
  check(lit(doc) === '5,9 26,9 5,22 26,22', 'both give four copies', lit(doc));
  const isMirrored = (d, flip) => {
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const [mx, my] = flip(x, y);
        if (d.sample(x, y).join() !== d.sample(mx, my).join()) return false;
      }
    }
    return true;
  };
  for (const [brush, size] of [['square', 4], ['square', 5], ['round', 6], ['round', 7], ['soft', 8], ['soft', 11]]) {
    doc = blank();
    stroke(doc, { brush, size, mirrorX: true }, [[4, 3], [11, 17], [13, 6]]);
    check(isMirrored(doc, (x, y) => [31 - x, y]), `a size ${size} ${brush} brush mirrors exactly`);
  }
  doc = blank();
  stroke(doc, { size: 6, mirrorY: true, brush: 'soft' }, [[9, 4], [20, 11]]);
  check(isMirrored(doc, (x, y) => [x, 31 - y]), 'so does Mirror Y');
  doc = blank(255);
  stroke(doc, { mode: 'erase', size: 3, mirrorX: true }, [[4, 4]]);
  check(doc.sample(4, 4)[3] === 0 && doc.sample(27, 4)[3] === 0, 'erasing is mirrored too');
  doc = blank();
  stroke(doc, { brush: 'soft', size: 9, mirrorX: true }, [[14, 10]]);
  const onLine = doc.sample(16, 10)[3];
  const single = blank();
  stroke(single, { brush: 'soft', size: 9 }, [[14, 10]]);
  check(onLine === single.sample(15, 10)[3] || onLine >= single.sample(16, 10)[3], 'copies meeting on the centre line don\'t double up', onLine);
  doc = blank(255);
  stroke(doc, { size: 2, mirrorX: true, mirrorY: true }, [[3, 3], [8, 8]]);
  const mirroredStroke = doc.pixels.slice();
  doc.undo();
  check(doc.pixels.every((v) => v === 255) && !doc.canUndo, 'a mirrored stroke is one undo step');
  doc.redo();
  check(doc.pixels.every((v, i) => v === mirroredStroke[i]), 'and one redo');

  doc = blank(255);
  stroke(doc, { colour: [255, 255, 255] }, [[1, 1]]);
  check(!doc.canUndo, 'a stroke that changes nothing isn\'t an undo step');
}

// --- The page ---
const profile = newProfile();
const { page, problems, stop } = await start({ profile, width: 1400, height: 900 });
await openFolder(page, path.join(root, 'models'));
await page.waitForFunction(() => window.skinStudio.state.mesh);

const select = (id, body) => page.evaluate(async (i, b) => {
  const s = window.skinStudio;
  await s.selectCharacter(s.state.catalog.characters.find((c) => c.id === i), { body: b });
}, id, body);
const pixel = (x, y) => page.evaluate((px, py) => window.skinStudio.painter.doc.sample(px, py), x, y);
const hashOf = async (selector) => {
  const box = await (await page.$(selector)).boundingBox();
  return crypto.createHash('md5').update(await page.screenshot({ clip: box })).digest('hex');
};
// What the canvas itself drew, without the status line laid over it.
const canvasHash = async () => {
  await wait(120);
  const drawn = await page.$eval('#paintCanvas', (c) => c.toDataURL());
  return crypto.createHash('md5').update(drawn).digest('hex');
};
const docHash = () => page.evaluate(() => window.skinStudio.painter.doc.pixels.reduce((h, v) => (h * 31 + v) | 0, 7));
// Where a texture pixel is on the page.
const at = (x, y) => page.evaluate((px, py) => {
  const { view } = window.skinStudio.painter;
  const box = view.canvas.getBoundingClientRect();
  return { x: box.left + view.offset.x + (px + 0.5) * view.zoom, y: box.top + view.offset.y + (py + 0.5) * view.zoom };
}, x, y);
const drag = async (points) => {
  const [first, ...rest] = await Promise.all(points.map(([x, y]) => at(x, y)));
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of rest) await page.mouse.move(point.x, point.y, { steps: 6 });
  await page.mouse.up();
  await wait(60);
};
const setSize = (size) => page.$eval('#brushSize', (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}, size);

await select('XochisCustomBFT_AardMara', 'female');
await wait(300);
check(!await page.$eval('#paintOpen', (b) => b.disabled), 'Paint is ready once a model is selected');
const previewBefore = await hashOf('#canvasBox');
await page.click('#paintOpen');
await page.waitForFunction(() => window.skinStudio.painter.isOpen);
await wait(300);

const layout = await page.evaluate(() => {
  const shown = (id) => !document.getElementById(id).hidden;
  const view = document.getElementById('paintBox').getBoundingClientRect();
  const stage = document.getElementById('stage').getBoundingClientRect();
  const right = document.getElementById('right').getBoundingClientRect();
  const preview = document.getElementById('canvasBox').getBoundingClientRect();
  return {
    tools: shown('paintBar') && !shown('toolbar'),
    colours: shown('paintColours') && !shown('browse'),
    textureInCentre: view.left >= stage.left && view.right <= stage.right && view.width > 500,
    previewOnRight: preview.left >= right.left && preview.right <= right.right + 1 && preview.height > 200,
    inSlot: document.getElementById('canvasBox').parentElement.id,
    swatches: document.querySelectorAll('#palette .swatch').length,
  };
});
check(layout.tools && layout.colours, 'paint mode shows its tools and colours', JSON.stringify(layout));
check(layout.textureInCentre, 'the texture is in the centre');
const keys = await page.evaluate(() => {
  const rect = (id) => document.getElementById(id).getBoundingClientRect();
  const [left, palette, recent, tools, list] = ['left', 'palette', 'recentColours', 'paintBar', 'paintKeys'].map(rect);
  const pane = document.getElementById('paintColours');
  return {
    order: palette.bottom <= recent.top && recent.bottom <= tools.top && tools.bottom <= list.top,
    inLeft: [tools, list].every((r) => r.left >= left.left && r.right <= left.right),
    centreFree: !document.getElementById('stage').querySelector('button:not([hidden]):not(#paintOpen):not(#welcomeOpen)')?.closest('#paintBox'),
    fits: pane.scrollHeight <= pane.clientHeight + 1,
    text: document.getElementById('paintKeys').textContent.replace(/\s+/g, ' '),
    tall: [left.height, pane.scrollHeight],
  };
});
check(keys.order, 'the buttons sit under the palette, with the shortcuts under them');
const rowHeights = await page.$$eval('#paintBar .seg', (rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
check(new Set(rowHeights).size === 1, 'the button rows are all one line tall', rowHeights.join(', '));
check(keys.inLeft, 'all in the left pane');
check(keys.fits, 'and it all fits with no scrolling', keys.tall.join(' of '));
await page.setViewport({ width: 1280, height: 720 });
await wait(250);
const laptop = await page.evaluate(() => {
  const pane = document.getElementById('paintColours');
  return { fits: pane.scrollHeight <= pane.clientHeight + 1, sizes: [pane.scrollHeight, pane.clientHeight] };
});
check(laptop.fits, 'even in a 1280 x 720 window', laptop.sizes.join(' of '));
await page.setViewport({ width: 1400, height: 900 });
await wait(250);
await page.click('#paintFit');
for (const word of ['Paint', 'Erase', 'Pick colour', 'Move', 'Brush size', 'Mirror X', 'Mirror Y', 'Undo', 'Redo', 'Pixel grid', 'UV lines', 'Zoom', 'Fit']) {
  check(keys.text.includes(word), `they list ${word}`);
}
check(layout.previewOnRight && layout.inSlot === 'previewSlot', 'the live preview is on the right');
await page.screenshot({ path: process.argv[2] ?? '/tmp/skinstudio-paint.png' });

// Painting with the mouse, and the model following.
const previewStart = await hashOf('#canvasBox');
await page.click('#palette .swatch[title="#e63b2e"]');
const red = await page.$eval('#paintHex', (n) => n.textContent);
check(red === '#e63b2e', 'clicking the palette sets the colour', red);
await setSize(12);
await drag([[100, 110], [150, 110], [150, 150], [100, 150]]);
const painted = await pixel(125, 110);
check(painted.join() === '230,59,46,255', 'a real drag paints the texture', painted.join());
check((await pixel(125, 130))[0] !== 230, 'and only where the brush went');
await wait(200);
const previewAfter = await hashOf('#canvasBox');
check(previewAfter !== previewStart, 'the 3D preview changes by itself as you paint');
check(!await page.$eval('#paintUndo', (b) => b.disabled) && await page.$eval('#paintRedo', (b) => b.disabled), 'Undo is ready, Redo isn\'t');
check(await page.$$eval('#recentColours .swatch', (s) => s.length) === 1, 'the colour joins Recent');

// Guides never touch the texture.
const beforeGuides = await docHash();
await page.mouse.move(5, 5);
const zoomAtFit = await page.evaluate(() => window.skinStudio.painter.view.zoom);
const canvasPlain = await canvasHash();
await page.click('#paintUv');
await page.mouse.move(5, 5);
const canvasUv = await canvasHash();
await page.click('#paintGrid');
await page.mouse.move(5, 5);
const canvasBoth = await canvasHash();
check(canvasUv !== canvasPlain, 'UV lines show on the texture');
const zoomWithGrid = await page.evaluate(() => window.skinStudio.painter.view.zoom);
check(canvasBoth !== canvasUv && zoomWithGrid >= 3, 'so does the pixel grid', `fit ${zoomAtFit * 100}%, grid at ${zoomWithGrid * 100}%`);
check(zoomAtFit >= 3, 'the texture gets the full height, at 300% here', `${zoomAtFit * 100}%`);
check(await docHash() === beforeGuides, 'and neither touches the texture');
await page.screenshot({ path: `${process.argv[2] ?? '/tmp/skinstudio-paint.png'}.guides.png` });
await page.click('#paintGrid');
await page.click('#paintUv');
await page.click('#paintFit');

// The colour sample picker.
await page.click('#tool-pick');
const pickSpot = await at(125, 130);
await page.mouse.click(pickSpot.x, pickSpot.y);
await wait(60);
const sampled = await page.$eval('#paintHex', (n) => n.textContent);
const expected = (await pixel(125, 130)).slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
check(sampled === `#${expected}`, 'Pick colour samples the texture', sampled);
check(await page.$eval('#tool-paint', (b) => b.classList.contains('active')), 'and goes straight back to painting');
await page.click('#palette .swatch[title="#f7d038"]');
await page.keyboard.down('Alt');
const altSpot = await at(125, 110);
await page.mouse.click(altSpot.x, altSpot.y);
await page.keyboard.up('Alt');
await wait(60);
check(await page.$eval('#paintHex', (n) => n.textContent) === '#e63b2e', 'Alt + click picks too, without painting');

// Each brush, erase, undo and redo.
await page.click('#brush-round');
await setSize(9);
await drag([[60, 60]]);
const roundCorner = await pixel(56, 56);
check((await pixel(60, 60)).join() === '230,59,46,255' && roundCorner[0] !== 230, 'Round leaves the corners', roundCorner.join());
await page.click('#brush-soft');
await setSize(21);
await page.click('#palette .swatch[title="#ffffff"]');
await drag([[30, 200]]);
const softCentre = await pixel(30, 200);
const softEdge = await pixel(39, 200);
check(softCentre[0] === 255 && softCentre[1] === 255, 'Soft is solid in the middle', softCentre.join());
check(softEdge[1] > 0 && softEdge[1] < 255, 'with a blended edge', softEdge.join());
await page.click('#tool-erase');
await page.click('#brush-square');
await setSize(6);
await drag([[200, 200]]);
check((await pixel(200, 200))[3] === 0, 'Erase clears to transparent', (await pixel(200, 200)).join());
const beforeUndo = await docHash();
await page.click('#paintUndo');
await wait(60);
check((await pixel(200, 200))[3] === 255, 'the Undo button works');
await page.keyboard.down('Control');
await page.keyboard.press('y');
await page.keyboard.up('Control');
await wait(60);
check(await docHash() === beforeUndo, 'Ctrl + Y redoes');
await page.keyboard.down('Control');
await page.keyboard.press('z');
await page.keyboard.up('Control');
await wait(60);
check((await pixel(200, 200))[3] === 255, 'Ctrl + Z undoes');
await page.keyboard.press('b');
await page.keyboard.press(']');
const keyed = await page.$eval('#brushSizeValue', (n) => n.textContent);
check(keyed === '7', 'keys change the tool and size', keyed);

// Zoom and moving the texture.
await page.click('#paintFit');
await wait(60);
const spot = await at(40, 40);
await page.mouse.move(spot.x, spot.y);
const zoomBefore = await page.evaluate(() => window.skinStudio.painter.view.zoom);
await page.mouse.wheel({ deltaY: -120 });
await wait(60);
await page.mouse.wheel({ deltaY: -120 });
await wait(60);
const zoomed = await page.evaluate(({ x, y }) => {
  const { view } = window.skinStudio.painter;
  return { zoom: view.zoom, under: view.texelAt({ clientX: x, clientY: y }) };
}, spot);
check(zoomed.zoom > zoomBefore && zoomed.under.x === 40 && zoomed.under.y === 40, 'scrolling zooms around the mouse', JSON.stringify(zoomed));
const offsetBefore = await page.evaluate(() => ({ ...window.skinStudio.painter.view.offset }));
const beforePan = await docHash();
await page.keyboard.down('Space');
await page.mouse.down();
await page.mouse.move(spot.x + 70, spot.y + 40, { steps: 3 });
await page.mouse.up();
await page.keyboard.up('Space');
await wait(60);
const offsetAfter = await page.evaluate(() => ({ ...window.skinStudio.painter.view.offset }));
check(offsetAfter.x === offsetBefore.x + 70 && offsetAfter.y === offsetBefore.y + 40 && await docHash() === beforePan, 'Space + drag moves the texture and paints nothing');
await page.mouse.move(spot.x, spot.y);
await page.mouse.down({ button: 'middle' });
await page.mouse.move(spot.x - 30, spot.y, { steps: 2 });
await page.mouse.up({ button: 'middle' });
await wait(40);
check((await page.evaluate(() => window.skinStudio.painter.view.offset.x)) === offsetAfter.x - 30, 'so does a middle-button drag');
await page.click('#paintFit');

// Every shortcut has a button too.
const zoomNow = () => page.evaluate(() => window.skinStudio.painter.view.zoom);
const startZoom = await zoomNow();
await page.click('#zoomIn');
await wait(40);
const zoomedIn = await zoomNow();
check(zoomedIn > startZoom, 'the Zoom + button zooms in', `${startZoom} to ${zoomedIn}`);
const middleTexel = await page.evaluate(() => {
  const { view } = window.skinStudio.painter;
  const box = view.canvas.getBoundingClientRect();
  return view.texelAt({ clientX: box.left + view.canvas.clientWidth / 2, clientY: box.top + view.canvas.clientHeight / 2 });
});
await page.click('#zoomIn');
await wait(40);
const stillMiddle = await page.evaluate(() => {
  const { view } = window.skinStudio.painter;
  const box = view.canvas.getBoundingClientRect();
  return view.texelAt({ clientX: box.left + view.canvas.clientWidth / 2, clientY: box.top + view.canvas.clientHeight / 2 });
});
check(Math.abs(stillMiddle.x - middleTexel.x) <= 1 && Math.abs(stillMiddle.y - middleTexel.y) <= 1, 'around the middle of the view');
await page.click('#zoomOut');
await page.click('#zoomOut');
await wait(40);
check(await zoomNow() === startZoom, 'the Zoom − button zooms back out');

// A guide button should never look like it did nothing.
await page.evaluate(() => { const { view } = window.skinStudio.painter; view.zoomBy(-1); });
await wait(40);
const lowZoom = await zoomNow();
await page.click('#paintGrid');
await wait(60);
check(lowZoom < 3 && await zoomNow() === 3, 'Pixel grid zooms in far enough to show', `${lowZoom * 100}% to ${(await zoomNow()) * 100}%`);
await page.click('#paintGrid');
await wait(40);
check(await zoomNow() === 3, 'turning it off leaves the zoom alone');
await page.click('#paintFit');

const sizeBefore = Number(await page.$eval('#brushSizeValue', (n) => n.textContent));
await page.click('#brushBigger');
await page.click('#brushBigger');
check(Number(await page.$eval('#brushSizeValue', (n) => n.textContent)) === sizeBefore + 2, 'the + button grows the brush');
check(Number(await page.$eval('#brushSize', (n) => n.value)) === sizeBefore + 2, 'and the slider follows');
await page.click('#brushSmaller');
check(Number(await page.$eval('#brushSizeValue', (n) => n.textContent)) === sizeBefore + 1, 'the − button shrinks it');
await setSize(1);
await page.click('#brushSmaller');
check(await page.$eval('#brushSizeValue', (n) => n.textContent) === '1', 'it stops at 1');
await setSize(64);
await page.click('#brushBigger');
check(await page.$eval('#brushSizeValue', (n) => n.textContent) === '64', 'and at 64');
await setSize(7);

const guideState = () => page.evaluate(() => ['paintGrid', 'paintUv'].map((id) => {
  const button = document.getElementById(id);
  return [button.tagName, button.classList.contains('active'), button.getAttribute('aria-pressed')].join();
}).join(' '));
check(await guideState() === 'BUTTON,false,false BUTTON,false,false', 'Pixel grid and UV lines are buttons, off to start', await guideState());
await page.click('#paintGrid');
await page.click('#paintUv');
check(await guideState() === 'BUTTON,true,true BUTTON,true,true', 'and light up when on', await guideState());
await page.keyboard.press('g');
await page.keyboard.press('u');
check(await guideState() === 'BUTTON,false,false BUTTON,false,false', 'their keys do the same', await guideState());

// Mirroring, with the buttons and a real drag.
const mirrorState = () => page.evaluate(() => ['mirrorX', 'mirrorY'].map((id) => {
  const button = document.getElementById(id);
  return `${button.classList.contains('active')},${button.getAttribute('aria-pressed')}`;
}).join(' '));
check(await mirrorState() === 'false,false false,false', 'Mirror X and Y start off', await mirrorState());
await page.click('#paintFit');
await page.click('#tool-paint');
await page.click('#brush-square');
await setSize(4);
await page.click('#palette .swatch[title="#4caf50"]');
const noMirrorHash = await canvasHash();
const docBeforeLine = await docHash();
await page.click('#mirrorX');
check(await mirrorState() === 'true,true false,false', 'the Mirror X button lights up', await mirrorState());
await page.mouse.move(5, 5);
check(await canvasHash() !== noMirrorHash, 'and shows its line on the texture');
check(await docHash() === docBeforeLine, 'without touching the texture');
await drag([[30, 40], [50, 60]]);
const mirroredPixel = await pixel(255 - 40, 50);
check((await pixel(40, 50)).slice(0, 3).join() === '76,175,80' && mirroredPixel.slice(0, 3).join() === '76,175,80', 'a real drag paints both sides', mirroredPixel.join());
await page.click('#paintUndo');
await wait(60);
check((await pixel(255 - 40, 50)).slice(0, 3).join() !== '76,175,80' && (await pixel(40, 50)).slice(0, 3).join() !== '76,175,80', 'Undo takes back both at once');
await page.click('#paintRedo');
await wait(60);
await page.click('#mirrorY');
await drag([[20, 90]]);
const fourWay = await Promise.all([[20, 90], [235, 90], [20, 165], [235, 165]].map(([x, y]) => pixel(x, y)));
check(fourWay.every((p) => p.slice(0, 3).join() === '76,175,80'), 'with both on, one click paints four copies');
await page.keyboard.press('y');
await page.keyboard.press('x');
check(await mirrorState() === 'false,false false,false', 'the X and Y keys turn them off', await mirrorState());
await drag([[10, 200]]);
check((await pixel(245, 200)).slice(0, 3).join() !== '76,175,80', 'and strokes stop mirroring');
await page.keyboard.down('Control');
await page.keyboard.press('y');
await page.keyboard.up('Control');
check(await mirrorState() === 'false,false false,false', 'Ctrl + Y stays Redo', await mirrorState());
await setSize(7);

// The Move tool, with an ordinary left drag.
await page.click('#tool-move');
check(await page.$eval('#tool-move', (b) => b.classList.contains('active')), 'Move is a tool button');
check(await page.$eval('#paintCanvas', (c) => c.style.cursor) === 'grab', 'the cursor shows it');
const moveFrom = await page.evaluate(() => ({ ...window.skinStudio.painter.view.offset }));
const beforeMove = await docHash();
const moveSpot = await at(120, 120);
await page.mouse.move(moveSpot.x, moveSpot.y);
await page.mouse.down();
await page.mouse.move(moveSpot.x + 50, moveSpot.y + 25, { steps: 4 });
await page.mouse.up();
await wait(60);
const moveTo = await page.evaluate(() => ({ ...window.skinStudio.painter.view.offset }));
check(moveTo.x === moveFrom.x + 50 && moveTo.y === moveFrom.y + 25 && await docHash() === beforeMove, 'dragging with Move moves the texture and paints nothing');
await page.keyboard.press('f');
await wait(60);
check((await page.evaluate(() => window.skinStudio.painter.view.offset.x)) !== moveTo.x, 'the F key fits it again');
await page.keyboard.press('m');
check(await page.$eval('#tool-move', (b) => b.classList.contains('active')), 'the M key picks Move');
await page.keyboard.press('-');
await wait(40);
check(await zoomNow() < startZoom, 'the - key zooms out');
await page.keyboard.press('=');
await wait(40);
check(await zoomNow() === startZoom, 'the + key zooms in');
await page.click('#tool-paint');
check(await page.$eval('#paintCanvas', (c) => c.style.cursor) === '', 'Paint brings the brush cursor back');
await page.click('#paintFit');

// Moving the model in the live preview.
const camera = () => page.evaluate(() => {
  const { position } = window.skinStudio.viewer.camera;
  return [position.x, position.y, position.z];
});
const box = await (await page.$('#view')).boundingBox();
const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
const cameraStart = await camera();
await page.mouse.move(middle.x, middle.y);
await page.mouse.down();
await page.mouse.move(middle.x + 60, middle.y + 10, { steps: 4 });
await page.mouse.up();
await wait(60);
const turned = await camera();
check(turned.join() !== cameraStart.join(), 'dragging in the preview turns the model');
const distance = (c) => Math.hypot(c[0], c[1] - 0.55, c[2]);
await page.mouse.wheel({ deltaY: 240 });
await wait(120);
check(distance(await camera()) > distance(turned) + 0.01, 'scrolling in the preview zooms it');
await page.mouse.move(middle.x, middle.y);
await page.mouse.down({ button: 'right' });
await page.mouse.move(middle.x + 30, middle.y + 20, { steps: 3 });
await page.mouse.up({ button: 'right' });
await wait(60);
const target = await page.evaluate(() => window.skinStudio.viewer.controls.target.toArray());
check(target.join() !== '0,0.55,0', 'right-dragging moves it', target.map((v) => v.toFixed(2)).join());
await page.evaluate(() => {
  const { viewer } = window.skinStudio;
  viewer.controls.target.set(0, 0.55, 0);
  viewer.view('front');
});

const smallWidth = (await page.$('#canvasBox').then((n) => n.boundingBox())).width;
await page.click('#previewBig');
await wait(250);
const bigWidth = (await page.$('#canvasBox').then((n) => n.boundingBox())).width;
check(bigWidth > smallWidth * 1.8, 'Enlarge preview makes it much bigger', `${Math.round(smallWidth)} to ${Math.round(bigWidth)}`);
const textureFits = () => page.evaluate(() => {
  const { view, doc } = window.skinStudio.painter;
  const { clientWidth, clientHeight } = view.canvas;
  return view.offset.x >= 0 && view.offset.y >= 0
    && view.offset.x + doc.width * view.zoom <= clientWidth && view.offset.y + doc.height * view.zoom <= clientHeight;
});
check(await textureFits(), 'the whole texture stays on screen');
await page.screenshot({ path: `${process.argv[2] ?? '/tmp/skinstudio-paint.png'}.big.png` });
check(await page.$eval('#previewBig', (b) => b.textContent) === 'Shrink preview', 'the button then shrinks it');
await page.click('#previewBig');
await wait(250);
check(Math.abs((await page.$('#canvasBox').then((n) => n.boundingBox())).width - smallWidth) < 2, 'back to the size it was');
check(await textureFits(), 'with the texture still on screen');

// Save as.
check(await page.$eval('#paintUnsaved', (n) => !n.hidden), 'unsaved changes are pointed out');
await page.evaluate(() => {
  window.saved = null;
  window.showSaveFilePicker = async ({ suggestedName }) => ({
    createWritable: async () => ({
      write: async (bytes) => { window.saved = { name: suggestedName, bytes: [...bytes] }; },
      close: async () => {},
    }),
  });
});
await page.click('#paintSave');
await wait(100);
check(await page.$eval('#saveDialog', (d) => d.open), 'Save as asks for a name');
await page.$eval('#saveName', (n) => { n.value = ''; });
await page.type('#saveName', 'My: Paint/Job');
await page.click('#saveConfirm');
await page.waitForFunction(() => window.saved, { timeout: 5000 });
await wait(200);
const saved = await page.evaluate(() => window.saved);
check(saved.name === 'My PaintJob.png', 'it saves a PNG under a safe name', saved.name);
const savedBytes = Uint8Array.from(saved.bytes);
const decoded = PNG.sync.read(Buffer.from(savedBytes));
const docPixels = await page.evaluate(() => [...window.skinStudio.painter.doc.pixels]);
check(decoded.width === 256 && Buffer.compare(decoded.data, Buffer.from(docPixels)) === 0, 'the file is exactly what was painted');
check(colourOf(savedBytes).kind === 'srgb', 'as plain sRGB');
check(await page.$eval('#paintUnsaved', (n) => n.hidden), 'and nothing is unsaved now');
check(await page.$eval('#paintTitle', (n) => n.textContent) === 'My: Paint/Job', 'the title follows the name');

// Painting on after saving, then closing.
await page.keyboard.press('b');
await drag([[20, 20]]);
check(await page.$eval('#paintUnsaved', (n) => !n.hidden), 'painting again marks it unsaved');
let asked = null;
const answer = (accept) => { page.once('dialog', async (d) => { asked = d.message(); await (accept ? d.accept() : d.dismiss()); }); };
answer(false);
await page.click('#paintClose');
await wait(150);
check(/without saving/.test(asked) && await page.evaluate(() => window.skinStudio.painter.isOpen), 'closing with unsaved work asks first, and No stays', asked);
answer(true);
await page.click('#paintClose');
await page.waitForFunction(() => !window.skinStudio.painter.isOpen);
await wait(400);
const closed = await page.evaluate(() => {
  const { state } = window.skinStudio;
  return {
    inStage: document.getElementById('canvasBox').parentElement.id,
    toolbar: !document.getElementById('toolbar').hidden,
    list: !document.getElementById('browse').hidden,
    bar: !document.getElementById('paintColours').hidden,
    skin: state.skin?.name,
    custom: [...document.querySelectorAll('#skins .tile span')].map((n) => n.textContent),
  };
});
check(closed.inStage === 'stage' && closed.toolbar && closed.list && !closed.bar, 'closing puts everything back', JSON.stringify(closed).slice(0, 80));
check(closed.skin === 'My: Paint/Job' && closed.custom.includes('My: Paint/Job'), 'the saved skin is selected, in Your skins');
const exactly = await page.evaluate(() => [...window.skinStudio.state.skin.png]);
check(Buffer.compare(Buffer.from(exactly), Buffer.from(savedBytes)) === 0, 'and the discarded strokes aren\'t in it');
const mara = await page.evaluate(async () => {
  const { state } = window.skinStudio;
  const skin = state.packSkins.get(state.skin.meta.uvLayout).find((p) => p.character === state.character);
  return [...await skin.texture.read()];
});
const maraFile = path.join(root, 'models/XochisCustomBFT/42/media/textures/Clothes/Furry_XochisCustomBFT_FemaleAardMara.png');
check(Buffer.compare(Buffer.from(mara), fs.readFileSync(maraFile)) === 0, 'the pack\'s own texture is left exactly as it was');
const metaSaved = await page.evaluate(() => window.skinStudio.state.skin.meta);
check(metaSaved.name === 'My: Paint/Job' && metaSaved.characterName === 'Mara' && metaSaved.fitsBodies.length === 2, 'it stays linked to its model', metaSaved.characterName);
const previewClosed = await hashOf('#canvasBox');
check(previewClosed !== previewBefore, 'the main view shows the new skin');

// An untouched skin survives the trip exactly, transparency and all.
await select('VanillaHumans_Human', 'female');
await wait(300);
const roundTrip = await page.evaluate(async () => {
  const s = window.skinStudio;
  const before = await s.state.skin.texture.read();
  document.getElementById('paintOpen').click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { before: [...before], after: [...s.painter.png()] };
});
const untouched = PNG.sync.read(Buffer.from(roundTrip.before));
const reloaded = PNG.sync.read(Buffer.from(Uint8Array.from(roundTrip.after)));
const clear = untouched.data.filter((v, i) => i % 4 === 3 && v === 0).length;
check(Buffer.compare(untouched.data, reloaded.data) === 0 && clear > 1000, 'opening a skin with clear areas changes no pixel', `${clear} clear pixels`);
check(await page.evaluate(() => !window.skinStudio.painter.unsaved), 'and doesn\'t count as a change');
await page.click('#paintClose');
await page.waitForFunction(() => !window.skinStudio.painter.isOpen);

// After a reload the skin's still there, and can be painted again.
await page.reload();
await page.waitForFunction(() => window.skinStudio?.state.mesh && window.skinStudio.state.catalog);
const back = await page.evaluate(async () => {
  const s = window.skinStudio;
  await s.selectCharacter(s.state.catalog.characters.find((c) => c.id === 'XochisCustomBFT_AardMara'), { body: 'female' });
  return s.state.customSkins.map((k) => k.name);
});
check(back.includes('My: Paint/Job'), 'a painted skin is still there after a reload', back.join(', '));
await page.evaluate(async () => {
  const s = window.skinStudio;
  await s.selectSkin(s.state.customSkins.find((k) => k.name === 'My: Paint/Job'));
});
await wait(200);
await page.click('#paintOpen');
await page.waitForFunction(() => window.skinStudio.painter.isOpen);
await wait(200);
check((await pixel(125, 110)).join() === '230,59,46,255', 'and opens with its paint on it', (await pixel(125, 110)).join());
await page.click('#paintClose');
await page.waitForFunction(() => !window.skinStudio.painter.isOpen);
await wait(200);
await page.evaluate(() => {
  window.saved = null;
  window.showSaveFilePicker = async ({ suggestedName }) => ({
    createWritable: async () => ({
      write: async (bytes) => { window.saved = { name: suggestedName, bytes: [...bytes] }; },
      close: async () => {},
    }),
  });
  document.getElementById('skinAuthor').value = 'A Painter';
  document.getElementById('exportSkin').click();
});
await page.waitForFunction(() => window.saved, { timeout: 5000 }).catch(() => {});
const zipped = await page.evaluate(() => window.saved?.bytes);
if (zipped) {
  const unpacked = unpackSkin(Uint8Array.from(zipped));
  check(unpacked.meta.characterName === 'Mara' && Buffer.compare(Buffer.from(unpacked.png), Buffer.from(savedBytes)) === 0, 'Export skin makes the usual zip from it');
} else {
  check(false, 'Export skin makes the usual zip from it', 'nothing exported');
}

check(!problems.length, 'no page or console errors', problems.slice(0, 4).join(' | '));
await stop();
fs.rmSync(profile, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
