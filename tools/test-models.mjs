// Home-made models: the studio shows what the game would draw and says what's wrong, in words
// someone with Blender can act on. Uses the models from make-test-models.mjs.
//   node tools/test-models.mjs [screenshot.png]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzlibSync } from 'fflate';
import { openFolder, root, start } from './harness.mjs';
import { makeTestModels } from './make-test-models.mjs';
import { parseFbxTree, readLayout, readMesh } from '../src/fbx.js';
import { checkModel } from '../src/modelcheck.js';
import { packSkin, unpackSkin } from '../src/skinfile.js';
import { encodePng } from '../src/pngcolour.js';

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== '' ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'skinstudio-models-'));
const homeMade = path.join(folder, 'models/HomeMade');
makeTestModels(homeMade);
fs.cpSync(path.join(root, 'models/VanillaHumans'), path.join(folder, 'models/VanillaHumans'), { recursive: true });
// The same two-object model again, loose in models/ the way someone would drop in any 3D model.
fs.mkdirSync(path.join(folder, 'models/Loose'));
fs.copyFileSync(path.join(homeMade, 'media/models_X/Skinned/Clothes/HomeMade_TwoObjects.fbx'), path.join(folder, 'models/Loose/Two Parts.fbx'));
// A skin zip left beside the models rather than in skins/, as people do.
{
  const goodTree = parseFbxTree(fs.readFileSync(path.join(homeMade, 'media/models_X/Skinned/Clothes/HomeMade_Good.fbx')), unzlibSync);
  const pixels = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([30, 160, 90, 255], i);
  const meta = { format: 1, name: 'Loose Zip', uvLayout: readLayout(goodTree).layout, characterName: 'HomeMade_Good' };
  fs.writeFileSync(path.join(folder, 'models/Loose Zip.skin.zip'), packSkin(meta, encodePng(64, 64, pixels)));
}
const fbxPath = (name) => path.join(homeMade, `media/models_X/Skinned/Clothes/HomeMade_${name}.fbx`);
const tree = (name) => parseFbxTree(fs.readFileSync(fbxPath(name)), unzlibSync);

// ---- The reader, without a browser -----------------------------------------------------------

