import fs from 'node:fs';

const file = 'src/server.js';
let s = fs.readFileSync(file, 'utf8');
const oldText = "    display: recent('display') || clients.some((client) => client.role === 'display'),";
const newText = "    display: clients.some((client) => client.role === 'display'),";
if (!s.includes(oldText)) throw new Error('display presence line not found after phone-authority patch');
s = s.replace(oldText, newText);
fs.writeFileSync(file, s);
console.log('Display realtime presence semantics preserved.');
