import { baseName, loadLibrary, scanFolder } from './catalog.js';
import { canPickFolder, download, listHandle, listInput, recallFolder, rememberFolder, saveFile, saveToSkins } from './folder.js';
import { get, getAll, put } from './library.js';
import { Painter } from './painter.js';
import { colourOf, hdrToSrgb, pixelsOf } from './pngcolour.js';
import { isPng, packSkin, pngSize, unpackSkin } from './skinfile.js';
import { Viewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const TEXTURE_SIZE = 256;
const ORIENTATIONS_KEY = 'pzSkinStudio.orientations';
const WATCH_MS = 1000;
const SKIN_FORMAT = 1;

const state = {
  root: null,         // the folder's handle, when the browser gives one
  catalog: null,
  character: null,
  body: localStorage.getItem('pzSkinStudio.body') === 'male' ? 'male' : 'female',
  skin: null,
  mesh: null,
  customSkins: [],
  packSkins: new Map(),
  unmatched: [],
};
let viewer = null;
let painter = null;
let loadToken = 0;

const variantNow = () => state.character?.bodies[state.body] ?? null;
const safeName = (name) => name.trim().replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, ' ') || 'skin';

function toast(message, kind = '') {
  const box = $('toast');
  box.textContent = message;
  box.className = `show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.className = ''; }, kind === 'error' ? 9000 : 5000);
}

function setBusy(label, done, total) {
  $('busy').hidden = !label;
  if (!label) return;
  $('busyLabel').textContent = total ? `${label}: ${done} of ${total}` : label;
  $('busyBar').value = total ? done / total : 0;
}

// ---- Opening the folder --------------------------------------------------------------------

async function loadEntries(entries, folderName) {
  $('welcome').hidden = true;
  setBusy('Looking through the folder');
  let catalog;
  try {
    catalog = await scanFolder(entries, folderName, setBusy);
  } catch (error) {
    toast(`Could not read that folder: ${error.message}`, 'error');
  }
  setBusy(null);
  if (catalog) {
    await showCatalog(catalog);
    return;
  }
  $('welcome').hidden = !!state.catalog;
  toast('No models in that folder. Pick the folder that holds models/ and skins/.', 'error');
}

async function showCatalog(catalog) {
  $('welcome').hidden = true;
  state.catalog = catalog;
  state.customSkins = [];
  state.packSkins = new Map();
  state.unmatched = [];
  state.character = null;
  state.skin = null;
  let fixed = 0;
  for (const { name, bytes } of await getAll('skins')) {
    try {
      const skin = await addSkinFromZip(bytes, name, { savedAs: name });
      if (skin?.colourNote) {
        fixed++;
        await put('skins', name, { name, bytes: packSkin(skin.meta, skin.png) });
      }
    } catch (error) {
      toast(`${name}: ${error.message}`, 'error');
    }
  }
  const { characters, layouts, folderName } = catalog;
  $('rescan').hidden = false;
  const broken = characters.flatMap((c) => Object.values(c.bodies)).filter((v) => v?.error).length;
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  $('folderStatus').textContent = `${folderName}: ${count(characters.length, 'character')}, ${count(layouts.size, 'UV layout')}`
    + (state.customSkins.length ? `, ${count(state.customSkins.length, 'saved skin')}` : '')
    + (broken ? `, ${count(broken, 'unreadable model')}` : '');
  $('search').placeholder = `Search ${count(characters.length, 'character')}`;
  $('search').disabled = false;
  renderList();
  const last = localStorage.getItem('pzSkinStudio.character');
  await selectCharacter(characters.find((c) => c.id === last) ?? characters[0]);
  if (state.unmatched.length) {
    toast(`${state.unmatched.length} saved skins need a model that isn't in this folder: ${state.unmatched.join(', ')}`, 'error');
  } else if (fixed) {
    toast(`Fixed the colours of ${count(fixed, 'saved skin')} that had the wrong colour format.`, 'warn');
  }
}

async function openHandle(handle) {
  state.root = handle;
  await rememberFolder(handle);
  try {
    await loadEntries(await listHandle(handle), handle.name);
  } catch (error) {
    toast(`Could not read ${handle.name}: ${error.message}`, 'error');
  }
}

