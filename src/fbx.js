// Binary FBX reader. Only what a PZ clothing model needs: the mesh, its UVs and its bone
// weights. `inflate(Uint8Array) -> Uint8Array` is passed in so this runs in both Node and the
// browser.

const MAGIC = 'Kaydara FBX Binary';
const decoder = new TextDecoder('latin1');

// Bones, animation and embedded images: most of the bytes in the big files, none of them needed
// for a preview in the bind pose.
const NOT_MESH = new Set([
  'Deformer', 'Pose', 'AnimationStack', 'AnimationLayer', 'AnimationCurveNode', 'AnimationCurve',
  'Video', 'Texture', 'Takes',
]);

function readProperty(view, bytes, pos, inflate) {
  const type = String.fromCharCode(bytes[pos]);
  pos += 1;
  switch (type) {
    case 'Y': return [view.getInt16(pos, true), pos + 2];
    case 'C': return [bytes[pos] !== 0, pos + 1];
    case 'I': return [view.getInt32(pos, true), pos + 4];
    case 'F': return [view.getFloat32(pos, true), pos + 4];
    case 'D': return [view.getFloat64(pos, true), pos + 8];
    case 'L': return [Number(view.getBigInt64(pos, true)), pos + 8];
    case 'S':
    case 'R': {
      const len = view.getUint32(pos, true);
      pos += 4;
      const slice = bytes.subarray(pos, pos + len);
      return [type === 'S' ? decoder.decode(slice) : slice, pos + len];
    }
    case 'f': case 'd': case 'l': case 'i': case 'b': {
      const count = view.getUint32(pos, true);
      const encoding = view.getUint32(pos + 4, true);
      const byteLen = view.getUint32(pos + 8, true);
      pos += 12;
      const raw = bytes.subarray(pos, pos + byteLen);
      const data = encoding === 1 ? inflate(raw) : raw;
      return [decodeArray(type, data, count), pos + byteLen];
    }
    default:
      throw new Error(`Unknown FBX property type "${type}" at byte ${pos - 1}`);
  }
}

function decodeArray(type, data, count) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let out;
  switch (type) {
    case 'f':
      out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, true);
      return out;
    case 'd':
      out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[i] = dv.getFloat64(i * 8, true);
      return out;
    case 'i':
      out = new Int32Array(count);
      for (let i = 0; i < count; i++) out[i] = dv.getInt32(i * 4, true);
      return out;
    case 'l':
      out = new Array(count);
      for (let i = 0; i < count; i++) out[i] = Number(dv.getBigInt64(i * 8, true));
      return out;
    default:
      return data.subarray(0, count);
  }
}

function readNode(view, bytes, pos, wide, inflate, skip) {
  const u = (p) => (wide ? Number(view.getBigUint64(p, true)) : view.getUint32(p, true));
  const step = wide ? 8 : 4;
  const end = u(pos);
  const numProps = u(pos + step);
  const propLen = u(pos + step * 2);
  const nameLen = bytes[pos + step * 3];
  pos += step * 3 + 1;
  if (end === 0) return [null, pos];
  const name = decoder.decode(bytes.subarray(pos, pos + nameLen));
  pos += nameLen;
  const node = { name, props: [], children: [] };
  const propsEnd = pos + propLen;
  for (let i = 0; i < numProps; i++) {
    const [value, next] = readProperty(view, bytes, pos, inflate);
    node.props.push(value);
    pos = next;
  }
  // A skipped node keeps its own id and type, which say what it is, but not its contents.
  if (skip.has(name)) return [node, end];
  pos = propsEnd;
  while (pos < end) {
    const [child, next] = readNode(view, bytes, pos, wide, inflate, skip);
    pos = next;
    if (child === null) break;
    node.children.push(child);
  }
  return [node, end];
}

