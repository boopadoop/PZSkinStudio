// Models laid out the way Blender exports them, each with one of the things that go wrong with a
// home-made model, for tools/test-models.mjs. Also handy to look at by hand:
//   node tools/make-test-models.mjs <folder>     (then put the folder in models/ and Rescan)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { double, doubles, fbxFile, int32, int64, ints, node, string } from './fbxwrite.mjs';

// ---- Shapes ----------------------------------------------------------------------------------

// A tube standing on Y, as quads, with its UVs unwrapped into one rectangle of the texture.
// rect: [u0, v0, u1, v1]. The seam column is doubled in UV space, as an unwrap does.
function tube({ segments = 12, rings = 6, radius = 0.15, bottom = 0, top = 1, rect = [0, 0, 1, 1], material = 0 }) {
  const vertices = [];
  const uvs = [];
  for (let r = 0; r <= rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      vertices.push(Math.sin(a) * radius, bottom + ((top - bottom) * r) / rings, Math.cos(a) * radius);
    }
    for (let s = 0; s <= segments; s++) {
      uvs.push(rect[0] + ((rect[2] - rect[0]) * s) / segments, rect[1] + ((rect[3] - rect[1]) * r) / rings);
    }
  }
  const polygons = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const v = (rr, ss) => rr * segments + (ss % segments);
      const t = (rr, ss) => rr * (segments + 1) + ss;
      polygons.push({
        corners: [v(r, s), v(r, s + 1), v(r + 1, s + 1), v(r + 1, s)],
        uvs: [t(r, s), t(r, s + 1), t(r + 1, s + 1), t(r + 1, s)],
        material,
      });
    }
  }
  return { vertices, uvs, polygons };
}

function join(...shapes) {
  const out = { vertices: [], uvs: [], polygons: [] };
  for (const shape of shapes) {
    const [v0, t0] = [out.vertices.length / 3, out.uvs.length / 2];
    out.vertices.push(...shape.vertices);
    out.uvs.push(...shape.uvs);
    for (const p of shape.polygons) {
      out.polygons.push({ ...p, corners: p.corners.map((c) => c + v0), uvs: p.uvs.map((c) => c + t0) });
    }
  }
  return out;
}

// What Blender does to a model that was never unwrapped: every face fills the whole square.
function unwrapNever(shape) {
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  return { ...shape, uvs, polygons: shape.polygons.map((p) => ({ ...p, uvs: [0, 1, 2, 3] })) };
}

// Turns a standing shape onto its back (Z up), the way Blender's own axes have it before export.
const lieDown = (shape) => ({
  ...shape,
  vertices: shape.vertices.map((value, i, all) => (i % 3 === 1 ? -all[i + 1] : i % 3 === 2 ? all[i - 1] : value)),
});

const body = (extra = {}) => tube({ rect: [0.02, 0.3, 0.6, 0.98], top: 1.4, ...extra });
const head = (extra = {}) => tube({ rect: [0.62, 0.02, 0.98, 0.4], bottom: 1.42, top: 1.8, radius: 0.11, rings: 3, ...extra });

// ---- FBX, as Blender writes it ---------------------------------------------------------------

let nextId = 1000;
const id = () => nextId++;
const p70 = (entries) => node('Properties70', [], entries.map(([name, values]) => node('P', [
  string(name), string(name), string(''), string('A'), ...values.map((v) => (typeof v === 'number' ? double(v) : v)),
])));