async function chooseFolder() {
  if (!canPickFolder) {
    $('dirInput').click();
    return;
  }
  try {
    await openHandle(await window.showDirectoryPicker({ id: 'skinstudio' }));
  } catch (error) {
    if (error.name !== 'AbortError') toast(`Could not open that folder: ${error.message}`, 'error');
  }
}

// Chrome and Edge can read the same folder again after a yes. Other browsers have to be shown it.
async function rescan() {
  const allowed = await state.root?.requestPermission({ mode: 'read' }).catch(() => 'denied');
  if (allowed === 'granted') await openHandle(state.root);
  else await chooseFolder();
}

async function start() {
  if (canPickFolder) state.root = await recallFolder() ?? null;
  const catalog = await loadLibrary();
  if (catalog) await showCatalog(catalog);
  else $('welcome').hidden = false;
}

// ---- The list of characters ----------------------------------------------------------------

// Every skin in the pack that fits a layout. Most characters ship the same picture twice, once
// per body, but not all of them, so copies are told apart by file size rather than by name.
async function packSkinsFor(layout) {
  if (state.packSkins.has(layout)) return state.packSkins.get(layout);
  const skins = [];
  const seen = new Set();
  for (const { character, variant } of state.catalog.layouts.get(layout) ?? []) {
    for (const texture of variant.textures) {
      const key = `${character.id}|${texture.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      skins.push({ kind: 'pack', name: character.display, group: character.group, character, variant, texture });
    }
  }
  for (const skin of skins) {
    const twins = skins.filter((other) => other.character === skin.character);
    if (twins.length < 2) continue;
    // A character with several skins for one body is told apart by the picture's own name.
    const sameBody = twins.some((other) => other !== skin && other.variant === skin.variant);
    skin.name = sameBody
      ? baseName(skin.texture.ref.replaceAll('\\', '/'))
      : `${skin.character.display} (${skin.variant.body})`;
  }
  state.packSkins.set(layout, skins);
  return skins;
}

async function skinsFor(layout) {
  const pack = await packSkinsFor(layout);
  const isOwn = (skin) => (skin.character === state.character ? 0 : 1);
  return {
    custom: state.customSkins.filter((s) => s.meta.uvLayout === layout),
    pack: [...pack].sort((a, b) => isOwn(a) - isOwn(b)),
  };
}

function renderList() {
  const filter = $('search').value.trim().toLowerCase();
  const list = $('list');
  const rows = [];
  let group = null;
  for (const character of state.catalog.characters) {
    const text = `${character.display} ${character.group} ${character.id}`.toLowerCase();
    if (filter && !text.includes(filter)) continue;
    if (character.group !== group) {
      group = character.group;
      rows.push(el('div', 'group', group));
    }
    const row = el('button', 'row', character.display);
    row.dataset.id = character.id;
    row.onclick = () => selectCharacter(character);
    if (character === state.character) row.classList.add('active');
    rows.push(row);
  }
  list.replaceChildren(...rows);
  if (!rows.length) list.append(el('div', 'muted pad', 'Nothing matches that search.'));
}

function markActiveRow() {
  for (const row of $('list').querySelectorAll('.row')) {
    row.classList.toggle('active', row.dataset.id === state.character?.id);
  }
  $('list').querySelector('.row.active')?.scrollIntoView({ block: 'nearest' });
}

// ---- Choosing a model and a skin -----------------------------------------------------------

async function selectCharacter(character, { body, skin } = {}) {
  state.character = character;
  localStorage.setItem('pzSkinStudio.character', character.id);
  if (body) state.body = body;
  if (!character.bodies[state.body]) state.body = state.body === 'male' ? 'female' : 'male';
  markActiveRow();
  await showVariant(skin);
}

async function setBody(body) {
  state.body = body;
  localStorage.setItem('pzSkinStudio.body', body);
  await showVariant();
}

async function loadMesh(variant) {
  const mesh = await get('meshes', variant.meshKey);
  if (!mesh) throw new Error('its saved copy is missing, so click Rescan');
  return mesh;
}

function savedOrientations() {
  try {
    return JSON.parse(localStorage.getItem(ORIENTATIONS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function rememberOrientation() {
  const saved = savedOrientations();
  const key = variantNow().model.tail;
  if (viewer.isTurned) saved[key] = viewer.orientation;
  else delete saved[key];
  localStorage.setItem(ORIENTATIONS_KEY, JSON.stringify(saved));
  $('turn-reset').disabled = !viewer.isTurned;
}

function turnModel(axis) {
  if (!state.mesh) return;
  viewer.turn(axis);
  rememberOrientation();
}

function resetOrientation() {
  viewer.orientation = null;
  rememberOrientation();
}

async function showVariant(skin) {
  const token = ++loadToken;
  const variant = variantNow();
  renderModelPanel(variant);
  if (variant.error) {
    toast(`This model can't be shown: ${variant.error}`, 'error');
    return;
  }
  try {
    const mesh = await loadMesh(variant);
    if (token !== loadToken) return;
    state.mesh = mesh;
    viewer.setMesh(mesh);
    viewer.orientation = savedOrientations()[variant.model.tail] ?? null;
    $('turn-reset').disabled = !viewer.isTurned;
  } catch (error) {
    if (token === loadToken) toast(`This model can't be shown: ${error.message}`, 'error');
    return;
  }
  const { pack, custom } = await skinsFor(variant.layout);
  if (token !== loadToken) return;
  const own = pack.find((s) => s.variant === variant)
    ?? pack.find((s) => s.character === state.character)
    ?? pack[0] ?? null;
  // Keep a skin the user is working on when they switch to a model that can wear it.
  const keep = state.skin?.meta?.uvLayout === variant.layout ? state.skin : null;
  await selectSkin(skin ?? keep ?? own, token);
  renderSkinList(pack, custom);
}

const skinBytes = async (skin) => {
  if (skin.kind === 'custom') return skin.png;
  return skin.texture.read();
};

async function selectSkin(skin, token = ++loadToken) {
  state.skin = skin;
  watch(skin);
  let image = null;
  if (skin) {
    const bytes = await skinBytes(skin);
    image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
      premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    });
  }
  if (token !== loadToken) return;
  viewer.setSkin(image);
  drawTexture(image);
  renderSkinPanel();
  for (const tile of $('skins').querySelectorAll('.tile')) tile.classList.toggle('active', tile.skin === skin);
}

