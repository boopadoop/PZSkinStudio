// Works out what's in the folder the same way the game does: mods share one merged media folder,
// species.lua lists the characters, each character's clothing XML names its model and texture.
import { unzlibSync } from 'fflate';
import {
  parseFbxTree, readLayout, readMesh, readViewLayout, readWholeMesh, readWholeUvLayers, viewMesh, viewsOf,
} from './fbx.js';
import { checkModel, facesNote, fileNotes, uvNotes } from './modelcheck.js';
import { clear, get, put } from './library.js';

const MEDIA = /^(.*?\/)?media\/(.+)$/i;
const ITEM = /^clothing\/clothingitems\/([^/]+)\.xml$/;
const LIBRARY_STORES = ['catalog', 'meshes', 'textures', 'skins'];

export const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
const stem = (path) => baseName(path).replace(/\.[^.]+$/, '');
const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);

// A mod can hold the same file for several game versions: 42/ beats common/ beats the plain copy.
function rootRank(root) {
  if (/(^|\/)42(\.\d+)*\/$/.test(root)) return 2;
  return /(^|\/)common\/$/.test(root) ? 1 : 0;
}

function parseModInfo(text) {
  const field = (name) => new RegExp(`^${name}=(.*)$`, 'mi').exec(text)?.[1].trim();
  return { id: field('id'), name: field('name') };
}

function parseItem(text) {
  const tags = (tag) => [...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))]
    .map((m) => m[1].trim()).filter(Boolean);
  return {
    male: tags('m_MaleModel')[0],
    female: tags('m_FemaleModel')[0],
    textures: [...tags('textureChoices'), ...tags('m_BaseTextures')],
  };
}

// Both ways a species.lua is written: FurryModApi calls, and the older table style.
export function parseSpecies(text) {
  const out = [];
  let group = null;
  let species = null;
  const quoted = (line, pattern) => pattern.exec(line)?.[1];
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('--')) continue;
    let m = /createCustomSpeciesGroup\(\s*"([^"]*)"\s*,\s*"([^"]*)"/.exec(line);
    if (m) { group = { id: m[1], display: m[2] }; continue; }
    m = /addSpeciesToGroup\(\s*\w+\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"/.exec(line);
    if (m) {
      out.push({ id: m[1], display: m[2], male: m[3], female: m[4], group });
      continue;
    }
    if (/^\s*group\s*=\s*\{\s*\}/.test(line)) { group = {}; continue; }
    const groupDisplay = quoted(line, /group\.display\s*=\s*"([^"]*)"/);
    if (groupDisplay !== undefined && group) group.display = groupDisplay;
    const groupId = quoted(line, /group\.name\s*=\s*"([^"]*)"/);
    if (groupId !== undefined && group) group.id = groupId;
    if (/^\s*species\s*=\s*\{\s*\}/.test(line)) { species = {}; continue; }
    if (!species) continue;
    species.id = quoted(line, /species\.name\s*=\s*"([^"]*)"/) ?? species.id;
    species.display = quoted(line, /species\.display\s*=\s*"([^"]*)"/) ?? species.display;
    species.male = quoted(line, /species\.maleClothing\s*=\s*"([^"]*)"/) ?? species.male;
    species.female = quoted(line, /species\.femaleClothing\s*=\s*"([^"]*)"/) ?? species.female;
    if (/table\.insert\(\s*group\.species/.test(line)) {
      out.push({ ...species, group });
      species = null;
    }
  }
  return out;
}

async function inBatches(list, size, work) {
  for (let i = 0; i < list.length; i += size) {
    await Promise.all(list.slice(i, i + size).map(work));
  }
}

