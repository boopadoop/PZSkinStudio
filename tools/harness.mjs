// Starts the page in headless Chrome the way a double-click would: file://, no special flags.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const pageUrl = `file://${path.join(root, 'PZSkinStudio.html')}`;

export const newProfile = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skinstudio-'));

// A profile passed in is kept, so a test can close the browser and come back.
export async function start({ url = pageUrl, width = 1400, height = 900, profile: kept } = {}) {
  const profile = kept ?? newProfile();
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    userDataDir: profile,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    defaultViewport: { width, height },
  });
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.goto(url);
  const stop = async () => {
    await browser.close();
    if (!kept) fs.rmSync(profile, { recursive: true, force: true });
  };
  return { browser, page, problems, stop };
}

// Loads a folder through the folder input.
export async function openFolder(page, folder, timeout = 180000) {
  const input = await page.$('#dirInput');
  await input.uploadFile(folder);
  await page.evaluate(() => document.getElementById('dirInput').dispatchEvent(new Event('change')));
  await page.waitForFunction(() => window.skinStudio.state.catalog && document.getElementById('busy').hidden, { timeout });
}
