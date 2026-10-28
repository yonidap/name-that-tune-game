import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/game.css'), 'utf8');

const stylesheetLinks = [...html.matchAll(/<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
if (stylesheetLinks.length !== 1 || stylesheetLinks[0] !== '/game.css') {
  throw new Error(`Expected exactly one stylesheet (/game.css), got: ${stylesheetLinks.join(', ') || 'none'}`);
}

for (const legacy of ['qr.css','playback.css','layout-scale.css','viewport.css','rhythm.css','readability.css']) {
  if (fs.existsSync(path.join(root, 'public', legacy))) throw new Error(`Legacy override stylesheet returned: ${legacy}`);
  if (html.includes(legacy)) throw new Error(`index.html still references legacy stylesheet: ${legacy}`);
}

const requiredContracts = [
  'overflow-x:hidden',
  'body[data-mode="display"]{height:100dvh',
  '.lobby-screen{display:grid;grid-template-rows:auto auto minmax(0,1fr) auto',
  '.audience-screen{display:flex;flex-direction:column',
  '.host-join{border-color:var(--pink)',
  '@media(max-width:860px)'
];
for (const contract of requiredContracts) {
  if (!css.includes(contract)) throw new Error(`Missing frontend layout contract: ${contract}`);
}

console.log('Style architecture audit passed.');
