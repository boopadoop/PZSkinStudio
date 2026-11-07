// The main journey in Firefox, from file://: open the folder once, close the browser, come back.
//   node tools/test-firefox.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { pageUrl, root } from './harness.mjs';
import { hdrSample } from './hdr-sample.mjs';
import { encodePng } from '../src/pngcolour.js';
import { packSkin } from '../src/skinfile.js';

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== '' ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'skinstudio-ff-'));
const launch = async () => {
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: '/usr/lib/firefox/firefox',
    headless: true,
    userDataDir: profile,
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  await page.goto(pageUrl);
  return { browser, page, problems };
};

// Firefox's automation can't choose a whole folder, so the page gets the real files from disk
// the way the folder input hands them over.
function folderFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^(species\.lua|mod\.info)$|\.(png|xml)$/i.test(entry.name) || (/\.fbx$/i.test(entry.name) && fs.statSync(full).size < 5e6)) out.push(full);
    }
  };
  walk(path.join(root, 'models'));
  return out;
}

const first = await launch();
const { page } = first;
check(await page.evaluate(() => !('showDirectoryPicker' in window)), 'this is the browser with no folder picker');
await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 5000 }).then(
  () => check(true, 'the first visit asks for the folder'),
  () => check(false, 'the first visit asks for the folder'),
);
const files = folderFiles();
await page.evaluate(() => { window.incoming = []; });
for (let i = 0; i < files.length; i += 100) {
  const batch = files.slice(i, i + 100).map((f) => [`models/${path.relative(path.join(root, 'models'), f)}`, fs.readFileSync(f).toString('base64')]);
  await page.evaluate((list) => {
    for (const [p, data] of list) {
      const file = new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], p.split('/').pop());
      Object.defineProperty(file, 'webkitRelativePath', { value: `Studio/${p}` });
      window.incoming.push(file);
    }
  }, batch);
}
const started = Date.now();
await page.evaluate(() => { document.getElementById('dirInput').onchange({ target: { files: window.incoming, value: '' } }); });
await page.waitForFunction(() => window.skinStudio.state.mesh && window.skinStudio.state.skin, { timeout: 120000 });
const scanned = await page.evaluate(() => ({
  characters: window.skinStudio.state.catalog.characters.length,
  layouts: window.skinStudio.state.catalog.layouts.size,
  status: document.getElementById('folderStatus').textContent,
}));
console.log(`     ${files.length} files read in ${Date.now() - started} ms: ${scanned.status}`);
check(scanned.characters > 280, 'the folder is read', scanned.characters);

