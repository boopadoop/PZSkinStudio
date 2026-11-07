// Bundles src/ into one HTML file that opens straight from disk, with no server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  legalComments: 'none',
  write: false,
});
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const css = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8');
const page = fs.readFileSync(path.join(root, 'src/page.html'), 'utf8')
  .replace('/*CSS*/', () => css)
  .replace('/*JS*/', () => script);
// three.js and fflate are bundled in, and their licences have to travel with them.
const licences = ['three', 'fflate']
  .map((name) => `${name}\n\n${fs.readFileSync(path.join(root, 'node_modules', name, 'LICENSE'), 'utf8').trim()}`)
  .join('\n\n');
const notice = `<!--\nPZ Skin Studio includes these libraries:\n\n${licences.replaceAll('--', '- -')}\n-->\n`;
const out = path.join(root, 'PZSkinStudio.html');
fs.writeFileSync(out, page.replace('<html', () => `${notice}<html`));
console.log(`PZSkinStudio.html: ${(page.length / 1024).toFixed(0)} KB`);
