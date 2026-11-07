// What colour space a PNG says it's in, and turning HDR files into the plain sRGB the game reads.
// The game shows a PNG's raw numbers and ignores these tags, so a tagged file looks fine in an image
// viewer and wrong in the game. No browser needed: tools/fix-skin-colours.mjs uses this too.
import { unzlibSync, zlibSync } from 'fflate';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const latin1 = new TextDecoder('latin1');
const SRGB_GAMMA = 0.45455;
const GAMMA_TOLERANCE = 0.02;

function chunksOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  for (let at = SIGNATURE.length; at + 12 <= bytes.length;) {
    const length = view.getUint32(at);
    chunks.push({ type: latin1.decode(bytes.subarray(at + 4, at + 8)), data: bytes.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

// An ICC profile's own description, which is what says sRGB when the chunk just says "ICC profile".
function profileDescription(profile) {
  const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
  for (let i = 0; i < view.getUint32(128); i++) {
    const at = 132 + i * 12;
    if (latin1.decode(profile.subarray(at, at + 4)) === 'desc') {
      const offset = view.getUint32(at + 4);
      return latin1.decode(profile.subarray(offset, offset + view.getUint32(at + 8))).replace(/[^\x20-\x7e]/g, '');
    }
  }
  return '';
}

function readProfile(data) {
  const end = data.indexOf(0);
  const name = latin1.decode(data.subarray(0, end));
  try {
    return { name, description: profileDescription(unzlibSync(data.subarray(end + 2))) };
  } catch {
    return { name, description: '' };
  }
}

const SRGB = { kind: 'srgb' };
const HDR = { kind: 'hdr', label: 'HDR (Rec. 2100 PQ)' };
const CICP_PQ = 16;
const CICP_HLG = 18;
const CICP_REC2020 = 9;

// kind is srgb (fine as it is), hdr (PQ, which hdrToSrgb converts), or other (any other colour space).
export function colourOf(bytes) {
  const chunks = new Map();
  for (const { type, data } of chunksOf(bytes)) {
    if (type === 'IDAT') break;
    chunks.set(type, data);
  }
  const cicp = chunks.get('cICP');
  if (cicp?.[1] === CICP_PQ) return cicp[0] === CICP_REC2020 ? HDR : { kind: 'other', label: 'HDR' };
  if (cicp?.[1] === CICP_HLG) return { kind: 'other', label: 'HDR (HLG)' };
  if (chunks.has('iCCP')) {
    const { name, description } = readProfile(chunks.get('iCCP'));
    const text = `${name} ${description}`;
    if (/\bPQ\b|_PQ_|2100|2084/i.test(text)) return HDR;
    if (/srgb/i.test(text)) return SRGB;
    return { kind: 'other', label: /^icc profile$/i.test(name) ? 'a colour profile other than sRGB' : name };
  }
  if (chunks.has('sRGB')) return SRGB;
  const gamma = chunks.get('gAMA');
  if (gamma) {
    const value = new DataView(gamma.buffer, gamma.byteOffset).getUint32(0) / 100000;
    if (Math.abs(value - SRGB_GAMMA) > GAMMA_TOLERANCE) return { kind: 'other', label: `a gamma of ${value.toFixed(2)}` };
  }
  return SRGB;
}

// ---- PNG pixels ------------------------------------------------------------------------------

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(raw, height, stride, pixelBytes) {
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const row = raw.subarray(start + 1, start + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= pixelBytes ? row[x - pixelBytes] : 0;
      const b = previous[x];
      const c = x >= pixelBytes ? previous[x - pixelBytes] : 0;
      if (filter === 1) row[x] += a;
      else if (filter === 2) row[x] += b;
      else if (filter === 3) row[x] += (a + b) >> 1;
      else if (filter === 4) row[x] += paeth(a, b, c);
    }
    previous = row;
  }
}

// Every pixel as red, green, blue and alpha from 0 to 1.
function decodePng(bytes) {
  const chunks = chunksOf(bytes);
  const header = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset);
  const [width, height] = [header.getUint32(0), header.getUint32(4)];
  const [depth, colourType, , , interlace] = chunks[0].data.subarray(8, 13);
  const channels = CHANNELS[colourType];
  if (interlace || depth < 8 || !channels) throw new Error('this kind of PNG can\'t be converted');

  const compressed = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  const joined = new Uint8Array(compressed.reduce((sum, part) => sum + part.length, 0));
  compressed.reduce((at, part) => { joined.set(part, at); return at + part.length; }, 0);
  const raw = unzlibSync(joined);

  const sampleBytes = depth / 8;
  const stride = width * channels * sampleBytes;
  unfilter(raw, height, stride, channels * sampleBytes);

  const palette = chunks.find((c) => c.type === 'PLTE')?.data;
  const paletteAlpha = chunks.find((c) => c.type === 'tRNS')?.data;
  const full = depth === 16 ? 65535 : 255;
  const rgba = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1) + 1;
    const sample = (x, c) => {
      const at = start + (x * channels + c) * sampleBytes;
      return (depth === 16 ? (raw[at] << 8) | raw[at + 1] : raw[at]) / full;
    };
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (colourType === 3) {
        const entry = raw[start + x];
        for (let c = 0; c < 3; c++) rgba[out + c] = palette[entry * 3 + c] / 255;
        rgba[out + 3] = paletteAlpha && entry < paletteAlpha.length ? paletteAlpha[entry] / 255 : 1;
        continue;
      }
      const colours = channels >= 3 ? 3 : 1;
      for (let c = 0; c < 3; c++) rgba[out + c] = sample(x, colours === 3 ? c : 0);
      rgba[out + 3] = channels % 2 === 0 ? sample(x, channels - 1) : 1;
    }
  }
  return { width, height, rgba };
}