function geometryNode(geometryId, name, shape, { uvLayers, materials }) {
  const index = [];
  const uvIndex = [];
  for (const p of shape.polygons) {
    p.corners.forEach((c, i) => index.push(i === p.corners.length - 1 ? ~c : c));
    uvIndex.push(...p.uvs);
  }
  const layers = (uvLayers ?? [{ name: 'UVMap', uvs: shape.uvs, uvIndex }]).map((layer, k) => node('LayerElementUV', [int32(k)], [
    node('Version', [int32(101)]),
    node('Name', [string(layer.name)]),
    node('MappingInformationType', [string('ByPolygonVertex')]),
    node('ReferenceInformationType', [string('IndexToDirect')]),
    node('UV', [doubles(layer.uvs)]),
    node('UVIndex', [ints(layer.uvIndex ?? uvIndex)]),
  ]));
  const materialLayer = materials?.length ? [node('LayerElementMaterial', [int32(0)], [
    node('Version', [int32(101)]),
    node('Name', [string('')]),
    node('MappingInformationType', [string('ByPolygon')]),
    node('ReferenceInformationType', [string('IndexToDirect')]),
    node('Materials', [ints(shape.polygons.map((p) => p.material))]),
  ])] : [];
  return node('Geometry', [int64(geometryId), string(`${name}\0\x01Geometry`), string('Mesh')], [
    node('Vertices', [doubles(shape.vertices)]),
    node('PolygonVertexIndex', [ints(index)]),
    node('GeometryVersion', [int32(124)]),
    ...layers,
    ...materialLayer,
  ]);
}

const modelNode = (modelId, name, kind, { rotation = [0, 0, 0], scale = [1, 1, 1], translation = [0, 0, 0] } = {}) => node('Model',
  [int64(modelId), string(`${name}\0\x01Model`), string(kind)],
  [node('Version', [int32(232)]), p70([['Lcl Translation', translation], ['Lcl Rotation', rotation], ['Lcl Scaling', scale]])]);

// objects: [{ name, shape, bones, parent?, transform?, materials?, uvLayers? }]; armature: { rotation, scale }.
function blenderFile(objects, { armature } = {}) {
  const nodes = [];
  const links = [];
  const link = (a, b) => links.push(node('C', [string('OO'), int64(a), int64(b)]));
  let armatureId = 0;
  if (armature) {
    armatureId = id();
    nodes.push(modelNode(armatureId, 'Armature', 'Null', armature));
    link(armatureId, 0);
  }
  for (const object of objects) {
    const [modelId, geometryId] = [id(), id()];
    nodes.push(modelNode(modelId, object.name, 'Mesh', object.transform));
    nodes.push(geometryNode(geometryId, object.name, object.shape, object));
    link(modelId, armatureId);
    link(geometryId, modelId);
    for (const material of object.materials ?? []) {
      const materialId = id();
      nodes.push(node('Material', [int64(materialId), string(`${material}\0\x01Material`), string('')], []));
      link(materialId, modelId);
    }
    if (object.bones) {
      const [skinId, clusterId, boneId] = [id(), id(), id()];
      nodes.push(node('Deformer', [int64(skinId), string('\0\x01Deformer'), string('Skin')], [node('Version', [int32(101)])]));
      const bone = object.bones === true ? 'Bip01_Pelvis' : object.bones;
      nodes.push(node('Deformer', [int64(clusterId), string(`${bone}\0\x01SubDeformer`), string('Cluster')], [node('Version', [int32(100)])]));
      nodes.push(modelNode(boneId, bone, 'LimbNode'));
      link(skinId, geometryId);
      link(clusterId, skinId);
      link(boneId, clusterId);
      link(boneId, armatureId);
    }
  }
  return fbxFile([
    node('FBXHeaderExtension', [], [
      node('FBXHeaderVersion', [int32(1003)]),
      node('FBXVersion', [int32(7400)]),
      node('Creator', [string('Blender (stable FBX IO) - 4.2.3 LTS - 5.12.5')]),
    ]),
    node('GlobalSettings', [], [node('Version', [int32(1000)]), p70([['UpAxis', [int32(1)]], ['UnitScaleFactor', [1]]])]),
    node('Objects', [], nodes),
    node('Connections', [], links),
  ]);
}

// ---- The models ------------------------------------------------------------------------------