export function parseFbxTree(buffer, inflate, skip = NOT_MESH) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (decoder.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) {
    if (/^\s*;\s*FBX/.test(decoder.decode(bytes.subarray(0, 64)))) {
      throw new Error('this FBX is saved as text (ASCII), and the studio reads binary FBX only. Export it again as binary FBX');
    }
    throw new Error('Not a binary FBX file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(23, true);
  const wide = version >= 7500;
  const root = { name: '', props: [], children: [], version };
  let pos = 27;
  while (pos < bytes.length) {
    const [child, next] = readNode(view, bytes, pos, wide, inflate, skip);
    pos = next;
    if (child === null) break;
    root.children.push(child);
  }
  return root;
}


const child = (node, name) => node.children.find((c) => c.name === name);
const children = (node, name) => node.children.filter((c) => c.name === name);
const objectName = (node) => String(node.props[1] ?? '').split('\0')[0];
const isMesh = (geometry) => child(geometry, 'Vertices') && child(geometry, 'PolygonVertexIndex');

// ---- Which mesh the game draws ---------------------------------------------------------------
// The game reads a model through Assimp, which makes one mesh for each object in the file and splits
// an object with several materials into one mesh per material. It then draws just one of them: the
// first with bones, or the first of all if none has bones (ProcessedAiScene.findMesh). Assimp's order
// is the file's object tree, depth first, and each object's materials in the order its faces use them.

function sceneOf(tree) {
  const objects = child(tree, 'Objects') ?? { children: [] };
  const byId = new Map(objects.children.map((node) => [node.props[0], node]));
  const below = new Map();
  for (const c of child(tree, 'Connections')?.children ?? []) {
    if (c.props[0] !== 'OO') continue;
    if (!below.has(c.props[2])) below.set(c.props[2], []);
    below.get(c.props[2]).push(c.props[1]);
  }
  const under = (id, name) => (below.get(id) ?? []).map((k) => byId.get(k)).filter((n) => n?.name === name);
  const parentModel = new Map();
  for (const [parent, ids] of below) {
    if (byId.get(parent)?.name !== 'Model') continue;
    for (const id of ids) if (!parentModel.has(id)) parentModel.set(id, byId.get(parent));
  }
  return { objects, byId, under, parentModel };
}

function materialsOf(geometry) {
  const layer = child(geometry, 'LayerElementMaterial');
  const list = layer && child(layer, 'Materials')?.props[0];
  if (!list?.length) return null;
  const allSame = child(layer, 'MappingInformationType')?.props[0] === 'AllSame';
  return (polygon) => (allSame ? list[0] : list[polygon] ?? list[0]);
}

export function meshParts(tree) {
  const scene = sceneOf(tree);
  const parts = [];
  const seen = new Set();
  const addPart = (geometry, model) => {
    seen.add(geometry.props[0]);
    const material = materialsOf(geometry);
    const polygons = child(geometry, 'PolygonVertexIndex').props[0];
    const used = [];
    if (material) {
      let p = 0;
      for (let i = 0; i < polygons.length; i++) {
        if (polygons[i] >= 0) continue;
        const m = material(p++);
        if (!used.includes(m)) used.push(m);
      }
    }
    const materialNames = model ? scene.under(model.props[0], 'Material').map(objectName) : [];
    parts.push({
      geometry,
      model,
      name: objectName(model ?? geometry) || objectName(geometry) || 'Mesh',
      hasBones: scene.under(geometry.props[0], 'Deformer').some((d) => d.props[2] === 'Skin'),
      material,
      materials: used.map((m) => ({ index: m, name: materialNames[m] ?? `Material ${m + 1}` })),
    });
  };
  const visit = (id) => {
    for (const model of scene.under(id, 'Model')) {
      for (const geometry of scene.under(model.props[0], 'Geometry')) {
        if (isMesh(geometry) && !seen.has(geometry.props[0])) addPart(geometry, model);
      }
      visit(model.props[0]);
    }
  };
  visit(0);
  // A mesh outside the tree is still read, after the rest.
  for (const geometry of children(scene.objects, 'Geometry')) {
    if (isMesh(geometry) && !seen.has(geometry.props[0])) addPart(geometry, scene.parentModel.get(geometry.props[0]) ?? null);
  }
  if (!parts.length) throw new Error('No mesh in this FBX');
  const drawn = parts.find((p) => p.hasBones) ?? parts[0];
  const drawnMaterial = drawn.materials[0]?.index;
  // Whether a polygon of a part is the one the game draws.
  const keeps = (part) => (part !== drawn ? () => false
    : !part.material || part.materials.length < 2 ? () => true
      : (polygon) => part.material(polygon) === drawnMaterial);
  return { scene, parts, drawn, keeps };
}

// ---- UVs -------------------------------------------------------------------------------------

// The game draws UV channel 0, the first layer in the file. Some models carry extra layers, named
// map1, uv0 or UVMap in no fixed order, that are collapsed to a point or hold leftover islands, so
// the name can't be used to pick.
function uvLayers(geometry) {
  const layers = children(geometry, 'LayerElementUV');
  const first = layers.find((l) => l.props[0] === 0) ?? layers[0];
  return first ? [first, ...layers.filter((l) => l !== first)] : [];
}

function uvChannel0(geometry) {
  const layer = uvLayers(geometry)[0];
  if (!layer) {
    throw new Error('it has no UV map, so a skin has nowhere to go. In Blender, unwrap it (Edit Mode, select all, U, Smart UV Project) and export it again');
  }
  return layer;
}

// Reads one value of a layer for a polygon corner, whichever way the layer is stored.
function layerReader(layer, dataName, indexName, stride) {
  const data = child(layer, dataName).props[0];
  const index = child(layer, indexName)?.props[0];
  const perVertex = child(layer, 'MappingInformationType').props[0].startsWith('ByVert');
  const indexed = child(layer, 'ReferenceInformationType').props[0] !== 'Direct' && index;
  return (corner, vertex, out, at) => {
    const slot = perVertex ? vertex : corner;
    const from = (indexed ? index[slot] : slot) * stride;
    for (let k = 0; k < stride; k++) out[at + k] = data[from + k] ?? 0;
  };
}

const polygonEnd = (value) => value < 0;
const vertexOf = (value) => (value < 0 ? ~value : value);

function mix(a, b, seed) {
  let h = Math.imul(a ^ seed, 0x85ebca6b) ^ Math.imul(b + seed, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  return (h ^ (h >>> 13)) >>> 0;
}

// Fingerprint of a model's UV layout: two models with the same one can wear each other's skins.
// Sums, so the order of the polygons and their corners doesn't matter, and rounded so that the
// same layout exported twice still matches. Only the part the game draws counts.
export function readLayout(tree) {
  const { drawn, keeps } = meshParts(tree);
  const geometry = drawn.geometry;
  const keep = keeps(drawn);
  const polygons = child(geometry, 'PolygonVertexIndex').props[0];
  const read = layerReader(uvChannel0(geometry), 'UV', 'UVIndex', 2);
  const uv = [0, 0];
  let a = 0, b = 0, polyA = 0, polyB = 0, count = 0, polygon = 0;
  const used = new Set();
  for (let i = 0; i < polygons.length; i++) {
    const kept = keep(polygon);
    if (kept) {
      read(i, vertexOf(polygons[i]), uv, 0);
      const u = Math.round(uv[0] * 1024), v = Math.round(uv[1] * 1024);
      polyA = (polyA + mix(u, v, 0x9e3779b9)) >>> 0;
      polyB = (polyB + mix(v, u, 0x7f4a7c15)) >>> 0;
      used.add(vertexOf(polygons[i]));
    }
    if (polygonEnd(polygons[i])) {
      if (kept) {
        a = (a + mix(polyA, polyB, 1)) >>> 0;
        b = (b + mix(polyB, polyA, 2)) >>> 0;
        count++;
      }
      polyA = polyB = 0;
      polygon++;
    }
  }
  const verts = drawn.materials.length < 2 ? child(geometry, 'Vertices').props[0].length / 3 : used.size;
  const hex = (n) => n.toString(16).padStart(8, '0');
  return { layout: hex(a) + hex(b), verts, polys: count };
}

// ---- Placing the parts -----------------------------------------------------------------------
// 4 × 4 matrices, column-major like WebGL, applied to column vectors.

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  }
  return out;
}
const translation = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scaling = ([x, y, z]) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
function axisTurn(axis, degrees) {
  const r = (degrees * Math.PI) / 180;
  const [c, s] = [Math.cos(r), Math.sin(r)];
  if (axis === 0) return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  if (axis === 1) return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
// FBX's RotationOrder: 0 is XYZ (X turns first), then XZY, YZX, YXZ, ZXY, ZYX.
const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 2, 0], [1, 0, 2], [2, 0, 1], [2, 1, 0]];
function euler(degrees, order = 0) {
  let m = identity();
  for (const axis of ORDERS[order] ?? ORDERS[0]) m = multiply(axisTurn(axis, degrees[axis]), m);
  return m;
}
function invert(m) {
  // Affine inverse: the 3 × 3 part by cofactors, then the translation.
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  if (!det) return identity();
  const inv = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, 0,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, 0,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det, 0,
    0, 0, 0, 1,
  ];
  const t = [m[12], m[13], m[14]];
  for (let r = 0; r < 3; r++) inv[12 + r] = -(inv[r] * t[0] + inv[4 + r] * t[1] + inv[8 + r] * t[2]);
  return inv;
}
const determinant = (m) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

