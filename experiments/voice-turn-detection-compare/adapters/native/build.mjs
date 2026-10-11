#!/usr/bin/env node
/**
 * Build the compiled Whisper log-mel addon (P0.6 / AC3).
 *
 * The addon uses only the STABLE N-API surface, so it links against whatever node headers the
 * machine already has and needs no node-gyp download step. We look for `node_api.h` in the two
 * places a Linux node install usually puts it (the bundled include dir next to `node`, and the
 * distro package's /usr/include/node) and hand the first hit to gcc.
 *
 * Exit 0 on success; on failure print the reason and exit 1 so the caller can record
 * `available:false` rather than crash.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(DIR, 'smart-turn-mel.c');
const OUT = path.join(DIR, 'smart-turn-mel.node');

function headersDir() {
  const candidates = [
    path.join(path.dirname(process.execPath), '..', 'include', 'node'),
    '/usr/include/node',
  ];
  for (const c of candidates) if (existsSync(path.join(c, 'node_api.h'))) return c;
  return null;
}

export function build({ force = false, quiet = false } = {}) {
  if (!force && existsSync(OUT) && statSync(OUT).mtimeMs >= statSync(SRC).mtimeMs) {
    return { built: false, out: OUT };
  }
  const inc = headersDir();
  if (!inc) return { built: false, out: OUT, error: 'no node headers found (looked for node_api.h)' };
  const args = ['-O3', '-march=native', '-shared', '-fPIC', `-I${inc}`, '-o', OUT, SRC, '-lm'];
  try {
    execFileSync('gcc', args, { stdio: quiet ? 'pipe' : 'inherit' });
    return { built: true, out: OUT, headers: inc };
  } catch (err) {
    return { built: false, out: OUT, error: `gcc failed: ${err.message}` };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = build({ force: process.argv.includes('--force') });
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
  console.log(`${r.built ? 'built' : 'up-to-date'}: ${r.out}`);
}