export const MODELS = {
  // Nothing wrong: one rigged object, one material, a clean unwrap.
  Good: () => blenderFile([{ name: 'Fox', shape: join(body(), head()), bones: true }]),
  // Body and head left as two objects. The game draws the first with bones: Body, though Head
  // comes first in the file.
  TwoObjects: () => blenderFile([
    { name: 'Head', shape: head() },
    { name: 'Body', shape: body(), bones: true },
  ]),
  // One object, two materials: the game draws only the faces of the first one used.
  TwoMaterials: () => blenderFile([{
    name: 'Fox', shape: join(body({ material: 0 }), head({ material: 1 })), bones: true, materials: ['Fur', 'Eyes'],
  }]),
  // Blender's usual rigged export: the armature turned -90° about X and scaled 100, the mesh inside
  // it lying on its back.
  ArmatureParent: () => blenderFile([{ name: 'Fox', shape: lieDown(join(body(), head())), bones: true }], {
    armature: { rotation: [-90, 0, 0], scale: [100, 100, 100] },
  }),
  // Never unwrapped: every face covers the whole texture.
  NotUnwrapped: () => blenderFile([{ name: 'Fox', shape: unwrapNever(join(body(), head())), bones: true }]),
  // Unwrapped into a second UV map, while the first one (the one the game reads) is still the default.
  SecondUvMap: () => {
    const shape = join(body(), head());
    const never = unwrapNever(shape);
    return blenderFile([{
      name: 'Fox', shape, bones: true,
      uvLayers: [
        { name: 'UVMap', uvs: never.uvs, uvIndex: never.polygons.flatMap((p) => p.uvs) },
        { name: 'UVMap.001', uvs: shape.uvs },
      ],
    }]);
  },
  // Rigged, but to a skeleton of its own rather than the game's Bip01 bones.
  OwnSkeleton: () => blenderFile([{ name: 'Fox', shape: join(body(), head()), bones: 'Hips' }]),
  // A clean model that isn't rigged.
  NoBones: () => blenderFile([{ name: 'Fox', shape: join(body(), head()) }]),
  // A sculpt-like model with far more faces than the pack's.
  Dense: () => blenderFile([{ name: 'Fox', shape: join(body({ segments: 160, rings: 90 }), head({ segments: 120, rings: 30 })), bones: true }]),
  // A concave five-sided face (an L-shaped notch), which a plain fan would fill wrongly.
  ConcaveFace: () => blenderFile([{
    name: 'Plate', bones: true,
    shape: {
      vertices: [0, 0, 0, 1, 0, 0, 1, 0.5, 0, 0.5, 0.5, 0, 0.5, 1, 0, 0, 1, 0].map((v, i) => (i % 3 === 1 ? v * 1.5 : v)),
      uvs: [0, 0, 1, 0, 1, 0.5, 0.5, 0.5, 0.5, 1, 0, 1],
      polygons: [{ corners: [0, 1, 2, 3, 4, 5], uvs: [0, 1, 2, 3, 4, 5], material: 0 }],
    },
  }]),
  // No UV map at all.
  NoUvs: () => blenderFile([{ name: 'Fox', shape: join(body(), head()), bones: true, uvLayers: [] }]),
};

// Text FBX, as some programs other than Blender save it.
const ASCII = '; FBX 7.4.0 project file\n; ----------------------------------------------------\n\nFBXHeaderExtension:  {\n}\n';

export function makeTestModels(folder) {
  const dir = path.join(folder, 'media/models_X/Skinned/Clothes');
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [name, make] of Object.entries(MODELS)) {
    nextId = 1000;
    fs.writeFileSync(path.join(dir, `HomeMade_${name}.fbx`), make());
    written.push(`HomeMade_${name}`);
  }
  fs.writeFileSync(path.join(dir, 'HomeMade_TextFbx.fbx'), ASCII);
  written.push('HomeMade_TextFbx');
  fs.writeFileSync(path.join(folder, 'mod.info'), 'name=Home-made test models\nid=HomeMadeTest\n');
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2];
  if (!folder) {
    console.log('usage: node tools/make-test-models.mjs <folder>');
    process.exit(2);
  }
  console.log(makeTestModels(path.resolve(folder)).join('\n'));
}
