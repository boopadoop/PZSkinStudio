// Turns the game's human bodies into a pack in models/, so they work like any other pack:
//   node tools/import-vanilla-humans.mjs "<path to ProjectZomboid/media>"
//
// The FBX files are for the preview only, with no bones. They sit at the game's own model paths, so a
// skin made on them points at the real model, and a skin mod never has to ship a copy of it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doubles, fbxFile, int32, int64, ints, node, string } from './fbxwrite.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const media = process.argv[2];
if (!media) {
  console.log('usage: node tools/import-vanilla-humans.mjs "<path to ProjectZomboid/media>"');
  process.exit(2);
}
const packId = 'VanillaHumans';
const pack = path.join(root, 'models', packId);
const groupId = `${packId}_Human`;

// The Indie Stone's terms ask for this wording with any of their assets, so it's written with them.
const CREDIT = 'Thanks to The Indie Stone for creating Project Zomboid (https://projectzomboid.com/), which made this possible. This is an unofficial fan production for non-commercial purposes made under the Indie Stone Terms (https://projectzomboid.com/blog/support/terms-conditions/).';

const NUMBER = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;

function blockAfter(text, start) {
  let depth = 1;
  let i = text.indexOf('{', start) + 1;
  const from = i;
  while (depth) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') depth--;
    i++;
  }
  return text.slice(from, i - 1);
}

