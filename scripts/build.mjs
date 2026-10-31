import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
const pages = ['why', 'custom', 'architecture', 'opencode', 'pods', 'memories', 'plan', 'map'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await copyFile('index.html', 'dist/index.html');
await copyFile('_redirects', 'dist/_redirects');
await cp('assets', 'dist/assets', { recursive: true });
for (const page of pages) await cp(page, `dist/${page}`, { recursive: true });
