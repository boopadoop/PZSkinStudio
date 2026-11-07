// Fixes HDR skins on disk, the same way the studio does on import:
//   node tools/fix-skin-colours.mjs <.png, .skin.zip or folder> ...
// The old file is kept in an originals folder beside it.
import fs from 'node:fs';
import path from 'node:path';
import { colourOf, hdrToSrgb } from '../src/pngcolour.js';
import { packSkin, unpackSkin } from '../src/skinfile.js';

const isSkin = (name) => /\.(png|zip)$/i.test(name);

function filesIn(target) {
  if (!fs.statSync(target).isDirectory()) return [target];
  return fs.readdirSync(target).filter(isSkin).map((name) => path.join(target, name));
}

function keepOriginal(file) {
  const folder = path.join(path.dirname(file), 'originals');
  fs.mkdirSync(folder, { recursive: true });
  const kept = path.join(folder, path.basename(file));
  if (!fs.existsSync(kept)) fs.copyFileSync(file, kept);
}

function fix(file) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const zipped = /\.zip$/i.test(file);
  const skin = zipped ? unpackSkin(bytes) : { png: bytes };
  const colour = colourOf(skin.png);
  const name = path.basename(file);
  if (colour.kind === 'srgb') {
    console.log(`fine      ${name}`);
  } else if (colour.kind === 'hdr') {
    const fixed = hdrToSrgb(skin.png);
    keepOriginal(file);
    fs.writeFileSync(file, zipped ? packSkin(skin.meta, fixed) : fixed);
    console.log(`fixed     ${name} (was ${colour.label})`);
  } else {
    console.log(`in Studio ${name} is in ${colour.label}: import it into the studio and export it again`);
  }
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.log('usage: node tools/fix-skin-colours.mjs <.png, .skin.zip or folder> ...');
  process.exit(2);
}
for (const target of targets) {
  for (const file of filesIn(target)) {
    try {
      fix(file);
    } catch (error) {
      console.log(`skipped   ${path.basename(file)}: ${error.message}`);
    }
  }
}