function properties(model) {
  const list = model && child(model, 'Properties70')?.children;
  const out = new Map();
  for (const p of list ?? []) out.set(p.props[0], p.props.slice(4));
  return out;
}

// FBX's own formula for an object's place in its parent: T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹.
function localMatrix(model) {
  const p = properties(model);
  const v = (name, fallback = [0, 0, 0]) => (p.get(name)?.slice(0, 3).map(Number) ?? fallback);
  const order = Number(p.get('RotationOrder')?.[0] ?? 0);
  const pivotR = v('RotationPivot');
  const pivotS = v('ScalingPivot');
  return [
    translation(v('Lcl Translation')), translation(v('RotationOffset')), translation(pivotR),
    euler(v('PreRotation')), euler(v('Lcl Rotation'), order), invert(euler(v('PostRotation'))),
    translation(pivotR.map((x) => -x)), translation(v('ScalingOffset')), translation(pivotS),
    scaling(v('Lcl Scaling', [1, 1, 1])), translation(pivotS.map((x) => -x)),
  ].reduce(multiply);
}

// An object's place in the file, its parents included, and its mesh's own offset (GeometricTranslation
// and so on, which only 3ds Max tends to use).
function worldMatrix(scene, model) {
  if (!model) return identity();
  let m = localMatrix(model);
  for (let parent = scene.parentModel.get(model.props[0]), guard = 0; parent && guard < 64; parent = scene.parentModel.get(parent.props[0]), guard++) {
    m = multiply(localMatrix(parent), m);
  }
  const p = properties(model);
  const v = (name, fallback = [0, 0, 0]) => (p.get(name)?.slice(0, 3).map(Number) ?? fallback);
  const geometric = [translation(v('GeometricTranslation')), euler(v('GeometricRotation')), scaling(v('GeometricScaling', [1, 1, 1]))].reduce(multiply);
  return multiply(m, geometric);
}

