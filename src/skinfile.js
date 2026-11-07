// A skin travels as a zip of skin.png and skin.json, so the link to its model stays with it.
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const isPng = (bytes) => PNG_SIGNATURE.every((b, i) => bytes[i] === b);

export function pngSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function packSkin(meta, png) {
  return zipSync({
    'skin.json': strToU8(JSON.stringify(meta, null, 2)),
    'skin.png': [png, { level: 0 }],
  });
}

export function unpackSkin(bytes) {
  let files;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('this zip could not be read');
  }
  if (!files['skin.json'] || !files['skin.png']) {
    throw new Error('this zip is not a skin: it needs skin.json and skin.png');
  }
  let meta;
  try {
    meta = JSON.parse(strFromU8(files['skin.json']));
  } catch {
    throw new Error('its skin.json is damaged');
  }
  if (!meta || typeof meta !== 'object') throw new Error('its skin.json is damaged');
  if (!isPng(files['skin.png'])) throw new Error('its skin.png is not a PNG');
  return { meta, png: files['skin.png'] };
}