// The mesh of a text .x file. Its template definitions come first, so the mesh is the named one.
function readX(file) {
  const text = fs.readFileSync(file, 'latin1');
  const mesh = blockAfter(text, text.search(/\bMesh\s+\w+\s*\{/));
  const numbers = (source) => source.match(NUMBER).map(Number);
  // These blocks can have a name of their own, as in "MeshTextureCoords c1 {".
  const named = (name) => {
    const start = mesh.search(new RegExp(`\\b${name}\\b[^{]*\\{`));
    if (start < 0) throw new Error(`${file}: no ${name}`);
    return blockAfter(mesh, start);
  };

  const main = numbers(mesh.slice(0, mesh.search(/\bMesh\w+\b[^{]*\{/)));
  const vertexCount = main[0];
  const vertices = main.slice(1, 1 + vertexCount * 3);
  const faceCount = main[1 + vertexCount * 3];
  const faceData = main.slice(2 + vertexCount * 3);

  const normalData = numbers(named('MeshNormals'));
  const normalCount = normalData[0];
  const normals = normalData.slice(1, 1 + normalCount * 3);
  const normalFaces = normalData.slice(2 + normalCount * 3);

  const uvData = numbers(named('MeshTextureCoords'));
  const uvs = uvData.slice(1);
  if (uvs.length !== vertexCount * 2 || uvs.some((v) => v < 0 || v > 1)) throw new Error(`${file}: bad UVs`);

  const faces = [];
  for (let f = 0; f < faceCount; f++) {
    if (faceData[f * 4] !== 3 || normalFaces[f * 4] !== 3) throw new Error(`${file}: face ${f} is not a triangle`);
    faces.push({
      corners: faceData.slice(f * 4 + 1, f * 4 + 4),
      normals: normalFaces.slice(f * 4 + 1, f * 4 + 4),
    });
  }
  return { vertices, normals, uvs, faces };
}

// A face's corners in the order FBX expects: counter-clockwise seen from outside, which .x has the
// other way round.
function outwardCorners({ vertices, normals }, face) {
  const at = (list, i) => list.slice(i * 3, i * 3 + 3);
  const [a, b, c] = face.corners.map((i) => at(vertices, i));
  const u = [0, 1, 2].map((k) => b[k] - a[k]);
  const v = [0, 1, 2].map((k) => c[k] - a[k]);
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const facing = at(normals, face.normals[0]);
  const outward = cross[0] * facing[0] + cross[1] * facing[1] + cross[2] * facing[2] > 0;
  return outward ? [0, 1, 2] : [0, 2, 1];
}

function writeFbx(file, mesh) {
  const positionIndex = [];
  const normals = [];
  const uvIndex = [];
  for (const face of mesh.faces) {
    outwardCorners(mesh, face).forEach((corner, i) => {
      const vertex = face.corners[corner];
      positionIndex.push(i === 2 ? ~vertex : vertex);
      uvIndex.push(vertex);
      const n = face.normals[corner];
      normals.push(mesh.normals[n * 3], mesh.normals[n * 3 + 1], mesh.normals[n * 3 + 2]);
    });
  }
  // .x counts V from the top of the image, FBX from the bottom.
  const uvs = mesh.uvs.map((value, i) => (i % 2 ? 1 - value : value));
  const geometryId = 1000;
  const modelId = 2000;
  const geometry = node('Geometry', [int64(geometryId), string('Body\0\x01Geometry'), string('Mesh')], [
    node('GeometryVersion', [int32(124)]),
    node('Vertices', [doubles(mesh.vertices)]),
    node('PolygonVertexIndex', [ints(positionIndex)]),
    node('LayerElementNormal', [int32(0)], [
      node('Version', [int32(101)]),
      node('Name', [string('')]),
      node('MappingInformationType', [string('ByPolygonVertex')]),
      node('ReferenceInformationType', [string('Direct')]),
      node('Normals', [doubles(normals)]),
    ]),
    node('LayerElementUV', [int32(0)], [
      node('Version', [int32(101)]),
      node('Name', [string('map1')]),
      node('MappingInformationType', [string('ByPolygonVertex')]),
      node('ReferenceInformationType', [string('IndexToDirect')]),
      node('UV', [doubles(uvs)]),
      node('UVIndex', [ints(uvIndex)]),
    ]),
    node('Layer', [int32(0)], [
      node('Version', [int32(100)]),
      node('LayerElement', [], [node('Type', [string('LayerElementNormal')]), node('TypedIndex', [int32(0)])]),
      node('LayerElement', [], [node('Type', [string('LayerElementUV')]), node('TypedIndex', [int32(0)])]),
    ]),
  ]);
  const model = node('Model', [int64(modelId), string('Body\0\x01Model'), string('Mesh')], [
    node('Version', [int32(232)]),
  ]);
  const top = [
    node('FBXHeaderExtension', [], [
      node('FBXHeaderVersion', [int32(1003)]),
      node('FBXVersion', [int32(7400)]),
      // Tells the studio's model check these have no bones on purpose.
      node('Creator', [string('PZ Skin Studio preview copy, no bones')]),
    ]),
    node('Objects', [], [geometry, model]),
    node('Connections', [], [
      node('C', [string('OO'), int64(geometryId), int64(modelId)]),
      node('C', [string('OO'), int64(modelId), int64(0)]),
    ]),
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fbxFile(top));
}

// ---- The pack --------------------------------------------------------------------------------

const MASKS = Array.from({ length: 11 }, (_, i) => `    <m_Masks>${i}</m_Masks>`).join('\n');
const itemXml = (model, textures) => `<?xml version="1.0" encoding="utf-8"?>
<clothingItem>
    <m_MaleModel>${model}</m_MaleModel>
    <m_FemaleModel>${model}</m_FemaleModel>
    <m_Static>false</m_Static>
${MASKS}
${textures.map((t) => `    <textureChoices>Body\\${t}</textureChoices>`).join('\n')}
</clothingItem>
`;

fs.rmSync(pack, { recursive: true, force: true });
fs.mkdirSync(path.join(pack, 'media/clothing/clothingItems'), { recursive: true });
fs.mkdirSync(path.join(pack, 'media/textures/Body'), { recursive: true });
fs.mkdirSync(path.join(pack, `media/lua/shared/${packId}`), { recursive: true });
fs.writeFileSync(path.join(pack, 'mod.info'), `name=Project Zomboid humans\nid=${packId}\n`);
fs.writeFileSync(path.join(pack, 'README.md'), `# The game's human bodies

These are The Indie Stone's own models and textures from Project Zomboid, here so the studio has
something to show straight away and as an example of how a pack is laid out. The models are copies for
the preview, with no bones. Skins made on them use the game's real models.

${CREDIT}

The MIT licence on the rest of this project does not cover these files. They can't be used
commercially, and they belong to The Indie Stone.

To make them again from your own game, for instance after an update:

    node tools/import-vanilla-humans.mjs "<path to ProjectZomboid/media>"
`);

const body = path.join(media, 'textures/Body');
for (const [gender, name] of [['Male', 'Human_Male'], ['Female', 'Human_Female']]) {
  const mesh = readX(path.join(media, `models_X/Skinned/${gender}Body.x`));
  writeFbx(path.join(pack, `media/models_X/Skinned/${gender}Body.fbx`), mesh);
  const textures = fs.readdirSync(body).filter((f) => new RegExp(`^${gender}Body\\d+a?\\.png$`).test(f)).sort();
  for (const texture of textures) fs.copyFileSync(path.join(body, texture), path.join(pack, 'media/textures/Body', texture));
  const names = textures.map((t) => t.replace('.png', ''));
  fs.writeFileSync(path.join(pack, `media/clothing/clothingItems/${name}.xml`), itemXml(`Skinned\\${gender}Body`, names));
  console.log(`${gender}: ${mesh.vertices.length / 3} vertices, ${mesh.faces.length} triangles, ${names.length} skins`);
}
fs.writeFileSync(path.join(pack, `media/lua/shared/${packId}/species.lua`), `local group = FurryModApi.v1.createCustomSpeciesGroup("${groupId}", "Human Skins");
FurryModApi.v1.addSpeciesToGroup(group, "${packId}_Human", "Human", "${packId}.Human_Male", "${packId}.Human_Female");
`);
console.log(`wrote ${path.relative(root, pack)}`);
