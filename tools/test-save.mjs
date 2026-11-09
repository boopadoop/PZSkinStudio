// Where paintings are saved: paint history/ in the studio folder, through start-studio.py in
// Firefox and through the folder's own handle in Chrome. Uses a small copy of the studio folder.
//   node tools/test-save.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { root, start } from './harness.mjs';
import { packSkin } from '../src/skinfile.js';

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== '' ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const studio = fs.mkdtempSync(path.join(os.tmpdir(), 'skinstudio-save-'));
fs.copyFileSync(path.join(root, 'PZSkinStudio.html'), path.join(studio, 'PZSkinStudio.html'));
fs.cpSync(path.join(root, 'models/VanillaHumans'), path.join(studio, 'models/VanillaHumans'), { recursive: true });
fs.mkdirSync(path.join(studio, 'skins'));
const history = path.join(studio, 'paint history');

const port = 47000 + Math.floor(Math.random() * 800);
const helper = spawn('python3', [path.join(root, 'start-studio.py'), '--no-browser', '--port', String(port), '--folder', studio], { stdio: 'pipe' });
await wait(700);

// Paints a known square straight into the painter's pixels, then goes through Save as.
async function paintAndSave(page, name, shade) {
  await page.evaluate(async (s) => {
    const { painter } = window.skinStudio;
    if (!painter.isOpen) document.getElementById('paintOpen').click();
    await new Promise((resolve) => { const t = setInterval(() => { if (painter.isOpen) { clearInterval(t); resolve(); } }, 20); });
    const { doc } = painter;
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) doc.pixels.set([s, 40, 200, 255], (y * doc.width + x) * 4);
  }, shade);
  await page.click('#paintSave');
  await page.$eval('#saveName', (n, value) => { n.value = value; }, name);
  await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
  await page.click('#saveConfirm');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('toast').textContent), { timeout: 10000 });
  return page.evaluate(() => ({ toast: document.getElementById('toast').textContent, png: [...window.skinStudio.painter.png()] }));
}

// Firefox, started through the helper.
{
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'skinstudio-ff-'));
  const browser = await puppeteer.launch({
    browser: 'firefox', executablePath: '/usr/lib/firefox/firefox', headless: true, userDataDir: profile,
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/PZSkinStudio.html`);
  await page.waitForFunction(() => window.skinStudio.state.mesh, { timeout: 60000 }).catch(() => {});
  const opened = await page.evaluate(() => ({
    characters: window.skinStudio.state.catalog?.characters.length ?? 0,
    welcome: !document.getElementById('welcome').hidden,
  }));
  check(opened.characters > 0 && !opened.welcome, 'Firefox through the helper reads the folder with no picking', opened.characters);

  const first = await paintAndSave(page, 'Helper Test', 230);
  const firstFile = path.join(history, 'Helper Test.png');
  check(fs.existsSync(firstFile) && Buffer.compare(fs.readFileSync(firstFile), Buffer.from(first.png)) === 0,
    'Save as writes paint history/Helper Test.png, byte for byte', first.toast);
  check(/paint history\/Helper Test\.png/.test(first.toast), 'and says where it went');
  const same = await paintAndSave(page, 'Helper Test', 230);
  check(fs.readdirSync(history).length === 1, 'saving the same picture again adds no copy', same.toast);
  const second = await paintAndSave(page, 'Helper Test', 120);
  const secondFile = path.join(history, 'Helper Test (2).png');
  check(fs.existsSync(secondFile) && Buffer.compare(fs.readFileSync(secondFile), Buffer.from(second.png)) === 0
    && Buffer.compare(fs.readFileSync(firstFile), Buffer.from(first.png)) === 0,
    'a changed picture is kept beside the first', fs.readdirSync(history).join(', '));
  const odd = await paintAndSave(page, 'Odd: name/../x', 90);
  check(fs.existsSync(path.join(history, 'Odd namex.png')), 'an odd name is made safe and stays in paint history', odd.toast);

  // An imported skin zip lands in skins/, which Firefox could never do before.
  await page.click('#paintClose');
  await page.waitForFunction(() => !window.skinStudio.painter.isOpen);
  const meta = await page.evaluate(() => {
    const { state } = window.skinStudio;
    const v = state.character.bodies[state.body];
    return { name: 'Zip Test', uvLayout: v.layout, character: state.character.id, body: v.body, characterName: state.character.display };
  });
  const zip = packSkin(meta, fs.readFileSync(firstFile));
  await page.evaluate(async (bytes) => {
    await window.skinStudio.importFile(new File([Uint8Array.from(bytes)], 'Zip Test.skin.zip'));
  }, [...zip]);
  await wait(300);
  check(fs.existsSync(path.join(studio, 'skins/Zip Test.skin.zip')), 'an imported skin is saved in skins/', fs.readdirSync(path.join(studio, 'skins')).join(', '));

  // Coming back: the library is kept for the helper's address, and Rescan reads the folder again.
  await page.reload();
  await page.waitForFunction(() => window.skinStudio.state.mesh, { timeout: 30000 });
  check(await page.evaluate(() => window.skinStudio.state.customSkins.some((s) => s.name === 'Zip Test')), 'after a reload the skin is still there');
  await page.click('#rescan');
  await page.waitForFunction(() => document.getElementById('busy').hidden && window.skinStudio.state.mesh, { timeout: 30000 });
  check(await page.evaluate(() => window.skinStudio.state.customSkins.some((s) => s.name === 'Zip Test')), 'and after a Rescan, read back from skins/');

  check(!problems.length, 'no page errors in Firefox', problems.slice(0, 3).join(' | '));
  // Another site can't use the helper.
  const outside = await page.evaluate(async (p) => {
    try {
      const r = await fetch(`http://localhost:${p}/api/files`, { headers: { 'X-Skin-Studio': '1' } });
      return r.status;
    } catch { return 'blocked'; }
  }, port);
  check(outside === 'blocked' || outside === 403, 'a page from another address is refused', outside);
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

