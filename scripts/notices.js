#!/usr/bin/env node
'use strict';

// Regenerates NOTICE from what actually ships in the built app, not from what is
// sitting in node_modules. Two inputs:
//   - package.json "dependencies"  (electron-builder bundles these)
//   - the Electron runtime          (a devDependency, but it is the app shell)
// Dev tooling (electron-builder, test runners) never ships, so it is not listed.
//
// Run: npm run notices

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

function readMeta(name) {
  try {
    const p = require(path.join(root, 'node_modules', name, 'package.json'));
    const lic = typeof p.license === 'string'
      ? p.license
      : (p.license && p.license.type) || (Array.isArray(p.licenses) ? p.licenses.map((l) => l.type).join(', ') : 'UNKNOWN');
    return {
      name: p.name || name,
      version: p.version || '(unknown)',
      license: lic,
      repo: typeof p.repository === 'string' ? p.repository : (p.repository && p.repository.url) || ''
    };
  } catch (_) {
    return { name, version: '(not installed)', license: 'UNKNOWN', repo: '' };
  }
}

const clean = (url) => String(url || '').replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');

const entries = [];

const electron = readMeta('electron');
if (electron.version !== '(not installed)') {
  entries.push(Object.assign({}, electron, {
    note: 'Electron bundles Chromium and Node.js. Their notices ship inside the application as LICENSE.electron.txt and LICENSES.chromium.html.'
  }));
}

for (const name of Object.keys(pkg.dependencies || {}).sort()) {
  entries.push(readMeta(name));
}

const owner = (pkg.author && pkg.author.name) || 'The Connect Group';
const title = (pkg.build && pkg.build.productName) || pkg.name;

const out = [];
out.push(title);
out.push('Copyright ' + new Date().getFullYear() + ' ' + owner);
out.push('');
out.push('This product includes the following third-party software:');
out.push('');
for (const e of entries) {
  out.push(e.name + ' ' + e.version + ' — ' + e.license);
  if (e.repo) out.push('  ' + clean(e.repo));
  if (e.note) out.push('  ' + e.note);
  out.push('');
}

fs.writeFileSync(path.join(root, 'NOTICE'), out.join('\n'), 'utf8');
console.log('NOTICE written: ' + entries.length + ' component(s)');
