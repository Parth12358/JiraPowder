// Shared helpers for bump.mjs / check-versions.mjs. Source of truth: src-tauri/tauri.conf.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (f) => join(root, f);

export function read() {
  const tauri = JSON.parse(readFileSync(p('src-tauri/tauri.conf.json'), 'utf8')).version;
  const pkg = JSON.parse(readFileSync(p('package.json'), 'utf8')).version;
  const cargo = readFileSync(p('src-tauri/Cargo.toml'), 'utf8').match(/^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms)?.[1];
  return { 'src-tauri/tauri.conf.json': tauri, 'package.json': pkg, 'src-tauri/Cargo.toml': cargo };
}

export function write(v) {
  const json = (f) => {
    const o = JSON.parse(readFileSync(p(f), 'utf8'));
    o.version = v;
    writeFileSync(p(f), JSON.stringify(o, null, 2) + '\n');
  };
  json('src-tauri/tauri.conf.json');
  json('package.json');
  const lock = JSON.parse(readFileSync(p('package-lock.json'), 'utf8'));
  lock.version = v;
  if (lock.packages?.['']) lock.packages[''].version = v;
  writeFileSync(p('package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const cargo = readFileSync(p('src-tauri/Cargo.toml'), 'utf8');
  writeFileSync(p('src-tauri/Cargo.toml'), cargo.replace(/^(\[package\][^[]*?^version\s*=\s*)"[^"]+"/ms, `$1"${v}"`));
}