// A PNG's pixels as plain 8-bit numbers. Throws on the rare kinds decodePng doesn't read.
export function pixelsOf(bytes) {
  const { width, height, rgba } = decodePng(bytes);
  const pixels = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i++) pixels[i] = rgba[i] * 255;
  return { width, height, pixels };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunkBytes(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// A plain 8-bit RGBA PNG with no colour tags, which is exactly what the game reads correctly.
export function encodePng(width, height, pixels) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const rows = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunkBytes('IHDR', header),
    chunkBytes('IDAT', zlibSync(rows)),
    chunkBytes('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((at, part) => { out.set(part, at); return at + part.length; }, 0);
  return out;
}

// ---- HDR to sRGB -----------------------------------------------------------------------------

function pqToNits(value) {
  const [m1, m2, c1, c2, c3] = [0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875];
  const p = value ** (1 / m2);
  return 10000 * (Math.max(p - c1, 0) / (c2 - c3 * p)) ** (1 / m1);
}

function srgbEncode(linear) {
  const value = Math.min(Math.max(linear, 0), 1);
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

// Where plain white sits in an HDR file. Paint programs put it at 80 nits, and the broadcast standard
// at 203. A file brighter than the first is taken to use a higher white, up to the second: anything
// above that is real HDR highlight, which a game texture can't show anyway.
const WHITE_NITS = 80;
const WHITE_NITS_HIGHEST = 203;
const WHITE_NITS_MARGIN = 100;

function whiteOf(rgba) {
  let peak = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] > 0) peak = Math.max(peak, rgba[i], rgba[i + 1], rgba[i + 2]);
  }
  const nits = pqToNits(peak);
  return nits <= WHITE_NITS_MARGIN ? WHITE_NITS : Math.min(nits, WHITE_NITS_HIGHEST);
}

export function hdrToSrgb(bytes) {
  const { width, height, rgba } = decodePng(bytes);
  const white = whiteOf(rgba);
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    const [r, g, b] = [rgba[i], rgba[i + 1], rgba[i + 2]].map((value) => pqToNits(value) / white);
    // Rec. 2020 primaries to sRGB's.
    pixels[i] = Math.round(srgbEncode(1.6605 * r - 0.5876 * g - 0.0728 * b) * 255);
    pixels[i + 1] = Math.round(srgbEncode(-0.1246 * r + 1.1329 * g - 0.0083 * b) * 255);
    pixels[i + 2] = Math.round(srgbEncode(-0.0182 * r - 0.1006 * g + 1.1187 * b) * 255);
    pixels[i + 3] = Math.round(rgba[i + 3] * 255);
  }
  return encodePng(width, height, pixels);
}
