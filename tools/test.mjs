// End-to-end checks of the built page, in headless Chrome, against the real pack in models/.
//   node tools/test.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { unzlibSync, unzipSync, strFromU8 } from 'fflate';
import pngjs from 'pngjs';
import { parseFbxTree, readLayout, readMesh } from '../src/fbx.js';
import { parseSpecies, scanFolder } from '../src/catalog.js';
import { colourOf, encodePng, hdrToSrgb } from '../src/pngcolour.js';
import { packSkin, unpackSkin } from '../src/skinfile.js';
import { newProfile, openFolder, root, start } from './harness.mjs';
import { hdrSample, iccp, withChunk } from './hdr-sample.mjs';

const { PNG } = pngjs;
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== '' ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skinstudio-test-'));

const media = path.join(root, 'models/XochisCustomBFT/42/media');

// --- No browser needed ---
{
  const lua = `
    group = FurryModApi.v1.createCustomSpeciesGroup("G", "Gs");
    -- FurryModApi.v1.addSpeciesToGroup(group, "Off", "Off", "M.A", "M.B");
    FurryModApi.v1.addSpeciesToGroup(group, "A", "Ay", "M.Male", "M.Female");
    group = {};
    group.display = "Cat"
    group.name = "CatG";
    species = {};
    species.name = "Cat";
    species.display = "Tabby";
    species.maleClothing = "M.MaleCat"
    species.femaleClothing = "M.FemaleCat"
    table.insert(group.species, species);`;
  const parsed = parseSpecies(lua);
  check(parsed.length === 2 && parsed[0].group.id === 'G' && parsed[1].group.id === 'CatG'
    && parsed[1].female === 'M.FemaleCat', 'species.lua: both styles, comments ignored');

  const fbx = (name) => parseFbxTree(fs.readFileSync(path.join(media, 'models_X/Skinned/Clothes', `Furry_XochisCustomBFT_${name}.fbx`)), unzlibSync);
  check(readLayout(fbx('FemaleWolfNero')).layout === readLayout(fbx('FemaleWolfAslak')).layout, 'layout: same UVs match');
  check(readLayout(fbx('FemaleWolfBaron')).layout !== readLayout(fbx('MaleWolfBaron')).layout, 'layout: male and female Baron differ');
  const mesh = readMesh(fbx('FemaleFoxNeFen'));
  check(mesh.position.length > 0 && mesh.index.length % 3 === 0, 'the 119 MB model reads', `${mesh.index.length / 3} triangles`);
  // A mod folder opened directly has its mod.info at the top, with no parent folder to name it.
  const fakeFile = (text) => ({ open: async () => ({ text: async () => text }) });
  const direct = await scanFolder([
    { path: 'mod.info', ...fakeFile('id=Direct\nname=Direct Pack\n') },
    { path: 'media/clothing/clothingItems/Furry_MaleThing.xml', ...fakeFile('<m_MaleModel>Skinned\\Clothes\\Nope</m_MaleModel>') },
    { path: 'media/models_X/Skinned/Clothes/Furry_MaleThing.fbx', ...fakeFile('') },
  ], 'Direct');
  check(direct.characters[0]?.pack.id === 'Direct', 'mod.info at the top of the folder is found', direct.characters[0]?.pack.id);
  // Models that lie down in the file and stand up through their node, one of them very small.
  const workshop = '/media/Vol2/Games/SteamLibrary/steamapps/workshop/content/108600';
  for (const [label, file] of [
    ['a lying-down model', `${workshop}/3783570910/mods/KapkaCreatures/42/media/models_X/Skinned/Clothes/Furry_KapkaCreatures_MaleBlackBear.fbx`],
    ['a tiny lying-down model', `${workshop}/3233649075/mods/Bagel/42/media/models_X/Skinned/Clothes/Furry_Bagel_MaleBagel.fbx`],
  ]) {
    if (!fs.existsSync(file)) continue;
    const { position } = readMesh(parseFbxTree(fs.readFileSync(file), unzlibSync));
    const range = (axis) => {
      const values = position.filter((_, i) => i % 3 === axis);
      return [Math.min(...values), Math.max(...values)];
    };
    const [[xLow, xHigh], [yLow, yHigh], [zLow, zHigh]] = [range(0), range(1), range(2)];
    const shape = `${(xHigh - xLow).toFixed(2)} wide, ${(yHigh - yLow).toFixed(2)} tall, ${(zHigh - zLow).toFixed(2)} deep`;
    check(yHigh - yLow > 0.8 && yHigh - yLow < 1.3 && xHigh - xLow > yHigh - yLow - 0.3 && zHigh - zLow < 0.6 && Math.abs(yLow) < 0.05,
      `${label} stands up at the right size`, shape);
    check(Math.abs(zHigh) < Math.abs(zLow), `${label} has its back to -Z like the others`, `z ${zLow.toFixed(2)} to ${zHigh.toFixed(2)}`);
  }
  // Colour tags, on a real file from each kind.
  const plain = encodePng(2, 2, new Uint8Array(16).fill(200));
  const vanilla = new Uint8Array(fs.readFileSync(path.join(media, 'textures/Clothes/Furry_XochisCustomBFT_FemaleGoatTrag.png')));
  check(colourOf(plain).kind === 'srgb', 'colours: an untagged PNG is sRGB');
  check(colourOf(vanilla).kind === 'srgb', 'colours: a file with an sRGB tag is sRGB');
  check(colourOf(withChunk(plain, 'iCCP', iccp('ICC profile', fs.readFileSync('/usr/share/color/icc/colord/sRGB.icc')))).kind === 'srgb', 'colours: a real sRGB profile under a plain name is sRGB');
  check(colourOf(hdrSample()).kind === 'hdr', 'colours: the HDR profile is spotted');
  check(colourOf(withChunk(plain, 'cICP', [9, 16, 0, 1])).kind === 'hdr', 'colours: the newer HDR tag is spotted');
  const adobe = colourOf(withChunk(plain, 'iCCP', iccp('ICC profile', fs.readFileSync('/usr/share/color/icc/colord/AdobeRGB1998.icc'))));
  check(adobe.kind === 'other', 'colours: Adobe RGB is spotted as another colour space', adobe.label);
  check(colourOf(withChunk(plain, 'gAMA', [0, 1, 0x86, 0xa0])).kind === 'other', 'colours: a linear gamma is spotted');

  const converted = PNG.sync.read(Buffer.from(hdrToSrgb(hdrSample())));
  const at = (i) => [...converted.data.subarray(i * 4, i * 4 + 4)];
  check(at(0).join() === '254,246,237,255', 'HDR: the dull grey comes back as the near-white that was painted', at(0).join());
  check(at(130).join() === '113,78,42,255', 'HDR: the brown comes back as brown', at(130).join());
  check(at(200)[3] === 0, 'HDR: transparency is kept');
  check(colourOf(hdrToSrgb(hdrSample())).kind === 'srgb', 'HDR: the result carries no colour tag');
  const padded = new PNG({ width: 4, height: 4, colorType: 2 });
  padded.data.fill(123);
  const rgbOnly = withChunk(PNG.sync.write(padded, { colorType: 2, inputColorType: 6 }), 'iCCP', iccp('ITUR_2100_PQ_FULL', new Uint8Array(132)));
  check(PNG.sync.read(Buffer.from(hdrToSrgb(rgbOnly))).data[3] === 255, 'HDR: a PNG with no alpha channel converts too');

  const roundTrip = unpackSkin(packSkin({ name: 'x', uvLayout: 'y' }, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])));
  check(roundTrip.meta.name === 'x' && roundTrip.png.length === 11, 'skin zip round trip');
}

