#!/usr/bin/env node
// node scripts/bump.mjs 0.2.0 → sets the version in tauri.conf.json, package.json and Cargo.toml.
// Then: (cd src-tauri && cargo update -p blockmap) to refresh Cargo.lock, commit, tag v0.2.0, push the tag.
import { read, write } from './versions.mjs';

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? '')) {
  console.error('usage: node scripts/bump.mjs <x.y.z>');
  process.exit(1);
}
write(v);
console.log(read());
