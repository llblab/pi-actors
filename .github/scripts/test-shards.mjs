/** CI-only file partition and launcher; no runtime policy or partial-test success gate. */
import { globSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARDS = Object.freeze(['installed', 'owners-a', 'owners-b']);
export const TEST_FLAGS = Object.freeze(['--import', './tests/test-environment.mjs', '--experimental-strip-types', '--test', '--test-concurrency=1']);
const installed = 'installed.scripts.test.ts';

export function partitionTests(basenames) {
  const names = [...basenames].sort();
  if (names.some(name => typeof name !== 'string' || !name.endsWith('.test.ts') || /[/\\]/u.test(name)) || new Set(names).size !== names.length) {
    throw new Error('Expected unique top-level test basenames');
  }
  if (!names.includes(installed)) throw new Error('Missing installed test owner');
  const groups = { installed: [installed], 'owners-a': [], 'owners-b': [] };
  names.filter(name => name !== installed).forEach((name, index) => groups[index % 2 ? 'owners-b' : 'owners-a'].push(name));
  if (SHARDS.some(shard => groups[shard].length === 0)) throw new Error('Empty test shard');
  return groups;
}

export function parseArgs(args) {
  if (args.length < 1 || args.length > 2 || !SHARDS.includes(args[0]) || (args.length === 2 && args[1] !== '--list')) {
    throw new Error(`Usage: node .github/scripts/test-shards.mjs <${SHARDS.join('|')}> [--list]`);
  }
  return { shard: args[0], list: args.length === 2 };
}

export function testArgs(basenames) {
  return [...TEST_FLAGS, ...basenames.map(name => join('tests', name))];
}

export function runCli(args) {
  // Validate before discovering files or starting any workload.
  const { shard, list } = parseArgs(args);
  const groups = partitionTests(globSync('*.test.ts', { cwd: 'tests' }));
  const selected = groups[shard];
  if (list) {
    console.log(JSON.stringify({ shard, count: selected.length, files: selected.map(name => join('tests', name)) }));
    return;
  }
  const child = spawn(process.execPath, testArgs(selected), { stdio: 'inherit', shell: false });
  child.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    if (signal) console.error(`Test shard terminated by ${signal}`);
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