function renderModelPanel(variant) {
  const c = state.character;
  $('modelName').textContent = c.display;
  $('modelGroup').textContent = `${c.group} · ${c.pack.name ?? c.pack.id}`;
  $('modelStats').textContent = variant.layout
    ? `${variant.verts} vertices · ${variant.polys} polygons · layout ${variant.layout.slice(0, 8)}`
    : '';
  for (const body of ['male', 'female']) {
    const button = $(`body-${body}`);
    button.disabled = !c.bodies[body];
    button.classList.toggle('active', body === state.body);
  }
  $('paintOpen').disabled = !!variant.error;
  const { male, female } = c.bodies;
  const note = $('bodyNote');
  if (male && female && male.layout !== female.layout) {
    note.textContent = 'Male and female have different UV layouts here. A skin only fits the body it was painted for.';
    note.className = 'note warn';
  } else if (male && female) {
    note.textContent = 'Male and female share this layout, so one skin fits both.';
    note.className = 'note';
  } else {
    note.textContent = '';
  }
}

function thumbnailUrl(skin) {
  if (skin.thumbnail) return Promise.resolve(skin.thumbnail);
  return skinBytes(skin).then((bytes) => {
    skin.thumbnail = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    return skin.thumbnail;
  });
}

function skinTile(skin) {
  const tile = el('button', 'tile');
  tile.skin = skin;
  if (skin === state.skin) tile.classList.add('active');
  const image = el('img');
  image.alt = '';
  image.draggable = false;
  thumbnailUrl(skin).then((url) => { image.src = url; });
  tile.append(image, el('span', '', skin.name));
  tile.title = skin.kind === 'custom' ? `${skin.name}${skin.meta.author ? ` by ${skin.meta.author}` : ''}` : `${skin.name} (${skin.group})`;
  tile.onclick = () => selectSkin(skin);
  return tile;
}

function renderSkinList(pack, custom) {
  const box = $('skins');
  box.replaceChildren();
  if (custom.length) {
    box.append(el('h3', '', 'Your skins'));
    const grid = el('div', 'grid');
    grid.append(...custom.map(skinTile));
    box.append(grid);
  }
  box.append(el('h3', '', pack.length === 1 ? 'From the pack' : `From the pack (${pack.length} fit this model)`));
  const grid = el('div', 'grid');
  grid.append(...pack.map(skinTile));
  box.append(grid);
}