// Just the turning part of a matrix, without size. A skinned model gets its size and place from its
// bones, so only the way it faces is kept: exporters often stand a model up that way.
function turningOf(m) {
  const out = identity();
  for (let c = 0; c < 3; c++) {
    const length = Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]) || 1;
    for (let r = 0; r < 3; r++) out[c * 4 + r] = m[c * 4 + r] / length;
  }
  return out;
}

function transform(values, m, stride = 3, direction = false) {
  for (let i = 0; i < values.length; i += stride) {
    const [x, y, z] = [values[i], values[i + 1], values[i + 2]];
    values[i] = m[0] * x + m[4] * y + m[8] * z + (direction ? 0 : m[12]);
    values[i + 1] = m[1] * x + m[5] * y + m[9] * z + (direction ? 0 : m[13]);
    values[i + 2] = m[2] * x + m[6] * y + m[10] * z + (direction ? 0 : m[14]);
  }
}

const isTurnOnly = (m) => m.every((x, i) => Math.abs(x - identity()[i]) < 1e-12);

// A skinned model gets its size in the game from its bones, so the node's scale says nothing: it's
// 100 on a model already 1 unit tall, and 180,000 on one that's 0.01. Characters end up about 1 unit
// tall, so only a model far from that is scaled to it.
function heightFactor(position) {
  let low = Infinity, high = -Infinity;
  for (let i = 1; i < position.length; i += 3) {
    low = Math.min(low, position[i]);
    high = Math.max(high, position[i]);
  }
  const height = high - low;
  return height >= 0.5 && height <= 2 || !(height > 0) ? 1 : 1 / height;
}

