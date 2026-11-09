// Looks over a model the way someone making a skin would need to know about it: whether the game
// draws all of it, and whether its UV map leaves a skin room to work. PZ's own models all pass
// (measured on 608 of them), so these mostly speak up for models made at home.
import { creatorOf, meshParts, readUvLayers } from './fbx.js';

// Every pack model is well inside these: at most 0.12% of UV corners outside the square, 11% of the
// painted area on top of something else, 42% of faces with no UV area, and 3,372 faces.
const LIMITS = { outside: 0.01, overlap: 0.2, collapsed: 0.6, coverage: 0.1, faces: 15000 };
const RESOLUTION = 256;

const percent = (share) => (share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);
const list = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const quoted = (names) => list(names.map((n) => `"${n}"`));
// Up to five names, then a count.
const some = (names) => (names.length <= 6 ? quoted(names) : `${names.slice(0, 5).map((n) => `"${n}"`).join(', ')} and ${names.length - 5} more`);

// The bones in the file. Every pack model uses the game's skeleton, whose bones are all Bip01_something.
function boneNames(tree) {
  const objects = tree.children.find((c) => c.name === 'Objects');
  return (objects?.children ?? [])
    .filter((n) => n.name === 'Model' && n.props[2] === 'LimbNode')
    .map((n) => String(n.props[1] ?? '').split('\0')[0]);
}

// Faces in every part of the file, drawn or not.
function fileFaces(parts) {
  let faces = 0;
  for (const part of parts) {
    const polygons = part.geometry.children.find((c) => c.name === 'PolygonVertexIndex').props[0];
    for (const v of polygons) if (v < 0) faces++;
  }
  return faces;
}

// How a UV map uses the texture: how much of it is covered, how much lies twice, how much is
// outside the square, and how many faces are squashed to nothing.
export function uvStats(uv, index) {
  const hits = new Uint16Array(RESOLUTION * RESOLUTION);
  let outside = 0, collapsed = 0;
  for (let i = 0; i < uv.length; i += 2) {
    if (uv[i] < -0.001 || uv[i] > 1.001 || uv[i + 1] < -0.001 || uv[i + 1] > 1.001) outside++;
  }
  const triangles = index.length / 3;
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t] * 2, index[t + 1] * 2, index[t + 2] * 2];
    const xs = [uv[a], uv[b], uv[c]].map((x) => x * RESOLUTION);
    const ys = [uv[a + 1], uv[b + 1], uv[c + 1]].map((y) => y * RESOLUTION);
    const area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
    if (Math.abs(area) < 1e-4) {
      collapsed++;
      continue;
    }
    const s = Math.sign(area);
    const edge = (i, j, px, py) => s * ((xs[j] - xs[i]) * (py - ys[i]) - (ys[j] - ys[i]) * (px - xs[i]));
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(RESOLUTION - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(RESOLUTION - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const [px, py] = [x + 0.5, y + 0.5];
        if (edge(0, 1, px, py) > 0 && edge(1, 2, px, py) > 0 && edge(2, 0, px, py) > 0) hits[y * RESOLUTION + x]++;
      }
    }
  }
  let covered = 0, twice = 0;
  for (const h of hits) {
    if (h) covered++;
    if (h > 1) twice++;
  }
  return {
    outside: uv.length ? outside / (uv.length / 2) : 0,
    collapsed: triangles ? collapsed / triangles : 0,
    coverage: covered / hits.length,
    overlap: covered ? twice / covered : 0,
  };
}

const usable = (s) => s.outside <= LIMITS.outside && s.overlap <= LIMITS.overlap
  && s.collapsed <= LIMITS.collapsed && s.coverage >= LIMITS.coverage;

// Notes about the file as a whole: what the game would make of it. A general model (one outside any
// mod's media folder, so not meant for the game) gets none of these.
export function fileNotes(tree, { general = false } = {}) {
  if (general) return [];
  const notes = [];
  const { parts, drawn } = meshParts(tree);
  const preview = creatorOf(tree).startsWith('PZ Skin Studio preview');
  if (parts.length > 1) {
    const others = parts.filter((p) => p !== drawn).map((p) => p.name);
    notes.push({
      level: 'warn',
      text: `This file has ${parts.length} separate objects. The game draws only one of them, "${drawn.name}" (pick "As the game draws it" above to see just that), so ${some(others)} won't appear in the game. In Blender, select all of them and join them into one object (Ctrl+J), then export again.`,
    });
  }
  if (drawn.materials.length > 1) {
    const others = drawn.materials.slice(1).map((m) => m.name);
    notes.push({
      level: 'warn',
      text: `"${drawn.name}" uses ${drawn.materials.length} materials. The game splits a model by material and draws only the first part, "${drawn.materials[0].name}", so faces with ${quoted(others)} won't appear in the game. A skin is one picture: give the whole model one material (in Blender, delete the extra material slots), then export again.`,
    });
  }
  const bones = boneNames(tree);
  if (drawn.hasBones && bones.length && !bones.some((b) => /^Bip01/i.test(b))) {
    notes.push({
      level: 'warn',
      text: `This model is rigged to a skeleton of its own (${bones.length} bones, such as ${quoted(bones.slice(0, 3))}), not the game's, whose bones are named Bip01_Pelvis, Bip01_Spine and so on. The game matches a model's bones to the character's by name, so as it is the model won't follow the character. Painting it here works; for the game it needs weighting to the game's skeleton, for example the armature from one of the pack's models.`,
    });
  }
  if (!drawn.hasBones && !preview) {
    notes.push({
      level: 'info',
      text: 'This model has no bones. Painting it here works, but the game puts clothing and Anthro bodies on a character through its bones, so before it can be worn the model needs rigging to the game\'s skeleton: parented to the armature with weights, the way the pack models are.',
    });
  }
  return notes;
}

