import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { songs } from '../data/songs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const audioDir = path.join(root, 'public', 'audio');
const revealDir = path.join(audioDir, 'reveal');

const expectedGameplay = songs.map((song) => path.basename(song.audioFile)).sort();

for (const song of songs) {
  assert.equal(
    song.audioFile,
    `/audio/${song.id}.mp3`,
    `${song.title} should use /audio/${song.id}.mp3`
  );
  assert.ok(
    fs.existsSync(path.join(root, 'public', song.audioFile)),
    `Missing gameplay snippet for ${song.title}: ${song.audioFile}`
  );
}

const actualGameplay = fs.readdirSync(audioDir)
  .filter((name) => name.toLowerCase().endsWith('.mp3'))
  .sort();
assert.deepEqual(
  actualGameplay,
  expectedGameplay,
  'Gameplay MP3 files must match the song bank exactly; remove orphan files or fix audioFile mappings.'
);

assert.ok(fs.existsSync(revealDir), 'Reveal audio directory is missing.');
const revealFiles = fs.readdirSync(revealDir)
  .filter((name) => name.toLowerCase().endsWith('.mp3'))
  .sort();
assert.deepEqual(
  revealFiles,
  expectedGameplay,
  'Reveal MP3 files must match the song bank exactly; every song needs one reveal file with the same filename.'
);

console.log(`Audio mapping audit passed: ${expectedGameplay.length} gameplay + ${revealFiles.length} reveal snippets`);