{
  const mesh = readMesh(tree('ConcaveFace'));
  let area = 0;
  for (let t = 0; t < mesh.index.length; t += 3) {
    const [a, b, c] = [mesh.index[t], mesh.index[t + 1], mesh.index[t + 2]].map((i) => [mesh.position[i * 3], mesh.position[i * 3 + 1]]);
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  // The L shape: a 1 × 1.5 plate (scaled to the 0.5–2 range it already is in) minus a 0.5 × 0.75 notch.
  check(Math.abs(area - (1.5 - 0.375)) < 1e-4, 'a concave face is cut into triangles that fill exactly its shape', area.toFixed(4));

  const lying = readMesh(tree('ArmatureParent'));
  const extent = (axis) => {
    let low = Infinity, high = -Infinity;
    for (let i = axis; i < lying.position.length; i += 3) { low = Math.min(low, lying.position[i]); high = Math.max(high, lying.position[i]); }
    return high - low;
  };
  check(extent(1) > 1.7 && extent(2) < 0.4, 'a mesh inside a turned armature stands up', `height ${extent(1).toFixed(2)}, depth ${extent(2).toFixed(2)}`);

  const good = readMesh(tree('Good'));
  const two = readMesh(tree('TwoObjects'));
  check(!good.ghost && two.ghost?.index.length === 36 * 2 * 3, 'of two objects, one is drawn and the other kept as a grey ghost', two.ghost?.index.length);
  check(readLayout(tree('TwoObjects')).polys === 72, 'the drawn one is the one with bones, Body, though Head comes first');
  const notes = checkModel(tree('Good'), good);
  check(notes.length === 0, 'a clean model gets no notes', notes.map((n) => n.text).join(' | '));
  const second = checkModel(tree('SecondUvMap'), readMesh(tree('SecondUvMap')));
  check(second.length === 1 && /"UVMap\.001" that looks right/.test(second[0].text), 'an unwrap in the second UV map is found and named');
  const dense = readMesh(tree('Dense'));
  check(dense.outline.length * 20 < dense.edges.length, 'a dense model\'s UV outline is a small part of its edges', `${dense.outline.length / 2} of ${dense.edges.length / 2}`);
}

// ---- In the page -----------------------------------------------------------------------------

const { page, problems, stop } = await start();
await openFolder(page, folder);

const status = await page.$eval('#folderStatus', (n) => n.textContent);
check(/2 unreadable models/.test(status), 'the text FBX and the one with no UVs are counted as unreadable', status);

async function show(name) {
  await page.evaluate(async (n) => {
    const { state, selectCharacter } = window.skinStudio;
    await selectCharacter(state.catalog.characters.find((c) => c.display === `HomeMade_${n}`));
  }, name);
  await new Promise((resolve) => { setTimeout(resolve, 150); });
  return page.evaluate(() => ({
    notes: [...document.querySelectorAll('#modelChecks .note')].map((n) => ({ warn: n.classList.contains('warn'), text: n.textContent })),
    ghost: !!window.skinStudio.viewer.ghost,
  }));
}

const expectations = [
  ['Good', [], false],
  ['TwoObjects', [/2 separate objects.*"Body".*"Head".*Ctrl\+J/], true],
  ['TwoMaterials', [/2 materials.*"Fur".*"Eyes"/], true],
  ['NotUnwrapped', [/isn't ready for a skin.*on top of other parts.*Smart UV Project/], false],
  ['SecondUvMap', [/"UVMap\.001"/], false],
  ['NoBones', [/no bones/], false],
  ['OwnSkeleton', [/skeleton of its own .*"Hips".*Bip01_Pelvis/], false],
  ['Dense', [/18,000 faces.*Outlines only/], false],
  ['NoUvs', [/can't be shown: it has no UV map.*unwrap/], false],
  ['TextFbx', [/can't be shown: this FBX is saved as text/], false],
];
for (const [name, patterns, ghost] of expectations) {
  const shown = await show(name);
  const texts = shown.notes.map((n) => n.text);
  const ok = texts.length === patterns.length && patterns.every((p, i) => p.test(texts[i])) && shown.ghost === ghost;
  check(ok, `${name}: ${patterns.length ? 'says what is wrong' : 'no notes'}${ghost ? ', with the other part in grey' : ''}`, ok ? '' : `${JSON.stringify(texts)} ghost ${shown.ghost}`);
}

// Turning the vanilla humans' missing bones into a note would be wrong: they're preview copies.
const human = await page.evaluate(async () => {
  const { state, selectCharacter } = window.skinStudio;
  await selectCharacter(state.catalog.characters.find((c) => c.pack.id === 'VanillaHumans'));
  return document.getElementById('modelChecks').textContent;
});
check(human === '', 'the bundled human preview models get no bones note', human);

// The test pattern fits any model and stays on while moving between models.
await show('TwoObjects');
const tile = await page.evaluateHandle(() => [...document.querySelectorAll('#skins .tile')].find((t) => t.skin?.kind === 'pattern'));
check(!!(await tile.evaluate((t) => !!t)), 'every model offers the test pattern');
await tile.evaluate((t) => t.click());
await page.waitForFunction(() => window.skinStudio.state.skin?.kind === 'pattern');
const kept = await show('Good');
check(await page.evaluate(() => window.skinStudio.state.skin?.kind === 'pattern') && !kept.ghost, 'it stays on when another model is picked');
await show('TwoObjects');
const shot = process.argv[2];
if (shot) await page.screenshot({ path: shot });

// Outlines only: far fewer UV lines on a dense model, in the guide too.
await show('Dense');
const whitePixels = () => page.evaluate(() => {
  const canvas = window.skinStudio.uvGuide();
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
  return n;
});
const all = await whitePixels();
await page.click('#uvOutline');
const outline = await whitePixels();
check(outline * 4 < all && outline > 0, 'Outlines only makes a readable UV guide of a dense model', `${outline} pixels against ${all}`);
check(await page.$eval('#showUv', (n) => n.checked), 'and turns the UV lines on');
await page.click('#paintOpen');
await page.waitForFunction(() => window.skinStudio.painter.isOpen);
check(await page.evaluate(() => window.skinStudio.state.mesh.outline.length > 0), 'Paint opens on it');
await page.click('#paintClose');
await page.waitForFunction(() => !window.skinStudio.painter.isOpen);
await page.click('#uvOutline');

// ---- Objects and views -----------------------------------------------------------------------

const panel = () => page.evaluate(() => ({
  view: window.skinStudio.state.view,
  options: [...document.getElementById('viewPick').options].map((o) => o.value),
  picker: !document.getElementById('viewRow').hidden,
  general: !document.getElementById('generalNote').hidden,
  bodies: !document.getElementById('bodyRow').hidden,
  notes: [...document.querySelectorAll('#modelChecks .note')].map((n) => n.textContent),
  triangles: window.skinStudio.state.mesh.index.length / 3,
  ghost: window.skinStudio.state.mesh.ghost ? window.skinStudio.state.mesh.ghost.index.length / 3 : 0,
}));
const choose = (display) => page.evaluate(async (d) => {
  const { state, selectCharacter } = window.skinStudio;
  await selectCharacter(state.catalog.characters.find((c) => c.display === d));
}, display);

await choose('HomeMade_Good');
let now = await panel();
check(!now.picker && now.bodies && !now.general, 'a model of one object has no object picker');

await choose('HomeMade_TwoObjects');
now = await panel();
check(now.picker && now.view === 'game' && now.options.join() === 'whole,game,part:0,part:1',
  'a mod model of two objects opens as the game draws it, with the whole model and each object to pick', `${now.view}: ${now.options}`);

await choose('Two Parts');
now = await panel();
check(now.general && !now.bodies && now.view === 'whole' && now.options.join() === 'whole,part:0,part:1' && now.ghost === 0,
  'the same file loose in models/ is a general model: whole, no game checks, no Male/Female', JSON.stringify(now).slice(0, 160));
check(now.notes.length === 0, 'and gets none of the game\'s notes', now.notes.join(' | '));
const wholeTriangles = now.triangles;

await page.evaluate(() => window.skinStudio.setView('part:1'));
now = await panel();
check(now.view === 'part:1' && now.triangles + now.ghost === wholeTriangles && now.triangles === 144,
  'picking Body shows it solid and Head in grey', `${now.triangles} + ${now.ghost}`);

// Clicking in the 3D view: the head, then the head again.
await page.evaluate(() => window.skinStudio.setView('whole'));
await page.click('#view-front');
const headAt = await page.evaluate(() => {
  const { viewer, state } = window.skinStudio;
  const box = viewer.canvas.getBoundingClientRect();
  // The middle of the screen sideways, and down the screen until the head is under the pointer.
  for (let y = box.top + 5; y < box.bottom; y += 4) {
    const corner = viewer.cornerAt(box.left + box.width / 2, y);
    if (corner !== null) return { x: box.left + box.width / 2, y, part: state.mesh.cornerPart[corner] };
  }
  return null;
});
await page.mouse.click(headAt.x, headAt.y);
await page.waitForFunction(() => window.skinStudio.state.view !== 'whole', { timeout: 5000 }).catch(() => {});
check((await panel()).view === `part:${headAt.part}` && headAt.part === 0, 'clicking the head in the 3D view picks the head', (await panel()).view);
await page.mouse.click(headAt.x, headAt.y);
await page.waitForFunction(() => window.skinStudio.state.view === 'whole', { timeout: 5000 }).catch(() => {});
check((await panel()).view === 'whole', 'clicking it again goes back to the whole model');
const dragged = await page.evaluate(() => window.skinStudio.state.view);
await page.mouse.move(headAt.x, headAt.y);
await page.mouse.down();
await page.mouse.move(headAt.x + 60, headAt.y + 10, { steps: 5 });
await page.mouse.up();
await page.click('#view-front');
check((await panel()).view === dragged, 'dragging to turn the model picks nothing');

// Paint the head on its own, save, export, then take the zip to a fresh browser.
await page.evaluate(() => window.skinStudio.setView('part:0'));
await page.click('#paintOpen');
await page.waitForFunction(() => window.skinStudio.painter.isOpen);
await page.evaluate(() => {
  const { doc } = window.skinStudio.painter;
  for (let i = 0; i < doc.pixels.length; i += 4) doc.pixels.set([200, 60, 90, 255], i);
  window.saved = null;
  window.showSaveFilePicker = async ({ suggestedName }) => ({
    createWritable: async () => ({ write: async (bytes) => { window.saved = { name: suggestedName, bytes: [...bytes] }; }, close: async () => {} }),
  });
});
check(await page.evaluate(() => window.skinStudio.state.view === 'part:0'), 'Paint opens on the picked object');
await page.click('#paintSave');
await page.$eval('#saveName', (n) => { n.value = 'Red Head'; });
await page.click('#saveConfirm');
await page.waitForFunction(() => window.saved, { timeout: 5000 });
await page.click('#paintClose');
await page.waitForFunction(() => !window.skinStudio.painter.isOpen);
await page.evaluate(() => window.skinStudio.setView('whole'));
check(await page.evaluate(() => [...document.querySelectorAll('#skins .tile span')].some((n) => n.textContent === 'Red Head')),
  'a skin painted on one object is offered on the whole model too: they share the texture');
await page.evaluate(() => window.skinStudio.setView('part:0'));
await page.evaluate(() => {
  window.saved = null;
  document.getElementById('skinAuthor').value = 'Tester';
  document.getElementById('exportSkin').click();
});
await page.waitForFunction(() => window.saved, { timeout: 5000 });
const zipBytes = await page.evaluate(() => window.saved.bytes);
const exported = unpackSkin(Uint8Array.from(zipBytes));
check(exported.meta.view === 'part:0' && exported.meta.viewName === 'Head' && exported.meta.characterName === 'Two Parts',
  'the exported zip says which object it was painted on', JSON.stringify({ view: exported.meta.view, viewName: exported.meta.viewName }));

// ---- A .skin.zip beside the models is read with the folder ---------------------------------

await choose('HomeMade_Good');
check(await page.evaluate(() => window.skinStudio.state.customSkins.some((s) => s.name === 'Loose Zip')
  && [...document.querySelectorAll('#skins .tile span')].some((n) => n.textContent === 'Loose Zip')),
'a .skin.zip lying in models/ is read with the folder and listed on its model');

// ---- Texture size in Paint --------------------------------------------------------------------

await page.evaluate(() => {
  const { state } = window.skinStudio;
  return window.skinStudio.selectSkin(state.customSkins.find((s) => s.name === 'Loose Zip'));
});
await page.click('#paintOpen');
await page.waitForFunction(() => window.skinStudio.painter.isOpen);
const sizes = await page.$$eval('#paintSize option', (options) => options.map((o) => o.value));
check(sizes.join() === '16,32,64,128,256,512,1024,2048', 'Paint offers texture sizes from 16 to 2048', sizes.join());
check(await page.$eval('#paintSize', (s) => s.value) === '64', 'starting at the texture\'s own size');
await page.select('#paintSize', '1024');
const grown = await page.evaluate(() => {
  const { doc, unsaved } = window.skinStudio.painter;
  return { width: doc.width, height: doc.height, first: [...doc.pixels.subarray(0, 4)], last: [...doc.pixels.subarray(-4)], unsaved };
});
check(grown.width === 1024 && grown.height === 1024 && grown.first.join() === '30,160,90,255' && grown.last.join() === '30,160,90,255' && grown.unsaved,
  'choosing 1024 grows the texture, keeping its pixels, and counts as a change', JSON.stringify(grown));
await page.click('#paintUndo');
check(await page.evaluate(() => window.skinStudio.painter.doc.width === 64 && !window.skinStudio.painter.unsaved), 'Undo takes the size back');
await page.select('#paintSize', '16');
check(await page.evaluate(() => window.skinStudio.painter.doc.width === 16), 'and it can shrink too');

// The brush on the model: hovering the paint canvas outlines the brush on the model as well.
const brushCount = () => page.evaluate(() => window.skinStudio.viewer.material.uniforms.brushCount.value);
const canvasBox = await page.$eval('#paintCanvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.move(canvasBox.x, canvasBox.y);
await page.mouse.move(canvasBox.x + 3, canvasBox.y + 2);
await new Promise((resolve) => { setTimeout(resolve, 100); });
check(await page.$eval('#brushOnModel', (b) => b.checked) && await brushCount() === 1, 'hovering the paint canvas outlines the brush on the model');
await page.click('#mirrorX');
await page.mouse.move(canvasBox.x + 5, canvasBox.y + 2);
await new Promise((resolve) => { setTimeout(resolve, 100); });
check(await brushCount() === 2, 'with Mirror X, both copies');
await page.click('#mirrorX');
await page.click('#brushOnModel');
await page.mouse.move(canvasBox.x + 7, canvasBox.y + 2);
await new Promise((resolve) => { setTimeout(resolve, 100); });
check(await brushCount() === 0, 'and none with the box unticked');
await page.click('#brushOnModel');
await page.evaluate(() => { window.confirm = () => true; });
await page.click('#paintClose');
await page.waitForFunction(() => !window.skinStudio.painter.isOpen);
check(await brushCount() === 0, 'closing Paint clears it');

// ---- A texture per object ---------------------------------------------------------------------

await choose('Two Parts');
check(await page.$eval('#textureRow', (r) => !r.hidden), 'a general model of several objects offers one texture per object');
await page.evaluate(() => window.skinStudio.setView('whole'));
await page.click('#tex-per');
await page.waitForFunction(() => Array.isArray(window.skinStudio.viewer.mesh.material), { timeout: 5000 }).catch(() => {});
const perWhole = await page.evaluate(() => ({
  paint: document.getElementById('paintOpen').disabled,
  materials: Array.isArray(window.skinStudio.viewer.mesh.material) ? window.skinStudio.viewer.mesh.material.length : 1,
  list: document.getElementById('skins').textContent,
}));
check(perWhole.paint && perWhole.materials === 2 && /texture of its own/.test(perWhole.list),
  'the whole model then draws each object with its own material, and Paint asks for an object', JSON.stringify(perWhole).slice(0, 120));
const tileNamed = (name) => page.evaluate((n) => [...document.querySelectorAll('#skins .tile')].find((t) => t.querySelector('span').textContent === n)?.click(), name);
await page.evaluate(() => window.skinStudio.setView('part:0'));
await tileNamed('Test pattern');
await page.evaluate(() => window.skinStudio.setView('part:1'));
await tileNamed('Red Head');
await new Promise((resolve) => { setTimeout(resolve, 200); });
const assigned = await page.evaluate(() => [...window.skinStudio.state.partSkins].map(([part, skin]) => `${part}:${skin.name}`).sort().join());
check(assigned === '0:Test pattern,1:Red Head', 'each object keeps the skin picked for it', assigned);
await page.evaluate(() => window.skinStudio.setView('part:0'));
check(await page.evaluate(() => window.skinStudio.state.skin?.name) === 'Test pattern', 'going back to an object brings its own skin back');
await page.evaluate(() => window.skinStudio.setView('whole'));
const maps = await page.evaluate(() => {
  const images = window.skinStudio.viewer.mesh.material.map((m) => m.uniforms.map.value.image);
  return { count: images.length, different: images[0] !== images[1] && images.every(Boolean) };
});
check(maps.count === 2 && maps.different, 'the whole model shows both textures at once', JSON.stringify(maps));
await page.reload();
await page.waitForFunction(() => window.skinStudio.state.mesh, { timeout: 60000 });
await choose('Two Parts');
await page.evaluate(() => window.skinStudio.setView('whole'));
const again = await page.evaluate(() => [...window.skinStudio.state.partSkins].map(([part, skin]) => `${part}:${skin.name}`).sort().join());
check(again === assigned, 'and remembers them next time', again);
await page.click('#tex-one');
await page.waitForFunction(() => !Array.isArray(window.skinStudio.viewer.mesh.material), { timeout: 5000 }).catch(() => {});
check(await page.evaluate(() => !Array.isArray(window.skinStudio.viewer.mesh.material) && !document.getElementById('paintOpen').disabled),
  'One texture goes back to a single texture for the whole model');

// ---- UV lines coloured by object -------------------------------------------------------------

await page.evaluate(() => window.skinStudio.setView('whole'));
check(await page.$eval('#uvColourRow', (r) => !r.hidden), 'with several objects shown, the UV lines can be coloured by object');
await page.click('#uvColour');
const legend = await page.$$eval('#uvLegend button', (buttons) => buttons.map((b) => [b.textContent, b.querySelector('i').style.background]));
check(legend.length === 2 && legend[0][0] === 'Head' && legend[1][0] === 'Body' && legend[0][1] !== legend[1][1],
  'with a legend of which colour is which object', JSON.stringify(legend));
const guideColours = await page.evaluate(() => {
  const canvas = window.skinStudio.uvGuide();
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
  return seen.size;
});
check(guideColours === 2, 'the UV guide comes out in the same colours', guideColours);
await page.evaluate(() => [...document.querySelectorAll('#uvLegend button')].find((b) => b.textContent === 'Body').click());
await page.waitForFunction(() => window.skinStudio.state.view === 'part:1', { timeout: 5000 }).catch(() => {});
check(await page.evaluate(() => window.skinStudio.state.view) === 'part:1', 'clicking a name in the legend picks that object');
check(await page.$eval('#uvColourRow', (r) => r.hidden), 'one object on its own needs no colours');
await page.$eval('#uvColour', (box) => box.click());

// ---- Paint: hiding the other objects, and painting on the model --------------------------------

await page.evaluate(() => window.skinStudio.setView('whole'));
await page.click('#paintOpen');
await page.waitForFunction(() => window.skinStudio.painter.isOpen);
check(await page.$eval('#paintOnModel', (b) => b.disabled) && await page.$eval('#paintOnModelHint', (h) => !h.hidden),
  'painting on the model is off for the whole of a model of several objects, and says why');
await page.evaluate(() => { window.confirm = () => true; });
await page.click('#paintClose');
await page.waitForFunction(() => !window.skinStudio.painter.isOpen);

await page.evaluate(() => window.skinStudio.setView('part:1'));
await page.evaluate(() => [...document.querySelectorAll('#skins .tile')].find((t) => t.skin?.kind === 'pattern').click());
await page.click('#paintOpen');
await page.waitForFunction(() => window.skinStudio.painter.isOpen);
check(await page.$eval('#hideOthersRow', (r) => !r.hidden) && !await page.$eval('#paintOnModel', (b) => b.disabled),
  'on one object, Paint offers hiding the others and painting on the model');
await page.click('#hideOthers');
check(await page.evaluate(() => window.skinStudio.viewer.ghost.visible === false), 'Hide the other objects hides them');
await page.click('#hideOthers');
check(await page.evaluate(() => window.skinStudio.viewer.ghost.visible === true), 'and unticking shows them again');

await page.click('#paintOnModel');
await page.click('#tool-paint');
await page.click('#brush-square');
await page.evaluate(() => { window.skinStudio.painter.setSize(3); window.skinStudio.painter.setColour('#ff00ff'); });
// A point on the body, found the way the studio finds it, then a short drag across it.
const spot = await page.evaluate(() => {
  const { viewer } = window.skinStudio;
  const box = viewer.canvas.getBoundingClientRect();
  for (let y = box.top + box.height * 0.5; y < box.bottom; y += 3) {
    const hit = viewer.surfaceAt(box.left + box.width / 2, y);
    if (hit) return { x: box.left + box.width / 2, y, ...hit };
  }
  return null;
});
const cameraBefore = await page.evaluate(() => window.skinStudio.viewer.camera.position.toArray().join());
const stepsBefore = await page.evaluate(() => window.skinStudio.painter.doc.done.length);
await page.mouse.move(spot.x, spot.y);
await page.mouse.down();
await page.mouse.move(spot.x + 12, spot.y, { steps: 4 });
await page.mouse.up();
await new Promise((resolve) => { setTimeout(resolve, 150); });
const painted = await page.evaluate(({ u, v }) => {
  const { painter, viewer } = window.skinStudio;
  const { doc } = painter;
  const [x, y] = [Math.floor(u * doc.width), Math.floor(v * doc.height)];
  return {
    pixel: [...doc.pixels.subarray((y * doc.width + x) * 4, (y * doc.width + x) * 4 + 4)].join(),
    steps: doc.done.length,
    camera: viewer.camera.position.toArray().join(),
  };
}, spot);
check(painted.pixel === '255,0,255,255' && painted.steps === stepsBefore + 1,
  'a drag on the model paints the texture where the model was pressed, as one stroke', JSON.stringify(painted));
check(painted.camera === cameraBefore, 'and the model doesn\'t turn while painting');
await page.click('#paintUndo');
check(await page.evaluate(({ u, v }) => {
  const { doc } = window.skinStudio.painter;
  const [x, y] = [Math.floor(u * doc.width), Math.floor(v * doc.height)];
  return doc.pixels[(y * doc.width + x) * 4 + 1] !== 0 || doc.pixels[(y * doc.width + x) * 4] !== 255;
}, spot), 'Undo takes the stroke off');
// Beside the model, a drag still turns it.
const beside = await page.evaluate(() => {
  const box = window.skinStudio.viewer.canvas.getBoundingClientRect();
  return { x: box.left + 15, y: box.top + 15 };
});
await page.mouse.move(beside.x, beside.y);
await page.mouse.down();
await page.mouse.move(beside.x + 80, beside.y + 10, { steps: 5 });
await page.mouse.up();
check(await page.evaluate(() => window.skinStudio.viewer.camera.position.toArray().join()) !== cameraBefore, 'a drag beside the model still turns it');
await page.click('#paintOnModel');
await page.evaluate(() => { window.confirm = () => true; });
await page.click('#paintClose');
await page.waitForFunction(() => !window.skinStudio.painter.isOpen);
check(await page.evaluate(() => !window.skinStudio.viewer.surface && window.skinStudio.viewer.ghost.visible), 'closing Paint puts the 3D view back as it was');

check(!problems.length, 'no page or console errors', problems.slice(0, 4).join(' | '));
await stop();

// A fresh browser, as on a friend's computer with the same model: importing the zip finds the model
// and the object, and shows the skin.
{
  const fresh = await start();
  await openFolder(fresh.page, folder);
  await fresh.page.evaluate(async (bytes) => {
    await window.skinStudio.importFile(new File([Uint8Array.from(bytes)], 'Red Head.skin.zip'));
  }, zipBytes);
  await new Promise((resolve) => { setTimeout(resolve, 400); });
  const back = await fresh.page.evaluate(() => ({
    character: window.skinStudio.state.character.display,
    view: window.skinStudio.state.view,
    skin: window.skinStudio.state.skin?.name,
    tiles: [...document.querySelectorAll('#skins .tile span')].map((n) => n.textContent),
    toast: document.getElementById('toast').textContent,
  }));
  check(back.character === 'Two Parts' && back.view === 'part:0' && back.skin === 'Red Head' && back.tiles.includes('Red Head'),
    'importing the zip again opens its model on its object, with the skin on', JSON.stringify(back));
  // The same for a skin from a mod model.
  await fresh.page.evaluate(async () => {
    const { state, selectCharacter } = window.skinStudio;
    await selectCharacter(state.catalog.characters.find((c) => c.display === 'HomeMade_Good'));
  });
  const meta = await fresh.page.evaluate(() => {
    const { state } = window.skinStudio;
    const v = state.character.bodies[state.body];
    return { format: 1, name: 'Plain Fox', uvLayout: v.layout, character: state.character.id, body: v.body, characterName: state.character.display };
  });
  const png = Uint8Array.from(exported.png);
  await fresh.page.evaluate(async (bytes) => {
    const { state, selectCharacter } = window.skinStudio;
    await selectCharacter(state.catalog.characters.find((c) => c.display === 'Two Parts'));
    await window.skinStudio.importFile(new File([Uint8Array.from(bytes)], 'Plain Fox.skin.zip'));
  }, [...packSkin(meta, png)]);
  await new Promise((resolve) => { setTimeout(resolve, 400); });
  const pz = await fresh.page.evaluate(() => ({ character: window.skinStudio.state.character.display, skin: window.skinStudio.state.skin?.name }));
  check(pz.character === 'HomeMade_Good' && pz.skin === 'Plain Fox', 'and a mod model\'s zip opens its own model', JSON.stringify(pz));
  check(!fresh.problems.length, 'no errors in the fresh browser', fresh.problems.slice(0, 3).join(' | '));
  await fresh.stop();
}
fs.rmSync(folder, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