// Firefox straight from the file can't write there, so it downloads and says how to change that.
{
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'skinstudio-ff-'));
  const browser = await puppeteer.launch({
    browser: 'firefox', executablePath: '/usr/lib/firefox/firefox', headless: true, userDataDir: profile,
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = await browser.newPage();
  await page.goto(`file://${path.join(studio, 'PZSkinStudio.html')}`);
  await page.waitForFunction(() => !document.getElementById('welcome').hidden, { timeout: 10000 });
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full); else files.push(full);
    }
  };
  walk(path.join(studio, 'models'));
  await page.evaluate((list) => {
    const incoming = list.map(([p, data]) => {
      const file = new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], p.split('/').pop());
      Object.defineProperty(file, 'webkitRelativePath', { value: `Studio/${p}` });
      return file;
    });
    document.getElementById('dirInput').onchange({ target: { files: incoming, value: '' } });
  }, files.map((f) => [path.relative(studio, f), fs.readFileSync(f).toString('base64')]));
  await page.waitForFunction(() => window.skinStudio.state.mesh, { timeout: 60000 });
  const saved = await paintAndSave(page, 'From File', 60);
  check(/downloads/.test(saved.toast) && /start-studio\.py/.test(saved.toast), 'from the file, Firefox downloads it and points to start-studio.py', saved.toast);
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

// Chrome with a folder handle writes there itself. The browser's private folder stands in for the
// one the user picked, since a test can't click through the folder picker.
{
  const { page, problems, stop } = await start({ url: `http://127.0.0.1:${port}/PZSkinStudio.html` });
  await page.waitForFunction(() => window.skinStudio.state.mesh, { timeout: 60000 });
  const result = await page.evaluate(async () => {
    const { state } = window.skinStudio;
    state.root = await navigator.storage.getDirectory();
    return true;
  });
  check(result, 'Chrome is given a folder handle');
  const saved = await paintAndSave(page, 'Chrome Test', 200);
  const inFolder = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('paint history');
    const file = await (await dir.getFileHandle('Chrome Test.png')).getFile();
    return [...new Uint8Array(await file.arrayBuffer())];
  }).catch((error) => error.message);
  check(Array.isArray(inFolder) && Buffer.compare(Buffer.from(inFolder), Buffer.from(saved.png)) === 0,
    'Chrome writes paint history/Chrome Test.png in the folder', saved.toast);
  check(!problems.length, 'no page errors in Chrome', problems.slice(0, 3).join(' | '));
  await stop();
}

helper.kill();
fs.rmSync(studio, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
