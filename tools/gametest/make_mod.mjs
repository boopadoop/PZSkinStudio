// Builds a throwaway mod for the bench that adds marker skins to models from the character pack,
// the same way a real skin mod would: its own texture, clothing items and species, the pack's
// model. A marker skin is painted from each texel's 3D position, so it shows in one look whether
// the game agrees with the viewer:
//   red = the character's left, blue = its right, white = the middle line,
//   brightness bands change every 10 cm of height, magenta = no polygon uses this texel.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unzlibSync } from 'fflate';
import pngjs from 'pngjs';
import { parseFbxTree, readMesh } from '../../src/fbx.js';
import { root } from '../harness.mjs';

const { PNG } = pngjs;
const ID = 'SkinStudioBenchTest';
const SIZE = 256;
// One plain model, and two whose extra UV layers come in a different order.
const MODELS = ['MaleWolfNero', 'MaleDogToki', 'MaleTigerTigerTwoWild'];
const pack = path.join(root, 'models/XochisCustomBFT/42/media');
const out = path.join(root, 'tools/mods', ID);
const media = path.join(out, '42/media');

function colourAt(x, y) {
  const shade = Math.floor(y * 10) % 2 ? 1 : 0.62;
  const base = Math.abs(x) < 0.012 ? [255, 255, 255] : x > 0 ? [235, 45, 40] : [45, 90, 240];
  return base.map((c) => Math.round(c * shade));
}

function paint(mesh) {
  const image = new PNG({ width: SIZE, height: SIZE });
  for (let i = 0; i < SIZE * SIZE; i++) image.data.set([255, 0, 255, 255], i * 4);
  const { uv, position, index } = mesh;
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
    const [ax, ay, bx, by, cx, cy] = [uv[a * 2], uv[a * 2 + 1], uv[b * 2], uv[b * 2 + 1], uv[c * 2], uv[c * 2 + 1]].map((v) => v * SIZE);
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-6) continue;
    for (let py = Math.floor(Math.min(ay, by, cy)) - 1; py <= Math.ceil(Math.max(ay, by, cy)) + 1; py++) {
      for (let px = Math.floor(Math.min(ax, bx, cx)) - 1; px <= Math.ceil(Math.max(ax, bx, cx)) + 1; px++) {
        if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) continue;
        const [sx, sy] = [px + 0.5, py + 0.5];
        const wb = ((sx - ax) * (cy - ay) - (cx - ax) * (sy - ay)) / area;
        const wc = ((bx - ax) * (sy - ay) - (sx - ax) * (by - ay)) / area;
        const wa = 1 - wb - wc;
        if (Math.min(wa, wb, wc) < -0.12) continue; // a little past the edge, so seams stay clean
        const at = (k) => wa * position[a * 3 + k] + wb * position[b * 3 + k] + wc * position[c * 3 + k];
        image.data.set([...colourAt(at(0), at(1)), 255], (py * SIZE + px) * 4);
      }
    }
  }
  return PNG.sync.write(image);
}

const SCRIPT = (name) => `
    item ${name}
    {
        ItemType = Clothing,
        ClothingItem = ${name},
        Tags = furrymod:FurB42,
        BodyLocation = furrymod:FurB42,
        BloodLocation = Trousers;Jumper;Head;Neck;Hands;Shoes,
        Hidden = True,
        CanHaveHoles = False,
        Weight = 0.0,
    }

    item ${name}_Deceased
    {
        ItemType = Clothing,
        ClothingItem = ${name}_Deceased,
        Tags = furrymod:DeceasedFurB42,
        BodyLocation = Bandage,
        BloodLocation = Trousers;Jumper;Head;Neck;Hands;Shoes,
        Hidden = True,
        Weight = 0.0,
    }
`;

fs.rmSync(out, { recursive: true, force: true });
for (const dir of ['textures/Clothes', 'clothing/clothingItems', 'scripts/clothing', `lua/shared/${ID}`]) {
  fs.mkdirSync(path.join(media, dir), { recursive: true });
}
fs.mkdirSync(path.join(out, 'common'), { recursive: true });
fs.writeFileSync(path.join(out, '42/mod.info'), `name=Skin Studio Bench Test\nid=${ID}\nrequire=\\FurryModB42,\\XochisCustomBFT\ndescription=Bench only\nversionMin=42.0.0\n`);

let scripts = `module ${ID}\n{\n`;
let guids = '<?xml version="1.0" encoding="utf-8"?>\n<fileGuidTable>\n';
let species = `local function onGameBoot()\n  local group = FurryModApi.v1.createCustomSpeciesGroup("${ID}", "Markers");\n`;
for (const model of MODELS) {
  const source = `Furry_XochisCustomBFT_${model}`;
  const item = `Furry_${ID}_${model}`;
  const tree = parseFbxTree(fs.readFileSync(path.join(pack, `models_X/Skinned/Clothes/${source}.fbx`)), unzlibSync);
  const png = paint(readMesh(tree));
  fs.writeFileSync(path.join(media, `textures/Clothes/${item}.png`), png);
  fs.mkdirSync(path.join(root, 'tools/gametest/markers'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools/gametest/markers', `${model}.png`), png);
  const masks = Array.from({ length: 11 }, (_, i) => `    <m_Masks>${i}</m_Masks>`).join('\n');
  for (const name of [item, `${item}_Deceased`]) {
    const guid = crypto.randomUUID();
    fs.writeFileSync(path.join(media, `clothing/clothingItems/${name}.xml`), `<?xml version="1.0" encoding="utf-8"?>
<clothingItem>
    <m_MaleModel>Skinned\\Clothes\\${source}</m_MaleModel>
    <m_FemaleModel>Skinned\\Clothes\\${source}</m_FemaleModel>
    <m_GUID>${guid}</m_GUID>
    <m_Static>false</m_Static>
    <m_AllowRandomHue>false</m_AllowRandomHue>
    <m_AllowRandomTint>false</m_AllowRandomTint>
    <m_AttachBone></m_AttachBone>
${masks}
    <textureChoices>Clothes\\${item}</textureChoices>
</clothingItem>
`);
    guids += `    <files>\n        <path>media/clothing/clothingItems/${name}.xml</path>\n        <guid>${guid}</guid>\n    </files>\n`;
  }
  scripts += SCRIPT(item);
  species += `  FurryModApi.v1.addSpeciesToGroup(group, "${ID}_${model}", "${model}", "${ID}.${item}", "${ID}.${item}");\n`;
}
fs.writeFileSync(path.join(media, `scripts/clothing/${ID}_clothingitems.txt`), `${scripts}}\n`);
fs.writeFileSync(path.join(media, 'fileGuidTable.xml'), `${guids}</fileGuidTable>\n`);
fs.writeFileSync(path.join(media, `lua/shared/${ID}/species.lua`), `${species}  FurryModApi.v1.registerCustomSpeciesGroup(group);\nend\nEvents.OnGameBoot.Add(onGameBoot);\n`);
console.log('wrote', out);
