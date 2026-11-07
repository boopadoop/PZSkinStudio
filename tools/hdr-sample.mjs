// Test files with colour tags, the way paint programs write them.
import zlib from 'node:zlib';
import { zlibSync } from 'fflate';
import { encodePng } from '../src/pngcolour.js';

const AFTER_HEADER = 8 + 25;

export function withChunk(png, type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return Buffer.concat([Buffer.from(png.subarray(0, AFTER_HEADER)), chunk, Buffer.from(png.subarray(AFTER_HEADER))]);
}

export const iccp = (name, profile) => Buffer.concat([Buffer.from(`${name}\0\0`, 'latin1'), zlibSync(profile)]);

// A real HDR skin in miniature: 16 x 16 pixels of the numbers such a file holds, tagged as HDR.
export function hdrSample() {
  const pixels = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 256; i++) pixels.set(i < 128 ? [123, 122, 120, 255] : [77, 68, 51, i < 192 ? 255 : 0], i * 4);
  return withChunk(encodePng(16, 16, pixels), 'iCCP', iccp('ITUR_2100_PQ_FULL', new Uint8Array(132)));
}