async function refreshSkinList() {
  const { pack, custom } = await skinsFor(variantNow().layout);
  renderSkinList(pack, custom);
}

function renderSkinPanel() {
  const skin = state.skin;
  const custom = skin?.kind === 'custom';
  $('customFields').hidden = !custom;
  $('paintHint').hidden = custom;
  $('downloadPng').disabled = !skin;
  if (custom) {
    $('skinName').value = skin.name;
    $('skinAuthor').value = skin.meta.author ?? '';
    $('watchNote').hidden = !skin.handle;
    $('colourNote').hidden = !skin.colourNote;
    $('colourNote').textContent = skin.colourNote ?? '';
  }
}

// ---- The flat texture ----------------------------------------------------------------------

let shownImage = null;

function drawUvLines(ctx, size, color, width) {
  const { uv, edges } = state.mesh;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i] * 2;
    const b = edges[i + 1] * 2;
    ctx.moveTo(uv[a] * size, uv[a + 1] * size);
    ctx.lineTo(uv[b] * size, uv[b + 1] * size);
  }
  ctx.stroke();
}

function drawTexture(image = shownImage) {
  shownImage = image;
  const canvas = $('texture');
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = false;
  if (image) ctx.drawImage(image, 0, 0, size, size);
  if ($('showUv').checked && state.mesh) drawUvLines(ctx, size, 'rgba(255,255,255,.75)', 1);
  $('textureSize').textContent = image ? `${image.width} × ${image.height}` : '';
}

// Every pixel on a line, from one texture pixel to another.
function plotLine(x0, y0, x1, y1, plot) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const stepX = x0 < x1 ? 1 : -1;
  const stepY = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) return;
    const twice = error * 2;
    if (twice >= dy) {
      error += dy;
      x0 += stepX;
    }
    if (twice <= dx) {
      error += dx;
      y0 += stepY;
    }
  }
}

// The UV lines at the texture's own size, to lay over it in a paint program. Plotted by hand because
// canvas lines are antialiased: here each pixel is pure white or fully see-through.
function uvGuide() {
  const width = shownImage?.width ?? TEXTURE_SIZE;
  const height = shownImage?.height ?? TEXTURE_SIZE;
  const image = new ImageData(width, height);
  const plot = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    image.data.fill(255, (y * width + x) * 4, (y * width + x) * 4 + 4);
  };
  const { uv, edges } = state.mesh;
  const pixelX = (corner) => Math.floor(uv[corner * 2] * width);
  const pixelY = (corner) => Math.floor(uv[corner * 2 + 1] * height);
  for (let i = 0; i < edges.length; i += 2) {
    plotLine(pixelX(edges[i]), pixelY(edges[i]), pixelX(edges[i + 1]), pixelY(edges[i + 1]), plot);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(image, 0, 0);
  return canvas;
}

// ---- Import and export ---------------------------------------------------------------------

