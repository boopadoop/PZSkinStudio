// Renders launcher/icon.svg to launcher/icon.png (256 × 256) with headless Chrome.
//   node tools/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import { root, start } from './harness.mjs';

const svg = fs.readFileSync(path.join(root, 'launcher/icon.svg'), 'utf8');
const { page, stop } = await start({ url: 'about:blank', width: 256, height: 256 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.screenshot({ path: path.join(root, 'launcher/icon.png'), omitBackground: true, clip: { x: 0, y: 0, width: 256, height: 256 } });
await stop();
console.log('launcher/icon.png');
