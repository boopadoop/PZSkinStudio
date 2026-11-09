// Reading the studio's folder. Chrome and Edge get a handle that can be written to and re-read;
// other browsers fall back to a folder upload input, which is read-only.
import { get, put } from './library.js';

const WANTED = /^(species\.lua|mod\.info)$|\.(fbx|png|xml|zip)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'anims_x', 'paint history']);
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);

export const canPickFolder = 'showDirectoryPicker' in window;

async function walk(dir, prefix, out) {
  for await (const [name, handle] of dir.entries()) {
    const path = prefix + name;
    if (handle.kind === 'directory') {
      if (!SKIP_DIRS.has(name.toLowerCase())) await walk(handle, `${path}/`, out);
    } else if (WANTED.test(name)) {
      out.push({ path, open: () => handle.getFile() });
    }
  }
  return out;
}

export const listHandle = (handle) => walk(handle, '', []);

// The folder input gives paths starting with the folder's own name.
export function listInput(files) {
  return [...files]
    .filter((file) => WANTED.test(file.name))
    .map((file) => ({
      path: file.webkitRelativePath.slice(file.webkitRelativePath.indexOf('/') + 1),
      open: async () => file,
    }));
}

export const rememberFolder = (handle) => put('folder', 'current', handle);
export const recallFolder = () => get('folder', 'current');

// Writes into one of the studio folder's own folders, such as skins/ or paint history/, keeping
// whatever is there under a new name. A file with the same bytes isn't written twice. Returns the
// name it was saved under, or null if the browser wasn't allowed to write.
export async function saveInFolder(root, folder, fileName, bytes) {
  if (root === HELPER) return helperSave(folder, fileName, bytes);
  if (await root.requestPermission({ mode: 'readwrite' }) !== 'granted') return null;
  const dir = await root.getDirectoryHandle(folder, { create: true });
  const dot = fileName.indexOf('.');
  const [name, extension] = [fileName.slice(0, dot), fileName.slice(dot)];
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? fileName : `${name} (${n})${extension}`;
    let existing = null;
    try {
      existing = await (await dir.getFileHandle(candidate)).getFile();
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }
    if (existing) {
      const same = existing.size === bytes.length
        && new Uint8Array(await existing.arrayBuffer()).every((b, i) => b === bytes[i]);
      if (same) return candidate;
      continue;
    }
    const writable = await (await dir.getFileHandle(candidate, { create: true })).createWritable();
    await writable.write(bytes);
    await writable.close();
    return candidate;
  }
}

export const saveToSkins = (root, fileName, bytes) => saveInFolder(root, 'skins', fileName, bytes);

// ---- The helper ----------------------------------------------------------------------------
// Firefox can't write into a folder from a page. start-studio.py serves the studio folder on this
// computer only, and does the reading and saving for it. HELPER stands in for a folder handle.

export const HELPER = Object.freeze({ name: 'helper' });
const HEADERS = { 'X-Skin-Studio': '1' };

export async function findHelper() {
  if (!/^https?:$/.test(location.protocol)) return false;
  try {
    const answer = await fetch('api/hello', { headers: HEADERS });
    return answer.ok && (await answer.json()).studio === true;
  } catch {
    return false;
  }
}

// Tells the helper the page is still open. Started as an app, it stops once it stops hearing this.
export function keepHelperAwake() {
  setInterval(() => { fetch('api/hello', { headers: HEADERS }).catch(() => {}); }, 30000);
}

export async function listHelper() {
  const answer = await fetch('api/files', { headers: HEADERS });
  if (!answer.ok) throw new Error(`the helper answered ${answer.status}`);
  const { name, files } = await answer.json();
  const entries = files
    .filter((path) => WANTED.test(baseName(path)) && !path.split('/').some((part) => SKIP_DIRS.has(part.toLowerCase())))
    .map((path) => ({
      path,
      open: async () => {
        const file = await fetch(path.split('/').map(encodeURIComponent).join('/'));
        if (!file.ok) throw new Error(`could not read ${path}`);
        return file.blob();
      },
    }));
  return { name, entries };
}

async function helperSave(folder, fileName, bytes) {
  const query = new URLSearchParams({ folder, name: fileName });
  const answer = await fetch(`api/save?${query}`, { method: 'POST', headers: HEADERS, body: bytes });
  if (!answer.ok) throw new Error(await answer.text() || `the helper answered ${answer.status}`);
  return (await answer.json()).name;
}

// Saves through the browser's save window where it has one, and to Downloads where it doesn't.
// Throws an AbortError if the user cancels.
export async function saveFile(bytes, fileName, { type, description, startIn }) {
  if (!('showSaveFilePicker' in window)) {
    download(bytes, fileName, type);
    return;
  }
  const handle = await window.showSaveFilePicker({
    suggestedName: fileName,
    ...(startIn ? { startIn } : {}),
    types: [{ description, accept: { [type]: [fileName.slice(fileName.indexOf('.'))] } }],
  });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

export function download(bytes, fileName, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
