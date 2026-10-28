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

const contracts = [
  { name:'horizontal overflow protection', test:/overflow-x\s*:\s*(?:hidden|clip)/ },
  { name:'display viewport budget', test:/body\[data-mode=["']display["']\]\s*\{[^}]*height\s*:\s*100dvh/s },
  { name:'lobby four-row composition', test:/\.lobby-screen\s*\{[^}]*grid-template-rows\s*:\s*auto\s+auto\s+minmax\(0,1fr\)\s+auto/s },
  { name:'audience flex composition', test:/\.audience-screen\s*\{[^}]*display\s*:\s*flex[^}]*flex-direction\s*:\s*column/s },
  { name:'host card styling', test:/\.host-join\s*\{[^}]*border-color\s*:\s*var\(--pink\)/s },
  { name:'mobile breakpoint', test:/@media\s*\(max-width\s*:\s*860px\)/ }
];
for (const contract of contracts) {
  if (!contract.test.test(css)) throw new Error(`Missing frontend layout contract: ${contract.name}`);
}

console.log('Style architecture audit passed.');