// --- The page ---
const profile = newProfile();
const { page, problems, stop } = await start({ profile });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = () => page.waitForFunction(() => {
  const { state } = window.skinStudio;
  return state.mesh && !document.getElementById('busy').hidden === false;
});

await openFolder(page, path.join(root, 'models'));
await settled();
const counts = await page.evaluate(() => {
  const { catalog } = window.skinStudio.state;
  return {
    xochi: catalog.characters.filter((c) => c.pack.id === 'XochisCustomBFT').length,
    layouts: catalog.layouts.size,
    packs: [...new Set(catalog.characters.flatMap((c) => [c.pack.id, ...Object.values(c.bodies).map((v) => v?.pack?.id)]))].filter(Boolean),
    errors: catalog.characters.flatMap((c) => Object.values(c.bodies)).filter((v) => v?.error).length,
  };
});
check(counts.xochi === 280 && counts.layouts >= 248 && counts.errors === 0, 'catalog', JSON.stringify(counts));
check(!counts.packs.includes('FurryMod'), 'a mod\'s build 42 id wins over its older one', counts.packs.join(', '));

const select = (name, body) => page.evaluate(async (n, b) => {
  const s = window.skinStudio;
  const character = s.state.catalog.characters.find((c) => c.id.endsWith(n));
  await s.selectCharacter(character, { body: b });
  await new Promise((resolve) => setTimeout(resolve, 150));
}, name, body);
const shown = () => page.evaluate(() => {
  const { state } = window.skinStudio;
  return {
    character: state.character.display,
    body: state.body,
    skin: state.skin?.name,
    kind: state.skin?.kind,
    tiles: [...document.querySelectorAll('#skins .tile span')].map((n) => n.textContent),
    note: document.getElementById('bodyNote').textContent,
  };
});

await select('DogAlex', 'female');
let now = await shown();
check(now.skin === now.character, 'a shared layout still opens on the character\'s own skin', now.skin);
check(now.tiles.length >= 12 && now.tiles.includes('Morgan Kinkade'), 'skins that fit are linked by layout', now.tiles.join(', '));
check(now.tiles[0] === now.character, 'own skin comes first');
check(/different UV/.test(now.note), 'male/female mismatch is pointed out', now.note);

