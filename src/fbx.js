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
  if (skip.has(name)) return [node, end];
  const propsEnd = pos + propLen;
  for (let i = 0; i < numProps; i++) {
    const [value, next] = readProperty(view, bytes, pos, inflate);
    node.props.push(value);
    pos = next;
  }
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

function firstMesh(tree) {
  const objects = child(tree, 'Objects');
  const geometry = objects && children(objects, 'Geometry')
    .find((g) => child(g, 'Vertices') && child(g, 'PolygonVertexIndex'));
  if (!geometry) throw new Error('No mesh in this FBX');
  return geometry;
}

// The game draws UV channel 0, the first layer in the file. Some models carry extra layers, named
// map1, uv0 or UVMap in no fixed order, that are collapsed to a point or hold leftover islands, so
// the name can't be used to pick.
function uvChannel0(geometry) {
  const layers = children(geometry, 'LayerElementUV');
  const layer = layers.find((l) => l.props[0] === 0) ?? layers[0];
  if (!layer) throw new Error('This FBX has no UVs, so a skin cannot be applied to it');
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
    for (let k = 0; k < stride; k++) out[at + k] = data[from + k];
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
// same layout exported twice still matches.
export function readLayout(tree) {
  const geometry = firstMesh(tree);
  const polygons = child(geometry, 'PolygonVertexIndex').props[0];
  const read = layerReader(uvChannel0(geometry), 'UV', 'UVIndex', 2);
  const uv = [0, 0];
  let a = 0, b = 0, polyA = 0, polyB = 0, count = 0;
  for (let i = 0; i < polygons.length; i++) {
    read(i, vertexOf(polygons[i]), uv, 0);
    const u = Math.round(uv[0] * 1024), v = Math.round(uv[1] * 1024);
    polyA = (polyA + mix(u, v, 0x9e3779b9)) >>> 0;
    polyB = (polyB + mix(v, u, 0x7f4a7c15)) >>> 0;
    if (polygonEnd(polygons[i])) {
      a = (a + mix(polyA, polyB, 1)) >>> 0;
      b = (b + mix(polyB, polyA, 2)) >>> 0;
      polyA = polyB = 0;
      count++;
    }
  }
  const hex = (n) => n.toString(16).padStart(8, '0');
  return {
    layout: hex(a) + hex(b),
    verts: child(geometry, 'Vertices').props[0].length / 3,
    polys: count,
  };
}

// Some exporters leave the mesh lying down and stand it up with its node's rotation, so the
// node has to be applied. All 690 Anthro models seen so far only rotate about X, by -90 or not at all.
function nodeRotation(tree, geometry) {
  const link = child(tree, 'Connections')?.children.find((c) => c.props[1] === geometry.props[0]);
  const node = children(child(tree, 'Objects'), 'Model').find((m) => m.props[0] === link?.props[2]);
  const rotation = node && child(node, 'Properties70')?.children.find((p) => p.props[0] === 'Lcl Rotation');
  return rotation ? rotation.props.slice(4, 7) : [0, 0, 0];
}

function rotate(values, degrees) {
  if (degrees.every((d) => d === 0)) return;
  const [ax, ay, az] = degrees.map((d) => (d * Math.PI) / 180);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  for (let i = 0; i < values.length; i += 3) {
    const [x, y, z] = [values[i], values[i + 1], values[i + 2]];
    const y1 = y * cx - z * sx;
    const z1 = y * sx + z * cx;
    const x2 = x * cy + z1 * sy;
    values[i] = x2 * cz - y1 * sz;
    values[i + 1] = x2 * sz + y1 * cz;
    values[i + 2] = -x * sy + z1 * cy;
  }
}

// A skinned model gets its size in the game from its bones, so the node's scale says nothing: it's
// 100 on a model already 1 unit tall, and 180,000 on one that's 0.01. Characters end up about 1 unit
// tall, so only a model far from that is scaled to it.
function fitHeight(position) {
  let low = Infinity, high = -Infinity;
  for (let i = 1; i < position.length; i += 3) {
    low = Math.min(low, position[i]);
    high = Math.max(high, position[i]);
  }
  const height = high - low;
  if (height >= 0.5 && height <= 2) return;
  for (let i = 0; i < position.length; i++) position[i] /= height;
}

// Flat arrays ready to draw: one vertex per polygon corner, since FBX stores UVs and normals per
// corner. `uv` has its origin at the top left of the image. `edges` are the polygon outlines,
// for the wireframe and the UV guide.
export function readMesh(tree) {
  const geometry = firstMesh(tree);
  const vertices = child(geometry, 'Vertices').props[0];
  const polygons = child(geometry, 'PolygonVertexIndex').props[0];
  const readUv = layerReader(uvChannel0(geometry), 'UV', 'UVIndex', 2);
  const normalLayer = child(geometry, 'LayerElementNormal');
  const readNormal = normalLayer && layerReader(normalLayer, 'Normals', 'NormalsIndex', 3);

  const corners = polygons.length;
  const position = new Float32Array(corners * 3);
  const normal = new Float32Array(corners * 3);
  const uv = new Float32Array(corners * 2);
  const index = [];
  const edges = [];
  let start = 0;
  for (let i = 0; i < corners; i++) {
    const vertex = vertexOf(polygons[i]);
    for (let k = 0; k < 3; k++) position[i * 3 + k] = vertices[vertex * 3 + k];
    readUv(i, vertex, uv, i * 2);
    uv[i * 2 + 1] = 1 - uv[i * 2 + 1];
    if (readNormal) readNormal(i, vertex, normal, i * 3);
    if (polygonEnd(polygons[i])) {
      for (let k = start + 1; k < i; k++) index.push(start, k, k + 1);
      for (let k = start; k < i; k++) edges.push(k, k + 1);
      edges.push(i, start);
      start = i + 1;
    }
  }
  const degrees = nodeRotation(tree, geometry);
  rotate(position, degrees);
  rotate(normal, degrees);
  fitHeight(position);
  return {
    position, normal, uv,
    hasNormals: !!readNormal,
    index: new Uint32Array(index),
    edges: new Uint32Array(edges),
  };
}
