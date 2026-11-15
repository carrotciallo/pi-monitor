#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, rename, symlink, realpath, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { patchAcp, patchMcpIndex } from './patches.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const agent = resolve(option('--agent-dir', join(homedir(), '.pi', 'agent')));
const npmRoot = resolve(option('--npm-root', join(agent, 'npm', 'node_modules')));
const destination = join(agent, 'monitor-integrations');
const activate = args.includes('--activate');
const sha = text => createHash('sha256').update(text).digest('hex');
const patches = await readFile(join(here, 'patches.mjs'), 'utf8');
const bridge = await readFile(join(here, 'mcp-monitor-bridge.mjs'), 'utf8');
const builds = [];
for (const [name, version, targets] of [
  ['billion-context', '0.1.215', ['dist/agent/pi.js', 'dist/agent/pi-native.js']],
  ['pi-mcp-adapter', '7.0.1', ['index.ts']],
]) {
  const source = join(npmRoot, name);
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (pkg.version !== version) throw Error(`${name}: expected ${version}, got ${pkg.version}; review patches before upgrading`);
  const files = [];
  for (const path of targets) {
    const original = await readFile(join(source, path), 'utf8');
    files.push({ path, originalHash: sha(original), patched: name === 'billion-context' ? patchAcp(original) : patchMcpIndex(original) });
  }
  const fingerprint = sha(patches + bridge + JSON.stringify(files)).slice(0, 16);
  const output = join(destination, `${name}-${version}-${fingerprint}`);
  let existing = false;
  try { await access(output); existing = true; } catch {}
  if (existing) {
    for (const file of files) if (sha(await readFile(join(output, file.path), 'utf8')) !== sha(file.patched)) throw Error(`Installed integration has drifted: ${name}/${file.path}`);
    if (name === 'pi-mcp-adapter' && await readFile(join(output, 'monitor-bridge.mjs'), 'utf8') !== bridge) throw Error('Installed bridge has drifted');
  } else {
    await mkdir(destination, { recursive: true });
    const staging = `${output}.staging-${process.pid}`;
    await cp(source, staging, { recursive: true, filter: path => !path.startsWith(join(source, 'node_modules')) });
    // Resolve dependencies from the managed npm install without editing it.
    await symlink(npmRoot, join(staging, 'node_modules'), 'dir');
    for (const file of files) await writeFile(join(staging, file.path), file.patched);
    if (name === 'pi-mcp-adapter') await writeFile(join(staging, 'monitor-bridge.mjs'), bridge);
    const manifest = { name, version, fingerprint, source, files: files.map(f => ({ path: f.path, originalHash: f.originalHash, installedHash: sha(f.patched) })) };
    await writeFile(join(staging, 'monitor-integration.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rename(staging, output);
  }
  builds.push({ name, version, path: output });
}
if (activate) {
  const path = join(agent, 'settings.json');
  const original = await readFile(path, 'utf8');
  const settings = JSON.parse(original);
  if (!Array.isArray(settings.packages)) throw Error('settings.packages must exist');
  let replacements = 0;
  settings.packages = settings.packages.map(item => {
    const source = typeof item === 'string' ? item : item.source;
    const build = builds.find(b => source === `npm:${b.name}` || source?.startsWith(`npm:${b.name}@`) || source?.startsWith(join(destination, b.name + '-')));
    if (!build) return item;
    replacements++;
    return typeof item === 'string' ? build.path : { ...item, source: build.path };
  });
  if (replacements !== builds.length) throw Error('Expected exactly one configured package per integration; settings unchanged');
  const project = await realpath(join(here, '..'));
  const sources = settings.packages.map(p => typeof p === 'string' ? p : p.source);
  if (!sources.includes(project)) throw Error('pi-monitor repository must already be configured; settings unchanged');
  if (await readFile(path, 'utf8') !== original) throw Error('Settings changed concurrently; activation refused');
  // Only package sources change; never print or back up unrelated settings.
  const temporary = path + `.monitor-${process.pid}`;
  await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
console.log(JSON.stringify({ activated: activate, builds, reloadRequired: activate }, null, 2));