// A skin file for the Trag model, as a friend would send one.
const trag = await page.evaluate(() => {
  const character = window.skinStudio.state.catalog.characters.find((c) => c.id === 'XochisCustomBFT_GoatTrag');
  const { layout, modelRef, body } = character.bodies.female;
  return { layout, modelRef, body, id: character.id };
});
const texture = new Uint8Array(256 * 256 * 4).fill(200);
const zip = Buffer.from(packSkin({
  name: 'Sent Skin', uvLayout: trag.layout, character: trag.id, characterName: 'Trag', body: trag.body, model: trag.modelRef,
}, encodePng(256, 256, texture))).toString('base64');
const imported = await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await window.skinStudio.importFile(new File([bytes], 'Sent Skin.skin.zip'));
  return window.skinStudio.state.skin?.name;
}, zip);
check(imported === 'Sent Skin', 'a friend\'s skin imports', imported);
const guide = await page.evaluate(() => {
  const canvas = window.skinStudio.uvGuide();
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let bad = 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (data[i + 3] === 255 && data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) lines++;
    else bad++;
  }
  return { width: canvas.width, height: canvas.height, bad, lines };
});
check(guide.width === 256 && guide.height === 256 && guide.bad === 0 && guide.lines > 1000, 'UV guide: texture size, only white and clear', JSON.stringify(guide));
await page.click('#turn-x');
const turned = await page.evaluate(() => {
  const b = window.skinStudio.viewer.modelBox();
  return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => +v.toFixed(2));
});
check(turned[2] > turned[1], 'Tilt lays the model down', turned.join(' x '));
const hdr = hdrSample().toString('base64');
const fixedHdr = await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await window.skinStudio.importFile(new File([bytes], 'HDR Sample.png'));
  const note = document.getElementById('colourNote');
  const image = await createImageBitmap(new Blob([window.skinStudio.state.skin.png]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return { shown: !note.hidden, pixel: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).join() };
}, hdr);
check(fixedHdr.shown && fixedHdr.pixel === '254,246,237', 'an HDR skin is fixed on import, with a warning', fixedHdr.pixel);
// Painting, with the real mouse, in the browser that has no save window.
await page.evaluate(async () => {
  const s = window.skinStudio;
  await s.selectSkin(s.state.customSkins.find((k) => k.name === 'Sent Skin'));
});
await page.click('#paintOpen');
await page.waitForFunction(() => window.skinStudio.painter.isOpen);
await new Promise((resolve) => setTimeout(resolve, 300));
const spot = await page.evaluate(() => {
  const { view } = window.skinStudio.painter;
  const box = view.canvas.getBoundingClientRect();
  const place = (x, y) => ({ x: box.left + view.offset.x + (x + 0.5) * view.zoom, y: box.top + view.offset.y + (y + 0.5) * view.zoom });
  return { from: place(40, 120), to: place(90, 120) };
});
await page.click('#palette .swatch[title="#2f80ed"]');
await page.mouse.move(spot.from.x, spot.from.y);
await page.mouse.down();
await page.mouse.move(spot.to.x, spot.to.y, { steps: 8 });
await page.mouse.up();
await new Promise((resolve) => setTimeout(resolve, 200));
const stroke = await page.evaluate(() => window.skinStudio.painter.doc.sample(65, 120).join());
check(stroke === '47,128,237,255', 'painting works with the real mouse', stroke);
await page.click('#paintSave');
await page.$eval('#saveName', (n) => { n.value = 'Firefox Paint'; });
await page.click('#saveConfirm');
await page.waitForFunction(() => /Saved/.test(document.getElementById('toast').textContent), { timeout: 8000 });
const paintSaved = await page.evaluate(() => {
  const { painter, state } = window.skinStudio;
  return { unsaved: painter.unsaved, skins: state.customSkins.map((k) => k.name) };
});
check(!paintSaved.unsaved && paintSaved.skins.includes('Firefox Paint'), 'Save as works with no save window', paintSaved.skins.join(', '));
await page.click('#paintClose');
await page.waitForFunction(() => !window.skinStudio.painter.isOpen);
check(!first.problems.length, 'no errors on the first visit', first.problems.slice(0, 3).join(' | '));
await first.browser.close();

const second = await launch();
const started2 = Date.now();
await second.page.waitForFunction(() => window.skinStudio?.state.mesh && window.skinStudio.state.skin, { timeout: 30000 });
const back = await second.page.evaluate(() => {
  const { state } = window.skinStudio;
  return {
    welcome: !document.getElementById('welcome').hidden,
    characters: state.catalog.characters.length,
    character: state.character.display,
    skin: state.skin.name,
    custom: state.customSkins.map((s) => s.name),
    turned: window.skinStudio.viewer.isTurned,
    status: document.getElementById('folderStatus').textContent,
  };
});
console.log(`     reopened in ${Date.now() - started2} ms:`, JSON.stringify(back));
check(!back.welcome && back.characters === scanned.characters, 'after closing Firefox it opens by itself', back.status);
check(back.character === 'Trag' && back.custom.includes('Sent Skin'), 'the last model and the imported skin come back', `${back.character}, ${back.custom}`);
check(back.turned, 'and the model keeps its rotation');
check(back.custom.includes('Firefox Paint'), 'and so does a painted skin', back.custom.join(', '));
await second.page.screenshot({ path: process.argv[2] ?? path.join(os.tmpdir(), 'skinstudio-firefox.png') });
check(!second.problems.length, 'no errors on coming back', second.problems.slice(0, 3).join(' | '));
await second.browser.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