export function facesNote(tree, { general = false } = {}) {
  const { parts } = meshParts(tree);
  const faces = fileFaces(parts);
  if (faces <= LIMITS.faces) return [];
  const what = parts.length > 1 ? 'file' : 'model';
  return [{
    level: 'info',
    text: general
      ? `This ${what} has ${faces.toLocaleString('en')} faces, so UV lines get crowded: tick "Outlines only" under the texture to see just where the UV map is cut.`
      : `This ${what} has ${faces.toLocaleString('en')} faces; the pack's models have up to about 3,400, and the game draws many characters at once, so it would need simplifying (in Blender, a Decimate modifier) to be worn. Here, UV lines get crowded: tick "Outlines only" under the texture to see just where the UV map is cut.`,
  }];
}

// Notes about the UV map of what's shown. layers: readUvLayers or readWholeUvLayers; index: the
// triangles shown. For a view of a multi-object file, cornerPart says which object each corner
// belongs to, so a second UV map is only suggested if every object shown has one.
export function uvNotes(layers, index, { cornerPart = null, whole = false } = {}) {
  const stats = uvStats(layers[0].uv, index);
  const problems = [];
  if (stats.collapsed > LIMITS.collapsed) {
    problems.push(`${percent(stats.collapsed)} of its faces are squashed flat on the UV map, so each of those takes a single colour. That's what a model looks like when it was never unwrapped`);
  }
  if (stats.overlap > LIMITS.overlap) {
    problems.push(`${percent(stats.overlap)} of the painted area lies on top of other parts, so painting one place paints the other too`);
  }
  if (stats.outside > LIMITS.outside) {
    problems.push(`${percent(stats.outside)} of it lies outside the texture square, where nothing gets its own spot on the skin`);
  }
  if (stats.coverage < LIMITS.coverage && stats.collapsed <= LIMITS.collapsed) {
    problems.push(`it only uses ${percent(stats.coverage)} of the texture, so the skin will look blocky`);
  }
  if (!problems.length) return [];

  const shown = cornerPart ? new Set(Array.from(index, (corner) => cornerPart[corner])) : null;
  // Objects unwrapped one at a time each fill the square, and only clash when shown together.
  if (whole && shown?.size > 1 && stats.overlap > LIMITS.overlap) {
    const alone = [...shown].every((part) => {
      const own = index.filter((corner, i) => cornerPart[index[i - (i % 3)]] === part);
      return usable(uvStats(layers[0].uv, own));
    });
    if (alone) {
      return [{
        level: 'warn',
        text: 'Each object has a good UV map of its own, but each one fills the whole square, so on one texture they lie on top of each other. Pick one object at a time above to paint it, or in Blender select all the objects, then Edit Mode, select all, U, Smart UV Project: done together, they share the square.',
      }];
    }
  }
  const fits = (layer) => !shown || !layer.parts || [...shown].every((part) => layer.parts[part]);
  const better = layers.slice(1).find((layer) => fits(layer) && usable(uvStats(layer.uv, index)));
  return [{
    level: 'warn',
    text: better
      ? `The first UV map, "${layers[0].name}", isn't usable: ${problems.join('; ')}. This file also has a UV map called "${better.name}" that looks right, but the game and the studio only read the first one. In Blender (Object Data properties, UV Maps), delete "${layers[0].name}" so "${better.name}" comes first, then export again.`
      : `The UV map isn't ready for a skin: ${problems.join('; ')}. In Blender: Edit Mode, select all, U, then Smart UV Project (or mark seams and Unwrap), then UV, Pack Islands to fit it in the square.${shown?.size > 1 ? ' Select all the objects first, so they share the square.' : ''} Export again and click Rescan.`,
  }];
}

// mesh: what readMesh made of the same tree. Returns notes, most important first, each
// { level: 'warn' | 'info', text }.
export function checkModel(tree, mesh, options = {}) {
  return [...fileNotes(tree, options), ...uvNotes(readUvLayers(tree), mesh.index), ...facesNote(tree, options)];
}