// The game's own humans, from the pack made by tools/import-vanilla-humans.mjs.
await select('VanillaHumans_Human', 'male');
now = await shown();
check(now.tiles.length === 10 && now.tiles.includes('MaleBody01a') && now.tiles.includes('MaleBody05'), 'the male human lists its ten skins by name', now.tiles.join(', '));
await select('VanillaHumans_Human', 'female');
now = await shown();
check(now.tiles.length === 5 && now.tiles.includes('FemaleBody03'), 'the female human lists its five', now.tiles.join(', '));
check(/different UV/.test(now.note), 'human bodies are flagged as having different layouts');
const humanRefs = await page.evaluate(() => {
  const c = window.skinStudio.state.catalog.characters.find((x) => x.id === 'VanillaHumans_Human');
  return { male: c.bodies.male.modelRef, female: c.bodies.female.modelRef };
});
check(humanRefs.male === 'Skinned\\MaleBody' && humanRefs.female === 'Skinned\\FemaleBody', 'they point at the game\'s own models', JSON.stringify(humanRefs));

// Every model in the pack, drawn. An empty frame or a parse failure counts against it.
const sweep = await page.evaluate(async () => {
  const s = window.skinStudio;
  const gl = s.viewer.renderer.getContext();
  const pixels = new Uint8Array(4 * 200 * 200);
  const bad = [];
  let drawn = 0;
  for (const c of s.state.catalog.characters) {
    for (const body of ['male', 'female']) {
      if (!c.bodies[body]) continue;
      await s.selectCharacter(c, { body });
      s.viewer.render();
      const { width, height } = s.viewer.renderer.domElement;
      gl.readPixels(Math.floor(width / 2) - 100, Math.floor(height / 2) - 100, 200, 200, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let solid = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 200) solid++;
      // The base mod's "human" entry is a single hidden triangle, not a body.
      if (solid < 3000 && c.bodies[body].verts > 10) bad.push(`${c.id}/${body}: ${solid}`);
      drawn++;
    }
  }
  return { drawn, bad };
});
check(sweep.drawn >= 560 && !sweep.bad.length, 'every model draws with its skin', `${sweep.drawn} drawn ${sweep.bad.slice(0, 5)}`);

// Painting a skin: a PNG goes on the selected model.
const png = new PNG({ width: 256, height: 256 });
for (let i = 0; i < 256 * 256; i++) png.data.set([40, 200, 90, 255], i * 4);
const skinPath = path.join(tmp, 'Rex Green.png');
fs.writeFileSync(skinPath, PNG.sync.write(png));
const importBytes = (filePath, name = path.basename(filePath)) => page.evaluate(async (data, fileName) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await window.skinStudio.importFile(new File([bytes], fileName));
}, fs.readFileSync(filePath).toString('base64'), name);