// Reads the folder into the library. entries: [{ path, open() -> File }], every wanted file in it.
// Returns the new catalog, or null if the folder has no models, which leaves the library as it was.
export async function scanFolder(entries, folderName, onProgress) {
  const assets = new Map();
  const modInfoByDir = new Map();
  const skinFiles = [];

  await inBatches(entries.filter((e) => baseName(e.path).toLowerCase() === 'mod.info'), 16, async (e) => {
    modInfoByDir.set(dirOf(e.path), parseModInfo(await (await e.open()).text()));
  });

  const packFor = (path) => {
    for (let dir = dirOf(path); ; dir = dirOf(dir.slice(0, -1))) {
      // A mod can have an older build's mod.info in its root, with a different id.
      const info = modInfoByDir.get(`${dir}42/`) ?? modInfoByDir.get(dir);
      if (info?.id) return info;
      if (!dir) break;
    }
    const folder = baseName(path.replace(/(^|\/)((42(\.\d+)*|common)\/)?media\/.*$|\/[^/]*$/i, '')) || 'Unknown';
    return { id: folder, name: folder };
  };

  for (const entry of entries) {
    // Skins: any zip in skins/, and any .skin.zip wherever else it was put, such as beside the models.
    if (/(^|\/)skins\/[^/]+\.zip$/i.test(entry.path) || /\.skin\.zip$/i.test(entry.path)) {
      skinFiles.push(entry);
      continue;
    }
    const m = MEDIA.exec(entry.path);
    if (!m) continue;
    const tail = m[2].toLowerCase();
    const rank = rootRank(m[1] ?? '');
    const seen = assets.get(tail);
    if (!seen || rank > seen.rank) assets.set(tail, { ...entry, rank, tail });
  }

  const modelFor = (ref) => assets.get(`models_x/${ref.replaceAll('\\', '/').toLowerCase()}.fbx`);
  const textureFor = (ref) => assets.get(`textures/${ref.replaceAll('\\', '/').toLowerCase()}.png`);

  // Clothing items by name. The _Deceased copies point at the same model and texture.
  const items = new Map();
  const xml = [...assets.values()].filter((a) => ITEM.test(a.tail) && !/_deceased\.xml$/.test(a.tail));
  let done = 0;
  await inBatches(xml, 64, async (asset) => {
    const item = parseItem(await (await asset.open()).text());
    item.name = stem(asset.path);
    item.pack = packFor(asset.path);
    items.set(item.name.toLowerCase(), item);
    onProgress?.('Reading skin links', ++done, xml.length);
  });

  const variantFor = (body, itemRef, pack) => {
    const name = itemRef.slice(itemRef.lastIndexOf('.') + 1);
    const item = items.get(name.toLowerCase());
    const ref = item && item[body];
    const model = ref && modelFor(ref);
    if (!model) return null;
    item.used = true;
    return {
      body,
      item: name,
      itemRef,
      modelRef: ref,
      model,
      textures: item.textures.map((t) => ({ ref: t, entry: textureFor(t) })).filter((t) => t.entry),
      pack: item.pack ?? pack,
    };
  };

  const characters = [];
  const seenSpecies = new Set();
  const speciesFiles = [...assets.values()]
    .filter((a) => /(^|\/)species\.lua$/.test(a.tail))
    .sort((a, b) => b.rank - a.rank);
  for (const file of speciesFiles) {
    const pack = packFor(file.path);
    for (const s of parseSpecies(await (await file.open()).text())) {
      if (seenSpecies.has(s.id) || !s.male || !s.female) continue;
      seenSpecies.add(s.id);
      const male = variantFor('male', s.male, pack);
      const female = variantFor('female', s.female, pack);
      if (!male && !female) continue;
      characters.push({
        id: s.id, display: s.display, group: s.group?.display ?? 'Other',
        groupId: s.group?.id ?? '', pack, bodies: { male, female },
      });
    }
  }

  // A leftover clothing item on a model that a species uses belongs with that species. Anthro
  // Survivors' own Furry_MaleRacoon item is one: no species lists it, but its model is the one the
  // Racoon group's Common and Spiffy wear, so a skin painted on it is a Racoon skin.
  const groupOfModel = new Map();
  for (const c of characters) {
    for (const v of Object.values(c.bodies)) {
      if (v && !groupOfModel.has(v.model.tail)) groupOfModel.set(v.model.tail, { group: c.group, groupId: c.groupId });
    }
  }

  // Anything in the folder that no species.lua mentions still gets listed, so a model can be
  // tried out by dropping it in. Male/Female twins are joined into one character.
  const loose = new Map();
  const addLoose = (name, variant, pack) => {
    const m = /^(.*?)(male|female)(.*)$/i.exec(name);
    const key = m ? `${m[1]}${m[3]}`.toLowerCase() : name.toLowerCase();
    const display = (m ? `${m[3] || m[1]}` : name).replace(/^Furry_/, '') || name;
    const home = groupOfModel.get(variant.model.tail) ?? { group: 'Not in a species list', groupId: '' };
    const character = loose.get(key) ?? {
      id: key, display, group: home.group, groupId: home.groupId, pack, bodies: { male: null, female: null },
    };
    const body = m ? m[2].toLowerCase() : 'male';
    character.bodies[body] = { ...variant, body };
    if (!m) character.bodies.female = { ...variant, body: 'female' };
    loose.set(key, character);
  };
  for (const item of items.values()) {
    if (item.used) continue;
    const ref = item.female ?? item.male;
    const model = ref && modelFor(ref);
    if (!model) continue;
    addLoose(item.name, {
      item: item.name,
      itemRef: item.name,
      modelRef: ref,
      model,
      textures: item.textures.map((t) => ({ ref: t, entry: textureFor(t) })).filter((t) => t.entry),
      pack: item.pack,
    }, item.pack);
  }
  const claimed = new Set();
  for (const c of [...characters, ...loose.values()]) {
    for (const v of Object.values(c.bodies)) if (v) claimed.add(v.model.tail);
  }
  const allFbx = entries.filter((e) => /\.fbx$/i.test(e.path) && !/(^|\/)anims_x\//i.test(e.path));
  for (const entry of allFbx) {
    const tail = MEDIA.exec(entry.path)?.[2].toLowerCase();
    if (tail && claimed.has(tail)) continue;
    const name = stem(entry.path);
    const sibling = entries.find((e) => e.path.toLowerCase() === `${entry.path.slice(0, -4)}.png`.toLowerCase());
    const texture = sibling ?? textureFor(`Clothes\\${name}`);
    const pack = packFor(entry.path);
    addLoose(name, {
      item: name,
      itemRef: name,
      modelRef: `Skinned\\Clothes\\${name}`,
      model: { ...entry, tail: tail ?? entry.path.toLowerCase() },
      textures: texture ? [{ ref: `Clothes\\${name}`, entry: texture }] : [],
      pack,
    }, pack);
  }
  characters.push(...loose.values());

  if (!characters.length) return null;

  for (const store of LIBRARY_STORES) await clear(store);
  await saveModels(characters, onProgress);
  await saveTextures(characters, onProgress);
  for (const entry of skinFiles) {
    // Kept under the file's own name if it's in skins/, and under its path anywhere else, so two
    // files of the same name in different folders don't overwrite each other.
    const name = /(^|\/)skins\/[^/]+$/i.test(entry.path) ? baseName(entry.path) : entry.path;
    await put('skins', name, { name, bytes: new Uint8Array(await (await entry.open()).arrayBuffer()) });
  }
  characters.sort((a, b) => a.group.localeCompare(b.group) || a.display.localeCompare(b.display));
  await put('catalog', 'current', { folderName, characters: characters.map(toRecord) });
  return loadLibrary();
}

// A file with several objects or materials: one mesh of the whole file, and each view's layout and notes.
function viewedModel(tree, views, general) {
  const mesh = readWholeMesh(tree);
  const layers = readWholeUvLayers(tree);
  const about = fileNotes(tree, { general });
  const faces = facesNote(tree, { general });
  const shown = (general ? views.filter((v) => !v.game) : views).map((view) => {
    const { index } = viewMesh(mesh, view.id);
    const uv = index.length ? uvNotes(layers, index, { cornerPart: mesh.cornerPart, whole: view.id === 'whole' }) : [];
    return { ...view, ...readViewLayout(tree, view.id), checks: [...about, ...uv, ...faces] };
  });
  const defaultView = general ? 'whole' : 'game';
  const first = shown.find((v) => v.id === defaultView);
  // The game's own layout, if the part it draws can be read; a general model goes by the whole.
  let game = null;
  try { game = readLayout(tree); } catch { game = null; }
  return {
    mesh, views: shown, defaultView,
    layout: general || !game ? first.layout : game.layout,
    verts: first.verts, polys: first.polys, checks: first.checks,
  };
}

const variantsOf = (characters) => characters.flatMap((c) => Object.values(c.bodies)).filter(Boolean);

// Lets the page redraw while a long job runs.
function pacer(label, total, onProgress) {
  let done = 0;
  let lastBreath = performance.now();
  return async () => {
    done++;
    if (performance.now() - lastBreath < 30) return;
    onProgress?.(label, done, total);
    await new Promise((resolve) => setTimeout(resolve));
    lastBreath = performance.now();
  };
}

function toRecord(character) {
  const bodies = {};
  for (const [body, v] of Object.entries(character.bodies)) {
    bodies[body] = v && {
      body: v.body, item: v.item, itemRef: v.itemRef, modelRef: v.modelRef, pack: v.pack,
      layout: v.layout, verts: v.verts, polys: v.polys, error: v.error, checks: v.checks,
      general: v.general, views: v.views, defaultView: v.defaultView,
      model: { tail: v.model.tail }, meshKey: v.meshKey,
      textures: v.textures.map((t) => ({ ref: t.ref, path: t.entry.path, size: t.size })),
    };
  }
  return { ...character, bodies };
}

// The catalog as the rest of the studio uses it, whether it was just scanned or is from a past visit.
export async function loadLibrary() {
  const catalog = await get('catalog', 'current');
  if (!catalog) return null;
  catalog.layouts = new Map();
  for (const character of catalog.characters) {
    for (const variant of Object.values(character.bodies)) {
      if (!variant) continue;
      for (const texture of variant.textures) {
        texture.read = () => get('textures', texture.path);
      }
      // Every view of a file reads the same UV maps, so its pictures and skins fit them all.
      const layouts = new Map();
      if (variant.layout) layouts.set(variant.layout, variant.views?.find((v) => v.layout === variant.layout)?.id ?? null);
      for (const view of variant.views ?? []) if (!layouts.has(view.layout)) layouts.set(view.layout, view.id);
      for (const [layout, view] of layouts) {
        if (!catalog.layouts.has(layout)) catalog.layouts.set(layout, []);
        catalog.layouts.get(layout).push({ character, variant, view });
      }
    }
  }
  return catalog;
}

async function saveTextures(characters, onProgress) {
  const textures = variantsOf(characters).flatMap((v) => v.textures);
  const breathe = pacer('Reading skins', textures.length, onProgress);
  const sizes = new Map();
  for (const texture of textures) {
    const { path } = texture.entry;
    if (!sizes.has(path)) {
      const file = await texture.entry.open();
      sizes.set(path, file.size);
      await put('textures', path, new Uint8Array(await file.arrayBuffer()));
    }
    texture.size = sizes.get(path);
    await breathe();
  }
}

// Keeps each model as ready-to-draw arrays: most of a big FBX is animation the preview never uses.
async function saveModels(characters, onProgress) {
  const variants = variantsOf(characters);
  const breathe = pacer('Reading models', variants.length, onProgress);
  const byPath = new Map();
  const saved = new Set();
  for (const variant of variants) {
    const { path } = variant.model;
    if (!byPath.has(path)) {
      let info;
      try {
        const file = await variant.model.open();
        const tree = parseFbxTree(new Uint8Array(await file.arrayBuffer()), unzlibSync);
        // A model outside any mod's media folder isn't meant for the game: no game checks, and it
        // opens whole.
        const general = !MEDIA.test(path);
        const views = viewsOf(tree);
        if (!views.length) {
          info = readLayout(tree);
          // The two bodies are often the same file.
          info.meshKey = `${file.size}:${info.layout}`;
          const mesh = readMesh(tree);
          info.checks = checkModel(tree, mesh, { general });
          if (!saved.has(info.meshKey)) {
            await put('meshes', info.meshKey, mesh);
            saved.add(info.meshKey);
          }
        } else {
          info = viewedModel(tree, views, general);
          info.meshKey = `${file.size}:${info.views[0].layout}:whole`;
          if (!saved.has(info.meshKey)) {
            await put('meshes', info.meshKey, info.mesh);
            saved.add(info.meshKey);
          }
          delete info.mesh;
        }
        info.general = general;
      } catch (error) {
        info = { error: error.message };
      }
      byPath.set(path, info);
    }
    Object.assign(variant, byPath.get(path));
    await breathe();
  }
}
