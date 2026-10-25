#!/usr/bin/env node
// Fails if tauri.conf.json, package.json and Cargo.toml disagree on the version.
import { read } from './versions.mjs';

const v = read();
const distinct = new Set(Object.values(v));
if (distinct.size !== 1) {
  console.error('Version mismatch:', v, '\nRun: node scripts/bump.mjs <x.y.z>');
  process.exit(1);
}
console.log('version', [...distinct][0]);