// Other colour spaces go through the browser's own colour management.
async function managedToSrgb(png) {
  const image = await createImageBitmap(new Blob([png], { type: 'image/png' }), {
    premultiplyAlpha: 'none', colorSpaceConversion: 'default',
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d').drawImage(image, 0, 0);
  const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png'); });
  return new Uint8Array(await blob.arrayBuffer());
}

// The game ignores a PNG's colour tags, so anything that isn't plain sRGB is converted on the way in.
async function fixColours(png) {
  const colour = colourOf(png);
  if (colour.kind === 'srgb') return { png, colourNote: null };
  try {
    return {
      png: colour.kind === 'hdr' ? hdrToSrgb(png) : await managedToSrgb(png),
      colourNote: `This file was saved as ${colour.label}, which the game would show dark and washed out, so the studio converted it to sRGB. Exporting or downloading it gives you the fixed copy. Next time, export as 8-bit sRGB with HDR turned off.`,
    };
  } catch {
    return {
      png,
      colourNote: `This file is saved as ${colour.label}, and the studio couldn't convert it, so the game will show it dark and washed out. Export it from your paint program as 8-bit sRGB with HDR turned off.`,
    };
  }
}

function metaFor(name, author, variant = variantNow(), character = state.character) {
  const fitting = Object.values(character.bodies).filter((v) => v?.layout === variant.layout);
  return {
    format: SKIN_FORMAT,
    name,
    author,
    uvLayout: variant.layout,
    pack: variant.pack?.id ?? character.pack.id,
    character: character.id,
    characterName: character.display,
    group: character.groupId,
    groupName: character.group,
    body: variant.body,
    fitsBodies: fitting.map((v) => v.body),
    clothingItem: variant.itemRef,
    model: variant.modelRef,
    models: Object.fromEntries(fitting.map((v) => [v.body, v.modelRef])),
  };
}

function findBase(meta) {
  const matches = state.catalog.layouts.get(meta.uvLayout);
  if (!matches) return null;
  return matches.find((m) => m.character.id === meta.character && m.variant.body === meta.body)
    ?? matches.find((m) => m.character.id === meta.character)
    ?? matches[0];
}

async function addSkinFromZip(bytes, fileName, extra = {}) {
  const { meta, png: original } = unpackSkin(bytes);
  const name = meta.name || fileName.replace(/\.skin\.zip$|\.zip$/i, '');
  if (!findBase(meta)) {
    state.unmatched.push(`${name} (${meta.characterName ?? meta.model ?? 'unknown model'})`);
    return null;
  }
  const { png, colourNote } = await fixColours(original);
  const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
  const known = state.customSkins.find((s) => s.name === name && s.meta.uvLayout === meta.uvLayout && same(s.png, png));
  if (known) return known;
  const skin = { kind: 'custom', name, meta, png, colourNote, ...extra };
  state.customSkins.push(skin);
  return skin;
}

async function importZip(bytes, fileName) {
  state.unmatched = [];
  const skin = await addSkinFromZip(bytes, fileName);
  if (!skin) {
    toast(`${state.unmatched[0]} needs a model that isn't in your models folder.`, 'error');
    return;
  }
  // Asking to write has to happen soon after the click or drop, so this comes before the slow part.
  const zipName = `${safeName(skin.name)}.skin.zip`;
  const fixedZip = skin.colourNote ? packSkin(skin.meta, skin.png) : bytes;
  const saved = state.root
    ? skin.savedAs ?? await saveToSkins(state.root, zipName, fixedZip).catch(() => null)
    : null;
  skin.savedAs = saved;
  await put('skins', saved ?? zipName, { name: saved ?? zipName, bytes: fixedZip });
  const base = findBase(skin.meta);
  await selectCharacter(base.character, { body: base.variant.body, skin });
  if (skin.colourNote) toast(`${skin.name} had the wrong colour format, so its colours were fixed. See the note beside it.`, 'warn');
  else {
    toast(saved
      ? `Imported ${skin.name}, saved as skins/${saved}`
      : `Imported ${skin.name}. Put the zip in your skins folder too, or a Rescan will drop it.`);
  }
}

function sizeWarning({ width, height }) {
  if (width !== height) return `This skin is ${width} × ${height}, so it will stretch: skins must be square.`;
  if (width & (width - 1)) return `This skin is ${width} × ${height}. Game textures are usually 256, 512 or 1024 wide.`;
  return '';
}

async function importPng(original, fileName, handle) {
  const name = fileName.replace(/\.png$/i, '');
  const variant = variantNow();
  const { png: bytes, colourNote } = await fixColours(original);
  let skin = state.customSkins.find((s) => s.name === name && s.meta.uvLayout === variant.layout);
  if (skin) {
    skin.png = bytes;
    skin.colourNote = colourNote;
    skin.thumbnail = null;
    skin.handle = handle ?? skin.handle;
  } else {
    skin = { kind: 'custom', name, meta: metaFor(name, ''), png: bytes, colourNote, handle };
    state.customSkins.unshift(skin);
  }
  await showVariant(skin);
  const warning = sizeWarning(pngSize(bytes));
  if (warning) toast(warning, 'error');
  else if (colourNote) toast(`${name} had the wrong colour format, so its colours were fixed. See the note beside it.`, 'warn');
  else toast(`Showing ${name} on ${state.character.display}.`);
}

// Follows a skin's file while it's being painted, so saving in the paint program updates the view.
function watch(skin) {
  if (watch.skin === skin) return;
  watch.skin = skin;
  clearInterval(watch.timer);
  if (!skin?.handle) return;
  let seen = 0;
  watch.timer = setInterval(async () => {
    try {
      const file = await skin.handle.getFile();
      if (seen && file.lastModified !== seen) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!isPng(bytes)) return;
        Object.assign(skin, await fixColours(bytes));
        skin.thumbnail = null;
        if (state.skin === skin) await selectSkin(skin);
        await refreshSkinList();
      }
      seen = file.lastModified;
    } catch {
      // Mid-save, or the file was moved. Try again on the next tick.
    }
  }, WATCH_MS);
}