await select('WolfNero', 'male');
await importBytes(skinPath);
await wait(200);
now = await shown();
check(now.kind === 'custom' && now.skin === 'Rex Green', 'PNG import applies to the selected model', now.skin);
check(await page.evaluate(() => !document.getElementById('customFields').hidden), 'name and author fields appear');
const centre = await page.evaluate(() => {
  const s = window.skinStudio;
  s.viewer.render();
  const gl = s.viewer.renderer.getContext();
  const pixel = new Uint8Array(4);
  const { width, height } = s.viewer.renderer.domElement;
  gl.readPixels(Math.floor(width / 2), Math.floor(height * 0.55), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  return [...pixel];
});
check(centre[1] > centre[0] * 2 && centre[1] > centre[2] * 1.5, 'the 3D view is wearing it', centre.join(','));

// Exporting it through the save dialog (stubbed: headless has no dialogs).
await page.evaluate(() => {
  window.saved = null;
  window.showSaveFilePicker = async ({ suggestedName }) => ({
    createWritable: async () => ({
      write: async (bytes) => { window.saved = { name: suggestedName, bytes: [...bytes] }; },
      close: async () => {},
    }),
  });
  document.getElementById('skinName').value = 'Rex: "the" Wolf';
  document.getElementById('skinAuthor').value = 'A Friend';
  document.getElementById('exportSkin').click();
});
await page.waitForFunction(() => window.saved, { timeout: 5000 });
const saved = await page.evaluate(() => window.saved);
const zipPath = path.join(tmp, saved.name);
fs.writeFileSync(zipPath, Uint8Array.from(saved.bytes));
const zip = unzipSync(fs.readFileSync(zipPath));
const meta = JSON.parse(strFromU8(zip['skin.json']));
console.log('     exported', saved.name, JSON.stringify(meta));
check(saved.name === 'Rex the Wolf.skin.zip', 'export file name is safe', saved.name);
check(meta.name === 'Rex: "the" Wolf' && meta.author === 'A Friend' && meta.characterName === 'Nero', 'export records who and what');
check(meta.clothingItem === 'XochisCustomBFT.Furry_XochisCustomBFT_MaleWolfNero' && meta.model.endsWith('MaleWolfNero'), 'export records the model');
check(meta.models.male.endsWith('MaleWolfNero') && meta.models.female.endsWith('FemaleWolfNero'), 'export records each body\'s model');
check(Buffer.compare(Buffer.from(zip['skin.png']), fs.readFileSync(skinPath)) === 0, 'export keeps the PNG byte for byte');

// A friend's skin arrives while some other model is selected.
await page.evaluate(() => { window.skinStudio.state.customSkins.length = 0; });
await select('AardMara', 'female');
await importBytes(zipPath);
await wait(300);
now = await shown();
check(now.character === 'Nero' && now.body === 'male' && now.kind === 'custom' && now.skin === meta.name, 'zip import jumps to its model', JSON.stringify(now.character));
await importBytes(zipPath);
const copies = await page.evaluate(() => window.skinStudio.state.customSkins.length);
check(copies === 1, 'importing the same zip twice keeps one copy', copies);
await select('WolfAslak', 'male');
now = await shown();
check(now.kind === 'custom', 'it follows to other models with the same layout', now.character);
await select('AardMara', 'female');
now = await shown();
check(now.kind === 'pack' && !now.tiles.includes(meta.name), 'it is not offered on a model it does not fit');

// Bad input gets a message, not a crash.
const toastAfter = async (filePath) => {
  await importBytes(filePath);
  return page.evaluate(() => document.getElementById('toast').textContent);
};
const junkZip = path.join(tmp, 'junk.zip');
fs.writeFileSync(junkZip, 'not a zip');
check(/could not be read/.test(await toastAfter(junkZip)), 'junk zip is refused');
const orphan = path.join(tmp, 'orphan.skin.zip');
fs.writeFileSync(orphan, packSkin({ ...meta, name: 'Orphan', uvLayout: 'nosuchlayout', characterName: 'Gone' }, zip['skin.png']));
check(/isn't in your models/.test(await toastAfter(orphan)), 'skin for a missing model says so');
const wide = new PNG({ width: 512, height: 256 });
const widePath = path.join(tmp, 'wide.png');
fs.writeFileSync(widePath, PNG.sync.write(wide));
check(/stretch/.test(await toastAfter(widePath)), 'non-square skin gets a warning');

// The UV guide, as the file a person gets.
const downloads = path.join(tmp, 'downloads');
fs.mkdirSync(downloads);
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
const downloadGuide = async () => {
  for (const name of fs.readdirSync(downloads)) fs.rmSync(path.join(downloads, name));
  await page.click('#downloadGuide');
  for (let i = 0; i < 50; i++) {
    const done = fs.readdirSync(downloads).find((name) => name.endsWith('.png'));
    if (done) {
      await wait(100);
      return { name: done, image: PNG.sync.read(fs.readFileSync(path.join(downloads, done))) };
    }
    await wait(100);
  }
  throw new Error('no UV guide was downloaded');
};
const checkGuide = ({ image }, size, label) => {
  check(image.width === size && image.height === size, `${label}: same size as the texture`, `${image.width} x ${image.height}`);
  let lines = 0;
  let other = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const [r, g, b, a] = image.data.subarray(i, i + 4);
    if (a === 0) continue;
    if (a === 255 && r === 255 && g === 255 && b === 255) lines++;
    else other++;
  }
  const share = lines / (image.width * image.height);
  check(other === 0, `${label}: every pixel is pure white or fully transparent`, `${other} others`);
  check(share > 0.03 && share < 0.5, `${label}: white lines, not a filled shape`, `${(share * 100).toFixed(1)}% of pixels`);
};
await page.evaluate(() => { window.skinStudio.state.customSkins.length = 0; window.skinStudio.state.skin = null; });
await select('AardMara', 'female');
await wait(200);
const packGuide = await downloadGuide();
console.log('     downloaded', packGuide.name);
checkGuide(packGuide, 256, 'UV guide for a 256 texture');
const bigSkin = new PNG({ width: 1024, height: 1024 });
bigSkin.data.fill(120);
const bigPath = path.join(tmp, 'Big.png');
fs.writeFileSync(bigPath, PNG.sync.write(bigSkin));
await importBytes(bigPath);
await wait(300);
checkGuide(await downloadGuide(), 1024, 'UV guide for a 1024 texture');

// The guide lines land on the model's UVs: every polygon corner is on a line.
const hits = await page.evaluate(() => {
  const s = window.skinStudio;
  const canvas = s.uvGuide();
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const { uv } = s.state.mesh;
  let on = 0;
  let total = 0;
  for (let i = 0; i < uv.length; i += 2) {
    const x = Math.floor(uv[i] * canvas.width);
    const y = Math.floor(uv[i + 1] * canvas.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
    total++;
    if (data[(y * canvas.width + x) * 4 + 3] === 255) on++;
  }
  return { on, total };
});
check(hits.on === hits.total && hits.total > 0, 'UV guide lines pass through every polygon corner', `${hits.on} of ${hits.total}`);

// Rotating a model.
const box = () => page.evaluate(() => {
  const b = window.skinStudio.viewer.modelBox();
  return { min: b.min.toArray(), max: b.max.toArray() };
});
const size = (b) => b.max.map((v, i) => v - b.min[i]);
const resetDisabled = () => page.$eval('#turn-reset', (b) => b.disabled);
await page.evaluate(() => localStorage.removeItem('pzSkinStudio.orientations'));
await select('KapkaCreatures_BlackBear', 'male');
const upright = await box();
check(size(upright)[1] > 0.8 && await resetDisabled(), 'a model starts as it loaded, with nothing to reset', size(upright).map((v) => v.toFixed(2)).join(' x '));
await page.click('#turn-x');
const tilted = await box();
check(Math.abs(size(tilted)[1] - size(upright)[2]) < 0.01 && Math.abs(size(tilted)[2] - size(upright)[1]) < 0.01, 'Tilt swaps height and depth', size(tilted).map((v) => v.toFixed(2)).join(' x '));
const centred = (b) => Math.abs(b.min[1]) < 0.001 && Math.abs(b.min[0] + b.max[0]) < 0.001 && Math.abs(b.min[2] + b.max[2]) < 0.001;
check(centred(tilted), 'a turned model stands on the floor at the middle of the stage');
await page.click('#turn-y');
await page.click('#turn-z');
const twisted = await box();
check(centred(twisted) && !await resetDisabled(), 'Turn and Roll keep it centred, and Reset is offered', size(twisted).map((v) => v.toFixed(2)).join(' x '));
await select('AardMara', 'female');
const other = await box();
check(size(other)[1] > 0.8 && await resetDisabled(), 'another model is not affected');
await select('KapkaCreatures_BlackBear', 'male');
const back = await box();
check(Math.abs(size(back)[0] - size(twisted)[0]) < 0.001 && Math.abs(size(back)[1] - size(twisted)[1]) < 0.001, 'each model remembers its orientation');
await page.click('#turn-reset');
const reset = await box();
check(Math.abs(size(reset)[1] - size(upright)[1]) < 0.001 && Math.abs(reset.min[2] - upright.min[2]) < 0.001 && await resetDisabled(), 'Reset puts it back exactly');
await page.click('#turn-y');
for (let i = 0; i < 3; i++) await page.click('#turn-y');
const fullCircle = await box();
check(await resetDisabled() && Math.abs(fullCircle.min[2] - upright.min[2]) < 0.001, 'four quarter turns come back to where it started');
check(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('pzSkinStudio.orientations') ?? '{}')).length) === 0, 'nothing is left saved after a reset');

