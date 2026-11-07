// Reading the studio's folder. Chrome and Edge get a handle that can be written to and re-read;
// other browsers fall back to a folder upload input, which is read-only.
import { get, put } from './library.js';

const WANTED = /^(species\.lua|mod\.info)$|\.(fbx|png|xml|zip)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'anims_x']);

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

// Saves into the folder's skins/ directory, keeping whatever is there under a new name.
export async function saveToSkins(root, fileName, bytes) {
  if (await root.requestPermission({ mode: 'readwrite' }) !== 'granted') return null;
  const dir = await root.getDirectoryHandle('skins', { create: true });
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