// Splits a polygon into triangles the way the game's importer (Assimp's Triangulate step) does. A
// quad fans out from its one inward-pointing corner, if it has one, or else from its first corner.
// Bigger faces are cut ear by ear on their own plane, so a concave face from Blender doesn't come out
// with holes or spikes.
function triangulate(points, start, count, out) {
  if (count === 3) {
    out.push(start, start + 1, start + 2);
    return;
  }
  if (count === 4) {
    const from = concaveCorner(points, start);
    const at = (k) => start + (from + k) % 4;
    out.push(at(0), at(1), at(2), at(0), at(2), at(3));
    return;
  }
  // Newell's normal picks the plane to flatten onto.
  let nx = 0, ny = 0, nz = 0;
  for (let k = 0; k < count; k++) {
    const a = (start + k) * 3, b = (start + (k + 1) % count) * 3;
    nx += (points[a + 1] - points[b + 1]) * (points[a + 2] + points[b + 2]);
    ny += (points[a + 2] - points[b + 2]) * (points[a] + points[b]);
    nz += (points[a] - points[b]) * (points[a + 1] + points[b + 1]);
  }
  const [ax, ay] = Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz) ? [1, 2]
    : Math.abs(ny) >= Math.abs(nz) ? [2, 0] : [0, 1];
  const sign = (Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz) ? nx : Math.abs(ny) >= Math.abs(nz) ? ny : nz) >= 0 ? 1 : -1;
  const flat = (k) => [points[(start + k) * 3 + ax], points[(start + k) * 3 + ay]];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const left = Array.from({ length: count }, (_, k) => k);
  let guard = count * count;
  while (left.length > 3 && guard-- > 0) {
    let cut = false;
    for (let i = 0; i < left.length; i++) {
      const [p, k, n] = [left[(i + left.length - 1) % left.length], left[i], left[(i + 1) % left.length]];
      const [a, b, c] = [flat(p), flat(k), flat(n)];
      if (sign * cross(a, b, c) <= 0) continue;
      const inside = left.some((q) => {
        if (q === p || q === k || q === n) return false;
        const d = flat(q);
        return sign * cross(a, b, d) >= 0 && sign * cross(b, c, d) >= 0 && sign * cross(c, a, d) >= 0;
      });
      if (inside) continue;
      out.push(start + p, start + k, start + n);
      left.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  // Whatever is left (a twisted or broken face) goes corner to corner.
  for (let k = 1; k < left.length - 1; k++) out.push(start + left[0], start + left[k], start + left[k + 1]);
}

function concaveCorner(points, start) {
  const p = (k) => [points[(start + k) * 3], points[(start + k) * 3 + 1], points[(start + k) * 3 + 2]];
  const unit = (u, v) => {
    const d = [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    const length = Math.fround(Math.hypot(...d));
    return d.map((x) => Math.fround(x / length));
  };
  const dot = (u, v) => Math.fround(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]);
  for (let i = 0; i < 4; i++) {
    const v = p(i);
    const diagonal = unit(p((i + 2) % 4), v);
    const angle = Math.acos(dot(unit(p((i + 3) % 4), v), diagonal)) + Math.acos(dot(unit(p((i + 1) % 4), v), diagonal));
    if (angle > Math.fround(Math.PI)) return i;
  }
  return 0;
}

// Polygon outlines where the UV map is cut: edges that only one polygon has in UV space. On a dense
// model that's the only readable picture of the layout.
export function uvOutline(uv, edges) {
  const key = (corner) => `${Math.round(uv[corner * 2] * 8192)},${Math.round(uv[corner * 2 + 1] * 8192)}`;
  const counts = new Map();
  const keys = [];
  for (let i = 0; i < edges.length; i += 2) {
    const [a, b] = [key(edges[i]), key(edges[i + 1])];
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    keys.push(k);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = [];
  for (let i = 0; i < edges.length; i += 2) if (counts.get(keys[i / 2]) === 1) out.push(edges[i], edges[i + 1]);
  return new Uint32Array(out);
}

// Flat arrays ready to draw: one vertex per polygon corner, since FBX stores UVs and normals per
// corner. `uv` has its origin at the top left of the image. `edges` are the polygon outlines,
// for the wireframe and the UV guide, and `outline` just the edges where the UV map is cut.
// `ghost` holds the parts of the file that the game doesn't draw, to show in grey.
export function readMesh(tree) {
  const { scene, parts, drawn, keeps } = meshParts(tree);
  const geometry = drawn.geometry;
  const vertices = child(geometry, 'Vertices').props[0];
  const polygons = child(geometry, 'PolygonVertexIndex').props[0];
  const readUv = layerReader(uvChannel0(geometry), 'UV', 'UVIndex', 2);
  const normalLayer = child(geometry, 'LayerElementNormal');
  const readNormal = normalLayer && child(normalLayer, 'Normals') && layerReader(normalLayer, 'Normals', 'NormalsIndex', 3);
  const keep = keeps(drawn);

  const position = [];
  const normal = [];
  const uv = [];
  const index = [];
  const edges = [];
  const scratch = [0, 0, 0];
  let start = 0, polygon = 0, corner = 0;
  for (let i = 0; i < polygons.length; i++) {
    if (keep(polygon)) {
      const vertex = vertexOf(polygons[i]);
      position.push(vertices[vertex * 3], vertices[vertex * 3 + 1], vertices[vertex * 3 + 2]);
      readUv(i, vertex, scratch, 0);
      uv.push(scratch[0], 1 - Math.fround(scratch[1]));
      if (readNormal) {
        readNormal(i, vertex, scratch, 0);
        normal.push(scratch[0], scratch[1], scratch[2]);
      } else normal.push(0, 0, 0);
      corner++;
    }
    if (polygonEnd(polygons[i])) {
      if (keep(polygon)) {
        const count = corner - start;
        triangulate(position, start, count, index);
        for (let k = start; k < corner - 1; k++) edges.push(k, k + 1);
        edges.push(corner - 1, start);
        start = corner;
      }
      polygon++;
    }
  }

  // The drawn part keeps only the way it faces; the other parts sit where they are relative to it.
  const world = worldMatrix(scene, drawn.model);
  const turn = turningOf(world);
  const out = {
    position: new Float32Array(position),
    normal: new Float32Array(normal),
    uv: new Float32Array(uv),
    hasNormals: !!readNormal,
  };
  if (!isTurnOnly(turn)) {
    transform(out.position, turn);
    transform(out.normal, turn, 3, true);
  }
  if (determinant(turn) < 0) flipWinding(index);
  const factor = heightFactor(out.position);
  if (factor !== 1) for (let i = 0; i < out.position.length; i++) out.position[i] *= factor;
  out.index = new Uint32Array(index);
  out.edges = new Uint32Array(edges);
  out.outline = uvOutline(out.uv, out.edges);

  const toDrawn = multiply(turn, invert(world));
  const ghostPosition = [];
  const ghostIndex = [];
  for (const part of parts) {
    const keepHere = keeps(part);
    const points = child(part.geometry, 'Vertices').props[0];
    const corners = child(part.geometry, 'PolygonVertexIndex').props[0];
    const m = multiply(toDrawn, worldMatrix(scene, part.model));
    const first = ghostPosition.length / 3;
    const local = [];
    let from = 0, p = 0;
    for (let i = 0; i < corners.length; i++) {
      if (!keepHere(p)) {
        const v = vertexOf(corners[i]);
        local.push(points[v * 3], points[v * 3 + 1], points[v * 3 + 2]);
      }
      if (polygonEnd(corners[i])) {
        if (!keepHere(p)) {
          const count = local.length / 3 - from;
          const tris = [];
          triangulate(local, from, count, tris);
          for (const t of tris) ghostIndex.push(first + t);
          from = local.length / 3;
        }
        p++;
      }
    }
    if (!local.length) continue;
    const placed = new Float32Array(local);
    transform(placed, m);
    for (let i = 0; i < placed.length; i++) ghostPosition.push(placed[i] * factor);
  }
  if (ghostIndex.length) out.ghost = { position: new Float32Array(ghostPosition), index: new Uint32Array(ghostIndex) };
  return out;
}

function flipWinding(index) {
  for (let i = 0; i + 2 < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
}

// Every UV map of the part the game draws, in the same corner order as readMesh. The first is the
// one the game uses.
export function readUvLayers(tree) {
  const { drawn, keeps } = meshParts(tree);
  const keep = keeps(drawn);
  const polygons = child(drawn.geometry, 'PolygonVertexIndex').props[0];
  return uvLayers(drawn.geometry).map((layer) => {
    const read = layerReader(layer, 'UV', 'UVIndex', 2);
    const uv = [];
    const scratch = [0, 0];
    let polygon = 0;
    for (let i = 0; i < polygons.length; i++) {
      if (keep(polygon)) {
        read(i, vertexOf(polygons[i]), scratch, 0);
        uv.push(scratch[0], 1 - Math.fround(scratch[1]));
      }
      if (polygonEnd(polygons[i])) polygon++;
    }
    return { name: String(child(layer, 'Name')?.props[0] ?? '') || 'UV map', uv: new Float32Array(uv) };
  });
}

// What made the file, from its header: "Blender (stable FBX IO) - 4.2.3 LTS - 5.12.5" and the like.
export function creatorOf(tree) {
  const header = child(tree, 'FBXHeaderExtension');
  return String((header && child(header, 'Creator')?.props[0]) ?? child(tree, 'Creator')?.props[0] ?? '');
}

// ---- Views: which faces are shown and painted --------------------------------------------------
// A file with one object and one material has one view: the game's. Anything else can be looked at
// whole, as the game draws it, or one object at a time. Every view of a file reads the same UV
// maps, so a texture painted in one view fits the others.

export function viewsOf(tree) {
  const { parts, drawn } = meshParts(tree);
  if (parts.length < 2 && drawn.materials.length < 2) return [];
  const views = [
    { id: 'whole', label: parts.length > 1 ? `Whole model (${parts.length} objects)` : 'Whole model' },
    { id: 'game', label: `As the game draws it: "${drawn.name}"`, game: true },
  ];
  if (parts.length > 1) parts.forEach((part, i) => views.push({ id: `part:${i}`, label: part.name, part: i }));
  return views;
}

// For a view: whether each polygon of a part is in it.
function selection(tree, view) {
  const found = meshParts(tree);
  if (view === 'game') return { ...found, take: found.keeps };
  if (view === 'whole') return { ...found, take: () => () => true };
  const index = Number(/^part:(\d+)$/.exec(view)?.[1]);
  const chosen = found.parts[index];
  if (!chosen) throw new Error(`no view called ${view}`);
  return { ...found, take: (part) => (part === chosen ? () => true : () => false) };
}

// UV channel 0 of a part, or nothing: in a view of several objects, one without UVs counts as all
// squashed to a point rather than spoiling the rest.
function uvReaderOf(geometry) {
  const layer = uvLayers(geometry)[0];
  return layer ? layerReader(layer, 'UV', 'UVIndex', 2) : (corner, vertex, out, at) => { out[at] = 0; out[at + 1] = 0; };
}

export function readViewLayout(tree, view) {
  if (view === 'game') return readLayout(tree);
  const { parts, take } = selection(tree, view);
  const uv = [0, 0];
  let a = 0, b = 0, count = 0, verts = 0;
  for (const part of parts) {
    const keep = take(part);
    const polygons = child(part.geometry, 'PolygonVertexIndex').props[0];
    const read = uvReaderOf(part.geometry);
    let polyA = 0, polyB = 0, polygon = 0, any = false;
    for (let i = 0; i < polygons.length; i++) {
      const kept = keep(polygon);
      if (kept) {
        any = true;
        read(i, vertexOf(polygons[i]), uv, 0);
        const u = Math.round(uv[0] * 1024), v = Math.round(uv[1] * 1024);
        polyA = (polyA + mix(u, v, 0x9e3779b9)) >>> 0;
        polyB = (polyB + mix(v, u, 0x7f4a7c15)) >>> 0;
      }
      if (polygonEnd(polygons[i])) {
        if (kept) {
          a = (a + mix(polyA, polyB, 1)) >>> 0;
          b = (b + mix(polyB, polyA, 2)) >>> 0;
          count++;
        }
        polyA = polyB = 0;
        polygon++;
      }
    }
    if (any) verts += child(part.geometry, 'Vertices').props[0].length / 3;
  }
  const hex = (n) => n.toString(16).padStart(8, '0');
  return { layout: hex(a) + hex(b), verts, polys: count };
}

// The 3 × 3 matrix that turns normals the way m turns shapes, scaling included.
function normalMatrix(m) {
  const inv = invert([m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1]);
  return [inv[0], inv[4], inv[8], 0, inv[1], inv[5], inv[9], 0, inv[2], inv[6], inv[10], 0, 0, 0, 0, 1];
}

// Every polygon of every object, placed where the file puts it: the file's own space, which is what
// Blender shows, scaled to the stage as readMesh does. Each corner records its object (cornerPart) and whether the game draws it (cornerGame), and
// viewMesh picks a view's faces out of it.
export function readWholeMesh(tree) {
  const { scene, parts, keeps } = meshParts(tree);
  const position = [], normal = [], uv = [], index = [], edges = [], cornerPart = [], cornerGame = [];
  const scratch = [0, 0, 0];
  parts.forEach((part, p) => {
    const geometry = part.geometry;
    const vertices = child(geometry, 'Vertices').props[0];
    const polygons = child(geometry, 'PolygonVertexIndex').props[0];
    const readUv = uvReaderOf(geometry);
    const normalLayer = child(geometry, 'LayerElementNormal');
    const readNormal = normalLayer && child(normalLayer, 'Normals') && layerReader(normalLayer, 'Normals', 'NormalsIndex', 3);
    const game = keeps(part);
    const m = worldMatrix(scene, part.model);
    const first = position.length / 3;
    const local = [];
    const localNormal = [];
    const tris = [];
    let start = 0, polygon = 0;
    for (let i = 0; i < polygons.length; i++) {
      const vertex = vertexOf(polygons[i]);
      local.push(vertices[vertex * 3], vertices[vertex * 3 + 1], vertices[vertex * 3 + 2]);
      readUv(i, vertex, scratch, 0);
      uv.push(scratch[0], 1 - Math.fround(scratch[1]));
      if (readNormal) {
        readNormal(i, vertex, scratch, 0);
        localNormal.push(scratch[0], scratch[1], scratch[2]);
      }
      cornerPart.push(p);
      cornerGame.push(game(polygon) ? 1 : 0);
      if (polygonEnd(polygons[i])) {
        const count = i + 1 - start;
        const before = tris.length;
        triangulate(local, start, count, tris);
        if (!readNormal) {
          // No normals in the file: the face's own, from its first triangle.
          const [a, b, c] = [tris[before], tris[before + 1], tris[before + 2]].map((k) => local.slice(k * 3, k * 3 + 3));
          const n = [
            (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
            (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
          ];
          for (let k = 0; k < count; k++) localNormal.push(n[0], n[1], n[2]);
        }
        for (let k = start; k < i; k++) edges.push(first + k, first + k + 1);
        edges.push(first + i, first + start);
        start = i + 1;
        polygon++;
      }
    }
    const placed = new Float64Array(local);
    const turned = new Float64Array(localNormal);
    transform(placed, m);
    transform(turned, normalMatrix(m), 3, true);
    for (let k = 0; k < turned.length; k += 3) {
      const length = Math.hypot(turned[k], turned[k + 1], turned[k + 2]) || 1;
      turned[k] /= length; turned[k + 1] /= length; turned[k + 2] /= length;
    }
    for (let k = 0; k < placed.length; k++) {
      position.push(placed[k]);
      normal.push(turned[k]);
    }
    if (determinant(m) < 0) flipWinding(tris);
    for (const t of tris) index.push(first + t);
  });
  const out = {
    whole: true,
    position: new Float32Array(position),
    normal: new Float32Array(normal),
    uv: new Float32Array(uv),
    hasNormals: true,
    index: new Uint32Array(index),
    edges: new Uint32Array(edges),
    cornerPart: new Uint16Array(cornerPart),
    cornerGame: new Uint8Array(cornerGame),
    partNames: parts.map((part) => part.name),
  };
  const factor = heightFactor(out.position);
  if (factor !== 1) for (let i = 0; i < out.position.length; i++) out.position[i] *= factor;
  return out;
}

// One view of a whole mesh, shaped like readMesh's: its triangles and edges solid, the rest of the
// file as the grey ghost. The arrays of positions are shared, not copied.
export function viewMesh(whole, view) {
  const part = /^part:(\d+)$/.exec(view)?.[1];
  const inView = view === 'whole' ? () => true
    : view === 'game' ? (corner) => whole.cornerGame[corner] === 1
      : (corner) => whole.cornerPart[corner] === Number(part);
  const index = [], ghost = [], edges = [];
  for (let t = 0; t < whole.index.length; t += 3) {
    (inView(whole.index[t]) ? index : ghost).push(whole.index[t], whole.index[t + 1], whole.index[t + 2]);
  }
  for (let e = 0; e < whole.edges.length; e += 2) if (inView(whole.edges[e])) edges.push(whole.edges[e], whole.edges[e + 1]);
  const out = {
    position: whole.position, normal: whole.normal, uv: whole.uv, hasNormals: true,
    index: new Uint32Array(index), edges: new Uint32Array(edges), cornerPart: whole.cornerPart,
  };
  out.outline = uvOutline(out.uv, out.edges);
  if (ghost.length) out.ghost = { position: whole.position, index: new Uint32Array(ghost) };
  return out;
}

// Every UV map of every object, in readWholeMesh's corner order. A map is named after the first
// object's; `parts` says which objects have it.
export function readWholeUvLayers(tree) {
  const { parts } = meshParts(tree);
  const count = Math.max(...parts.map((p) => uvLayers(p.geometry).length));
  const corners = parts.reduce((n, p) => n + child(p.geometry, 'PolygonVertexIndex').props[0].length, 0);
  const layers = [];
  for (let k = 0; k < count; k++) {
    const uv = new Float32Array(corners * 2);
    const has = [];
    let at = 0;
    let name = '';
    for (const part of parts) {
      const layer = uvLayers(part.geometry)[k];
      const polygons = child(part.geometry, 'PolygonVertexIndex').props[0];
      has.push(!!layer);
      if (layer) {
        name ||= String(child(layer, 'Name')?.props[0] ?? '');
        const read = layerReader(layer, 'UV', 'UVIndex', 2);
        const scratch = [0, 0];
        for (let i = 0; i < polygons.length; i++) {
          read(i, vertexOf(polygons[i]), scratch, 0);
          uv[(at + i) * 2] = scratch[0];
          uv[(at + i) * 2 + 1] = 1 - Math.fround(scratch[1]);
        }
      }
      at += polygons.length;
    }
    layers.push({ name: name || (k ? `UV map ${k + 1}` : 'UV map'), uv, parts: has });
  }
  return layers;
}