check(await page.title() === 'PZ Skin Studio' && await page.$eval('h1', (h) => h.textContent) === 'PZ Skin Studio', 'the page has its new name');

// HDR skins on import.
const noteNow = () => page.evaluate(() => {
  const note = document.getElementById('colourNote');
  return { shown: !note.hidden, text: note.textContent, toast: document.getElementById('toast').textContent, kind: document.getElementById('toast').className };
});
const pixelOf = (x, y) => page.evaluate(async (px, py) => {
  const s = window.skinStudio;
  const image = await createImageBitmap(new Blob([s.state.skin.png]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return [...context.getImageData(px, py, 1, 1).data];
}, x, y);
await select('AardMara', 'female');
const hdrPath = path.join(tmp, 'HDR Painting.png');
fs.writeFileSync(hdrPath, hdrSample());
await importBytes(hdrPath);
await wait(300);
let colourNote = await noteNow();
check(colourNote.shown && /HDR/.test(colourNote.text), 'an HDR PNG gets a warning beside it', colourNote.text.slice(0, 60));
check(/colours were fixed/.test(colourNote.toast) && /warn/.test(colourNote.kind), 'and a yellow message when it arrives', colourNote.toast.slice(0, 60));
check((await pixelOf(0, 0)).slice(0, 3).join() === '254,246,237', 'and the preview uses the fixed colours', (await pixelOf(0, 0)).join());
const hdrStored = await page.evaluate(() => [...window.skinStudio.state.skin.png]);
check(colourOf(Uint8Array.from(hdrStored)).kind === 'srgb', 'the skin it keeps is plain sRGB');

await page.evaluate(() => {
  window.saved = null;
  document.getElementById('skinName').value = 'HDR Fixed';
  document.getElementById('exportSkin').click();
});
await page.waitForFunction(() => window.saved, { timeout: 5000 });
const exportedHdr = unzipSync(Uint8Array.from((await page.evaluate(() => window.saved)).bytes));
check(colourOf(exportedHdr['skin.png']).kind === 'srgb', 'Export gives the fixed copy');

const adobePath = path.join(tmp, 'Adobe.png');
const adobeSource = new PNG({ width: 4, height: 4 });
for (let i = 0; i < 16; i++) adobeSource.data.set([100, 200, 100, 255], i * 4);
fs.writeFileSync(adobePath, withChunk(PNG.sync.write(adobeSource), 'iCCP', iccp('Adobe RGB (1998)', fs.readFileSync('/usr/share/color/icc/colord/AdobeRGB1998.icc'))));
await importBytes(adobePath);
await wait(300);
const adobePixel = await pixelOf(1, 1);
colourNote = await noteNow();
check(colourNote.shown && /Adobe RGB/.test(colourNote.text), 'Adobe RGB gets the same warning', colourNote.text.slice(0, 50));
// (0, 201, 92) according to Little CMS.
check(adobePixel[0] <= 8 && Math.abs(adobePixel[1] - 201) <= 4 && Math.abs(adobePixel[2] - 92) <= 4, 'and comes out as a colour engine says it should', adobePixel.join());

await importBytes(skinPath);
await wait(300);
colourNote = await noteNow();
const cleanBytes = await page.evaluate(() => [...window.skinStudio.state.skin.png]);
check(!colourNote.shown, 'a plain sRGB skin gets no warning');
check(Buffer.compare(Buffer.from(cleanBytes), fs.readFileSync(skinPath)) === 0, 'and is left byte for byte as it was');

// An old HDR zip: fixed as it comes in, and stays fixed.
const hdrZip = path.join(tmp, 'Old HDR.skin.zip');
fs.writeFileSync(hdrZip, packSkin({ ...meta, name: 'Old HDR' }, new Uint8Array(hdrSample())));
await importBytes(hdrZip);
await wait(300);
colourNote = await noteNow();
now = await shown();
check(now.skin === 'Old HDR' && colourNote.shown, 'an HDR zip is fixed on import too', now.skin);
check(colourOf(Uint8Array.from(await page.evaluate(() => [...window.skinStudio.state.skin.png]))).kind === 'srgb', 'and holds plain sRGB');

// Opening the page again: everything comes back with no folder to pick.
const afterOpen = () => page.evaluate(() => {
  const { state } = window.skinStudio;
  return {
    welcome: !document.getElementById('welcome').hidden,
    characters: state.catalog?.characters.length,
    layouts: state.catalog?.layouts.size,
    status: document.getElementById('folderStatus').textContent,
    custom: state.customSkins.map((s) => s.meta.name),
    character: state.character?.id,
    drawn: !!state.mesh && !!state.skin,
    listed: document.querySelectorAll('#list .row').length,
  };
});
const before = await page.evaluate(() => {
  const { catalog } = window.skinStudio.state;
  return { characters: catalog.characters.length, layouts: catalog.layouts.size };
});
const opened = await page.evaluate(() => performance.now());
const reloadPage = async () => {
  const started = Date.now();
  await page.reload();
  await page.waitForFunction(() => window.skinStudio?.state.mesh && window.skinStudio.state.skin, { timeout: 20000 });
  return Date.now() - started;
};
const reloadMs = await reloadPage();
const reopened = await afterOpen();
console.log('     reopened in', reloadMs, 'ms:', reopened.status);
check(!reopened.welcome && reopened.characters === before.characters && reopened.layouts === before.layouts && reopened.listed === before.characters,
  'after a reload everything is there with no folder to pick', JSON.stringify({ opened: Math.round(opened), ms: reloadMs }));
check(reopened.drawn, 'it draws straight away', reopened.character);
check(reopened.status.startsWith('models:'), 'it knows which folder it came from', reopened.status);
check(reopened.custom.includes(meta.name), 'an imported skin comes back too', reopened.custom.join(', '));
const storedHdr = await page.evaluate(() => {
  const skin = window.skinStudio.state.customSkins.find((s) => s.name === 'Old HDR');
  return skin ? [...skin.png] : null;
});
check(storedHdr && colourOf(Uint8Array.from(storedHdr)).kind === 'srgb', 'the fixed zip stays fixed after a reload');
await select('DogAlex', 'female');
now = await shown();
check(now.tiles.length >= 12 && now.tiles.includes('Morgan Kinkade'), 'skins are still linked by layout', now.tiles.length);
const guideAgain = await downloadGuide();
checkGuide(guideAgain, 256, 'UV guide after a reload');

// Picking a folder with nothing in it must not wipe what's stored.
const emptyFolder = path.join(tmp, 'nothing');
fs.mkdirSync(emptyFolder);
fs.writeFileSync(path.join(emptyFolder, 'note.xml'), '<nothing/>');
await (await page.$('#dirInput')).uploadFile(emptyFolder);
await page.evaluate(() => document.getElementById('dirInput').dispatchEvent(new Event('change')));
await page.waitForFunction(() => /No models/.test(document.getElementById('toast').textContent), { timeout: 10000 });
await reloadPage();
check((await afterOpen()).characters === before.characters, 'picking the wrong folder keeps what was stored');
check(!problems.length, 'no page or console errors', problems.slice(0, 5).join(' | '));
await stop();

// Closing the browser and coming back, the way it really gets used.
{
  const again = await start({ profile });
  await again.page.waitForFunction(() => window.skinStudio?.state.mesh, { timeout: 20000 });
  const seen = await again.page.evaluate(() => ({
    characters: window.skinStudio.state.catalog.characters.length,
    welcome: !document.getElementById('welcome').hidden,
    bytes: navigator.storage.estimate().then((e) => e.usage),
  }));
  const usage = await again.page.evaluate(async () => (await navigator.storage.estimate()).usage);
  console.log('     stored in the browser:', (usage / 1048576).toFixed(0), 'MB');
  check(seen.characters === before.characters && !seen.welcome, 'after closing the browser it still opens by itself', seen.characters);
  check(!again.problems.length, 'no errors after a restart', again.problems.slice(0, 3).join(' | '));
  await again.stop();
  fs.rmSync(profile, { recursive: true, force: true });
}

// --- Dropping more into the folder: a loose model, and a second pack with its own species.lua ---
{
  const folder = path.join(tmp, 'studio');
  fs.mkdirSync(path.join(folder, 'models/Loose'), { recursive: true });
  execFileSync('cp', ['-r', path.join(root, 'models/XochisCustomBFT'), path.join(folder, 'models')]);
  const clothes = path.join(media, 'models_X/Skinned/Clothes/Furry_XochisCustomBFT_FemaleAardMara.fbx');
  fs.copyFileSync(clothes, path.join(folder, 'models/Loose/MyModel.fbx'));
  fs.copyFileSync(path.join(media, 'textures/Clothes/Furry_XochisCustomBFT_FemaleAardMara.png'), path.join(folder, 'models/Loose/MyModel.png'));
  // In this pack a character's two bodies only have different pictures when their layouts differ
  // too, so make the other case: same layout, different picture.
  const female = path.join(folder, 'models/XochisCustomBFT/42/media/textures/Clothes/Furry_XochisCustomBFT_FemaleAardMara.png');
  const repainted = PNG.sync.read(fs.readFileSync(female));
  repainted.data[0] ^= 0x55;
  fs.writeFileSync(female, PNG.sync.write(repainted));
  fs.mkdirSync(path.join(folder, 'skins'));
  fs.copyFileSync(zipPath, path.join(folder, 'skins/Rex the Wolf.skin.zip'));
  const workshop = '/media/Vol2/Games/SteamLibrary/steamapps/workshop/content/108600';
  for (const mod of ['2893930681/mods/Furry', '3411037098/mods/AnthroUngulates']) {
    if (fs.existsSync(path.join(workshop, mod))) execFileSync('cp', ['-r', path.join(workshop, mod), path.join(folder, 'models')]);
  }
  const second = await start();
  await openFolder(second.page, folder);
  await wait(500);
  const seen = await second.page.evaluate(() => {
    const { state } = window.skinStudio;
    const chars = state.catalog.characters;
    return {
      count: chars.length,
      loose: chars.filter((c) => c.group === 'Not in a species list').map((c) => c.display),
      racoon: chars.filter((c) => /racoon/i.test(c.id) || c.group === 'Racoon').map((c) => `${c.display}:${c.group}`),
      packs: [...new Set(chars.map((c) => c.pack.id))],
      saved: state.customSkins.map((s) => s.name),
      errors: chars.flatMap((c) => Object.values(c.bodies)).filter((v) => v?.error).map((v) => `${v.item}: ${v.error}`),
    };
  });
  console.log('     ', JSON.stringify(seen));
  const tiles = await second.page.evaluate(async () => {
    const s = window.skinStudio;
    await s.selectCharacter(s.state.catalog.characters.find((c) => c.id.endsWith('AardMara')), { body: 'female' });
    return [...document.querySelectorAll('#skins .tile span')].map((n) => n.textContent);
  });
  check(tiles.includes('Mara (male)') && tiles.includes('Mara (female)'), 'two different pictures for one character are both offered', tiles.join(', '));
  check(seen.packs.includes('Loose'), 'a loose folder is named after itself');
  check(seen.count > 280 && seen.loose.includes('MyModel'), 'a loose model appears', seen.count);
  check(!seen.packs.includes('FurryModB42') || ['Common:Racoon', 'Spiffy:Racoon', 'Racoon:Racoon'].every((r) => seen.racoon.includes(r)),
    'an unused item on a species\' model is listed with that species (Racoon)', seen.racoon.join(', '));
  check(seen.packs.length >= 2, 'a dropped-in pack appears', seen.packs.join(', '));
  check(seen.saved.length === 1, 'skins/ is read on open', seen.saved[0]);
  check(!second.problems.length, 'no errors with extra packs', second.problems.slice(0, 3).join(' | '));
  await second.stop();
}

// --- The Chrome and Edge path: a folder handle that's remembered, written to and watched. ---
// Headless Chrome has no folder dialog, so the picker hands over a real directory handle from the
// origin's private file system, which needs http rather than file://.
{
  const server = http.createServer((_, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(fs.readFileSync(path.join(root, 'PZSkinStudio.html')));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const run = await start({ url });
  const { page: p } = run;
  const name = 'Furry_XochisCustomBFT_MaleWolfNero';
  const files = {
    'models/Pack/mod.info': Buffer.from('id=Pack\nname=Test Pack\n'),
    [`models/Pack/media/clothing/clothingItems/${name}.xml`]: fs.readFileSync(path.join(media, `clothing/clothingItems/${name}.xml`)),
    [`models/Pack/media/models_X/Skinned/Clothes/${name}.fbx`]: fs.readFileSync(path.join(media, `models_X/Skinned/Clothes/${name}.fbx`)),
    [`models/Pack/media/textures/Clothes/${name}.png`]: fs.readFileSync(path.join(media, `textures/Clothes/${name}.png`)),
  };
  await p.evaluate(async (list) => {
    const rootDir = await navigator.storage.getDirectory();
    for (const [filePath, data] of Object.entries(list)) {
      const parts = filePath.split('/');
      let dir = rootDir;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await writable.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      await writable.close();
    }
    window.showDirectoryPicker = async () => rootDir;
  }, Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString('base64')])));
  await p.click('#welcomeOpen');
  await p.waitForFunction(() => window.skinStudio.state.mesh, { timeout: 20000 });
  check(await p.evaluate(() => window.skinStudio.state.catalog.characters.length === 1), 'folder handle: read');

  const push = (filePath, fileName) => p.evaluate(async (data, n) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    await window.skinStudio.importFile(new File([bytes], n));
  }, fs.readFileSync(filePath).toString('base64'), fileName);
  const listSkins = () => p.evaluate(async () => {
    const rootDir = await navigator.storage.getDirectory();
    const dir = await rootDir.getDirectoryHandle('skins', { create: true });
    const names = [];
    for await (const [n] of dir.entries()) names.push(n);
    return names.sort();
  });

  const clashing = path.join(tmp, 'clash.skin.zip');
  const otherPng = new PNG({ width: 256, height: 256 });
  otherPng.data.fill(200);
  const zipInfo = unzipSync(fs.readFileSync(zipPath));
  const sameMeta = JSON.parse(strFromU8(zipInfo['skin.json']));
  fs.writeFileSync(clashing, packSkin(sameMeta, PNG.sync.write(otherPng)));
  await push(zipPath, 'Rex the Wolf.skin.zip');
  check((await listSkins()).length === 1, 'folder handle: import saves into skins/', (await listSkins()).join(', '));
  await push(zipPath, 'Rex the Wolf.skin.zip');
  check((await listSkins()).length === 1, 'folder handle: same skin again is not saved twice');
  await push(clashing, 'Rex the Wolf.skin.zip');
  const both = await listSkins();
  check(both.length === 2 && both.includes('Rex the Wolf (2).skin.zip'), 'folder handle: a different skin with the same name keeps both', both.join(', '));

  // Painting: the preview follows the file.
  const before = await p.evaluate(async () => {
    const rootDir = await navigator.storage.getDirectory();
    const handle = await rootDir.getFileHandle('painting.png', { create: true });
    window.painting = handle;
    return true;
  });
  const write = (filePath) => p.evaluate(async (data) => {
    const writable = await window.painting.createWritable();
    await writable.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    await writable.close();
  }, fs.readFileSync(filePath).toString('base64'));
  await write(skinPath);
  await p.evaluate(async () => {
    await window.skinStudio.importFile(await window.painting.getFile(), window.painting);
  });
  const firstBytes = await p.evaluate(() => window.skinStudio.state.skin.png.length);
  const repaint = new PNG({ width: 256, height: 256 });
  for (let i = 0; i < 256 * 256; i++) repaint.data.set([(i * 7) % 255, i % 251, (i * 3) % 253, 255], i * 4);
  const repaintPath = path.join(tmp, 'repaint.png');
  fs.writeFileSync(repaintPath, PNG.sync.write(repaint));
  await wait(1200);
  await write(repaintPath);
  await p.waitForFunction((size) => window.skinStudio.state.skin.png.length !== size, { timeout: 6000 }, firstBytes).then(
    () => check(before, 'folder handle: saving the file updates the preview'),
    () => check(false, 'folder handle: saving the file updates the preview'),
  );

  await p.reload();
  await p.waitForFunction(() => window.skinStudio.state.mesh, { timeout: 20000 }).catch(() => {});
  const back = await p.evaluate(() => ({
    folder: document.getElementById('folderStatus').textContent,
    skins: window.skinStudio.state.customSkins.length,
  }));
  check(back.skins === 2, 'folder handle: remembered after a reload, saved skins come back', JSON.stringify(back));
  check(!run.problems.length, 'folder handle: no errors', run.problems.slice(0, 3).join(' | '));
  await run.stop();
  server.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