async function importFile(file, handle) {
  if (!state.catalog) {
    toast('Open your studio folder first.', 'error');
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    if (isPng(bytes)) {
      if (!state.character) throw new Error('pick a model first');
      await importPng(bytes, file.name, handle);
    } else if (/\.zip$/i.test(file.name)) {
      await importZip(bytes, file.name);
    } else {
      throw new Error('skins are .png or .zip files');
    }
  } catch (error) {
    toast(`${file.name}: ${error.message}`, 'error');
  }
}

async function chooseImport() {
  if (!('showOpenFilePicker' in window)) {
    $('fileInput').click();
    return;
  }
  try {
    const handles = await window.showOpenFilePicker({
      id: 'skinimport',
      multiple: true,
      types: [{ description: 'Skin', accept: { 'image/png': ['.png'], 'application/zip': ['.zip'] } }],
    });
    for (const handle of handles) await importFile(await handle.getFile(), handle);
  } catch (error) {
    if (error.name !== 'AbortError') toast(`Could not import: ${error.message}`, 'error');
  }
}

// ---- Painting ------------------------------------------------------------------------------

// A skin as plain pixels. Files the PNG reader doesn't cover go through the browser instead.
async function texturePixels(png) {
  try {
    return pixelsOf(png);
  } catch {
    const image = await createImageBitmap(new Blob([png], { type: 'image/png' }), {
      premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    return { width: image.width, height: image.height, pixels: new Uint8ClampedArray(data) };
  }
}

function blankTexture() {
  return { width: TEXTURE_SIZE, height: TEXTURE_SIZE, pixels: new Uint8ClampedArray(TEXTURE_SIZE * TEXTURE_SIZE * 4).fill(255) };
}

async function openPaint() {
  if (!state.mesh || painter.isOpen) return;
  const { skin, character } = state;
  const texture = skin ? await texturePixels(await skinBytes(skin)) : blankTexture();
  watch(null);
  painter.open({
    ...texture,
    mesh: state.mesh,
    name: skin?.name ?? character.display,
    what: `${character.display}, ${state.body} body`,
  });
}

async function afterPaint() {
  await selectSkin(state.skin);
  await refreshSkinList();
}

function askSaveName() {
  $('saveName').value = painter.name;
  $('saveDialog').showModal();
  $('saveName').select();
}

async function savePainting(name) {
  const png = painter.png();
  try {
    await saveFile(png, `${safeName(name)}.png`, { type: 'image/png', description: 'PNG image' });
  } catch (error) {
    if (error.name !== 'AbortError') toast(`Could not save: ${error.message}`, 'error');
    return;
  }
  const { layout } = variantNow();
  let skin = state.customSkins.find((s) => s.name === name && s.meta.uvLayout === layout);
  if (skin) {
    skin.png = png;
    skin.colourNote = null;
    skin.thumbnail = null;
  } else {
    const meta = state.skin?.meta ?? metaFor(name, '');
    skin = { kind: 'custom', name, meta: { ...meta, name }, png, colourNote: null };
    state.customSkins.unshift(skin);
  }
  skin.savedAs ??= `${safeName(name)}.skin.zip`;
  await put('skins', skin.savedAs, { name: skin.savedAs, bytes: packSkin(skin.meta, png) });
  state.skin = skin;
  painter.markSaved(name);
  toast(`Saved ${safeName(name)}.png, and added it to Your skins.`);
}

async function exportSkin() {
  const skin = state.skin;
  const name = $('skinName').value.trim();
  if (!name) {
    toast('Give the skin a name first.', 'error');
    $('skinName').focus();
    return;
  }
  skin.name = name;
  skin.meta = { ...skin.meta, name, author: $('skinAuthor').value.trim() };
  const bytes = packSkin(skin.meta, skin.png);
  const fileName = `${safeName(name)}.skin.zip`;
  try {
    const startIn = await state.root?.getDirectoryHandle('skins').catch(() => null);
    await saveFile(bytes, fileName, { type: 'application/zip', description: 'Skin', startIn });
  } catch (error) {
    if (error.name !== 'AbortError') toast(`Could not save: ${error.message}`, 'error');
    return;
  }
  toast(`Exported ${fileName}. Send that one file to share the skin.`);
  await refreshSkinList();
}

async function downloadPng() {
  const skin = state.skin;
  const bytes = await skinBytes(skin);
  download(bytes, `${safeName(skin.name)}-${state.body}.png`, 'image/png');
}

function downloadGuide() {
  if (!state.mesh) return;
  uvGuide().toBlob(async (blob) => {
    download(new Uint8Array(await blob.arrayBuffer()), `${safeName(state.character.display)}-${state.body}-uv-guide.png`, 'image/png');
  });
}

// ---- Wiring it up --------------------------------------------------------------------------

function init() {
  viewer = new Viewer($('view'));
  painter = new Painter(viewer, { onClosed: afterPaint, onSaveRequest: askSaveName });
  $('paintOpen').onclick = openPaint;
  $('saveDialog').addEventListener('close', () => {
    const name = $('saveName').value.trim();
    if ($('saveDialog').returnValue === 'save' && name) savePainting(name);
  });
  addEventListener('beforeunload', (event) => { if (painter.unsaved) event.preventDefault(); });
  $('openFolder').onclick = chooseFolder;
  $('welcomeOpen').onclick = chooseFolder;
  $('rescan').onclick = rescan;
  $('dirInput').onchange = (event) => {
    const files = event.target.files;
    if (!files.length) return;
    state.root = null;
    loadEntries(listInput(files), files[0].webkitRelativePath.split('/')[0]);
    event.target.value = '';
  };
  $('fileInput').onchange = async (event) => {
    for (const file of [...event.target.files]) await importFile(file);
    event.target.value = '';
  };
  $('search').oninput = renderList;
  $('body-male').onclick = () => setBody('male');
  $('body-female').onclick = () => setBody('female');
  $('importSkin').onclick = chooseImport;
  $('exportSkin').onclick = exportSkin;
  $('downloadPng').onclick = downloadPng;
  $('downloadGuide').onclick = downloadGuide;
  $('showUv').onchange = () => drawTexture();
  for (const name of ['front', 'back', 'left', 'right']) $(`view-${name}`).onclick = () => viewer.view(name);
  for (const axis of ['x', 'y', 'z']) $(`turn-${axis}`).onclick = () => turnModel(axis);
  $('turn-reset').onclick = resetOrientation;
  $('opt-lit').onchange = (e) => viewer.setOptions({ lit: e.target.checked });
  $('opt-wire').onchange = (e) => viewer.setOptions({ wire: e.target.checked });
  $('opt-back').onchange = (e) => viewer.setOptions({ backFaces: e.target.checked });
  $('opt-crisp').onchange = (e) => viewer.setOptions({ crisp: e.target.checked });
  $('opt-spin').onchange = (e) => viewer.setOptions({ turntable: e.target.checked });

  addEventListener('dragover', (event) => {
    event.preventDefault();
    document.body.classList.add('dropping');
  });
  addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) document.body.classList.remove('dropping');
  });
  addEventListener('drop', async (event) => {
    event.preventDefault();
    document.body.classList.remove('dropping');
    if (painter.isOpen) {
      toast('Close paint before importing a skin.', 'error');
      return;
    }
    const items = [...event.dataTransfer.items].filter((item) => item.kind === 'file');
    // Handles have to be asked for before the drop event ends.
    const pending = items.map((item) => [item.getAsFile(), item.getAsFileSystemHandle?.()]);
    for (const [file, handlePromise] of pending) {
      const handle = await handlePromise?.catch(() => null);
      await importFile(file, handle?.kind === 'file' ? handle : undefined);
    }
  });
  start();
}

window.skinStudio = { state, get viewer() { return viewer; }, get painter() { return painter; }, importFile, selectCharacter, setBody, selectSkin, openHandle, uvGuide };
init();
