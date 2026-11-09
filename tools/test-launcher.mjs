// The "PZ Skin Studio" program: it opens the studio in an app window served by start-studio.py,
// stops when that window closes, and adds itself to the applications menu. Chrome runs headless
// here, so no window appears on screen.
//   node tools/test-launcher.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { root } from './harness.mjs';

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== '' ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const program = 'PZ Skin Studio';

const studio = fs.mkdtempSync(path.join(os.tmpdir(), 'skinstudio-app-'));
for (const file of ['PZSkinStudio.html', 'start-studio.py', program, 'launcher/icon.png']) {
  fs.mkdirSync(path.dirname(path.join(studio, file)), { recursive: true });
  fs.copyFileSync(path.join(root, file), path.join(studio, file));
}
fs.chmodSync(path.join(studio, program), 0o755);
fs.cpSync(path.join(root, 'models/VanillaHumans'), path.join(studio, 'models/VanillaHumans'), { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'skinstudio-app-profile-'));

const port = 47000 + Math.floor(Math.random() * 800);
const debugPort = 9300 + Math.floor(Math.random() * 500);
const portOpen = (p) => new Promise((resolve) => {
  const socket = net.connect(p, '127.0.0.1', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});
const exited = (child) => new Promise((resolve) => {
  if (child.exitCode !== null) resolve(child.exitCode);
  else child.on('exit', (code) => resolve(code));
});
const launch = (args, env = {}) => spawn(path.join(studio, program), args, { env: { ...process.env, ...env }, stdio: 'pipe' });
const headless = ['--port', String(port), '--profile', profile, '--browser-arg=--headless=new', `--browser-arg=--remote-debugging-port=${debugPort}`];

// Opening it.
const launchedAt = Date.now();
const app = launch(headless);
let browser = null;
for (let i = 0; i < 60 && !browser; i++) {
  await wait(250);
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` }).catch(() => null);
}
check(!!browser, 'the program opens the studio in Chrome');
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  page = (await browser.pages()).find((p) => p.url().includes('PZSkinStudio.html')) ?? null;
  if (!page) await wait(250);
}
check(page?.url() === `http://127.0.0.1:${port}/PZSkinStudio.html`, 'as an app, served by the helper', page?.url());
await page.waitForFunction(() => window.skinStudio.state.mesh, { timeout: 60000 }).catch(() => {});
const shown = await page.evaluate(() => ({
  helper: window.skinStudio.state.root?.name === 'helper',
  characters: window.skinStudio.state.catalog?.characters.length ?? 0,
  title: document.title,
}));
check(shown.helper && shown.characters > 0, 'the studio reads its folder and can save into it', JSON.stringify(shown));
const icon = await page.evaluate(async () => {
  const answer = await fetch('/favicon.ico');
  return `${answer.status} ${answer.headers.get('content-type')}`;
});
check(icon === '200 image/png', 'the window gets the studio\'s icon', icon);

// Starting it again while it's open hands over and leaves the first one running.
const again = launch(headless.filter((a) => !a.includes('remote-debugging')));
const againCode = await Promise.race([exited(again), wait(15000).then(() => 'still running')]);
check(againCode === 0 && await portOpen(port), 'starting it again while open leaves the first one serving', againCode);
if (againCode === 'still running') again.kill();

// Closing the window stops the helper. A browser that exits within 4 seconds looks like one that
// handed the page to a window it already had, so the window stays open a little longer than that.
await wait(Math.max(0, 6000 - (Date.now() - launchedAt)));
await browser.close();
const appCode = await Promise.race([exited(app), wait(15000).then(() => 'still running')]);
check(appCode === 0 && !(await portOpen(port)), 'closing the window stops the helper', appCode);
if (appCode === 'still running') app.kill();

// A browser that returns at once (one handing the page to a window it already had): the helper
// keeps serving while the page checks in, then stops.
{
  const idle = launch(['--port', String(port), '--browser', '/bin/true', '--idle', '3']);
  await wait(1000);
  const ping = () => fetch(`http://127.0.0.1:${port}/api/hello`, { headers: { 'X-Skin-Studio': '1' } }).then((r) => r.ok, () => false);
  let alive = true;
  for (let i = 0; i < 6; i++) {
    alive = alive && await ping();
    await wait(1000);
  }
  check(alive, 'with no window to watch, it keeps serving while the page checks in');
  const code = await Promise.race([exited(idle), wait(10000).then(() => 'still running')]);
  check(code === 0, 'and stops once the page goes quiet', code);
  if (code === 'still running') idle.kill();
}

// Problems are explained. PATH is emptied so no message window can open on screen.
{
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'skinstudio-lonely-'));
  fs.copyFileSync(path.join(root, program), path.join(lonely, program));
  fs.chmodSync(path.join(lonely, program), 0o755);
  const run = spawnSync(path.join(lonely, program), [], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
  check(run.status === 1 && /start-studio\.py is missing/.test(run.stderr), 'away from the studio folder it says what\'s missing', run.stderr.trim());
  const noPython = spawnSync(path.join(studio, program), [], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
  check(noPython.status === 1 && /Python 3/.test(noPython.stderr), 'without Python it says to install it', noPython.stderr.trim());
  fs.rmSync(lonely, { recursive: true, force: true });
}

// The applications menu.
{
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'skinstudio-menu-'));
  const install = spawnSync(path.join(studio, program), ['--install'], { env: { ...process.env, XDG_DATA_HOME: data }, encoding: 'utf8' });
  const entryFile = path.join(data, 'applications/pz-skin-studio.desktop');
  const entry = fs.existsSync(entryFile) ? fs.readFileSync(entryFile, 'utf8') : '';
  check(install.status === 0 && entry.includes(`Exec="${path.join(studio, program)}"`) && entry.includes(`Icon=${path.join(studio, 'launcher/icon.png')}`)
    && /StartupWMClass=PZSkinStudio/.test(entry), '--install adds a menu entry that starts the program', entry.split('\n').find((l) => l.startsWith('Exec')));
  const desktopValidate = spawnSync('desktop-file-validate', [entryFile], { encoding: 'utf8' });
  if (!desktopValidate.error) check(desktopValidate.status === 0, 'the menu entry is valid', `${desktopValidate.stdout}${desktopValidate.stderr}`.trim());
  spawnSync(path.join(studio, program), ['--uninstall'], { env: { ...process.env, XDG_DATA_HOME: data } });
  check(!fs.existsSync(entryFile), '--uninstall takes it out again');
  fs.rmSync(data, { recursive: true, force: true });
}

// The second start's headless Chrome has no window to hand over to, so it's still about.
spawnSync('pkill', ['-f', `user-data-dir=${profile}`]);
await wait(500);
fs.rmSync(studio, { recursive: true, force: true });
fs.rmSync(profile, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
