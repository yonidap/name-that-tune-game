import fs from 'node:fs';

const file = 'test/captain-live-sync.test.js';
let s = fs.readFileSync(file, 'utf8');
const oldText = "  assert.match(client, /setInterval\\(pollAuthoritativeState, 1500\\)/);";
const newText = "  assert.match(client, /mode === 'display' \\? 1500 : 750/);\n  assert.match(client, /if \\(mode !== 'display'\\) \\{[\\s\\S]{0,400}startStatePolling\\(\\);[\\s\\S]{0,200}return;/);";
if (!s.includes(oldText)) throw new Error('legacy polling assertion not found');
s = s.replace(oldText, newText);
fs.writeFileSync(file, s);
console.log('Captain live-sync test aligned with phone polling transport.');
