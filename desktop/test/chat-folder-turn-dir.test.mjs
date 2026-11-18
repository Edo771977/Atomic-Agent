// Review of #74: a queued chat that is not stored yet (the window gave it a
// `waiting-…` id before its first turn) and is filed in an import-sorted chat
// folder works in that folder's directory, as a chat with no id does. A
// stored chat keeps its own folder; a remote agent never gets this
// computer's path.
// Built output. Run: npm run build && node --test test/chat-folder-turn-dir.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../out/main/chat-folders.js');
const dir = mkdtempSync(join(tmpdir(), 'folder-turn-dir-'));
after(() => rmSync(dir, {recursive: true, force: true}));
const data = M.coerceChatFolders({
  folders: [{id: 'fa', name: 'app'}, {id: 'fc', name: 'Plain'}],
  chats: {'waiting-1': 'fa', 'stored-1': 'fa', 'waiting-2': 'fc'},
  projects: {fa: dir},
});
const stored = (ids) => async (sid) => ids.includes(sid);

test('a filed chat with an id but no stored turns yet works in the folder\'s directory', async () => {
  assert.equal(await M.folderDirForTurn(data, 'waiting-1', undefined, {remote: false, isStored: stored([])}), dir);
});

test('a stored chat keeps its own folder', async () => {
  assert.equal(await M.folderDirForTurn(data, 'stored-1', undefined, {remote: false, isStored: stored(['stored-1'])}), undefined);
});

test('a new chat (no id) asked for a folder works in its directory without asking the agent', async () => {
  let asked = 0;
  assert.equal(await M.folderDirForTurn(data, null, 'fa', {remote: false, isStored: async () => { asked++; return true; }}), dir);
  assert.equal(asked, 0);
});

test('no directory, no folder or a remote agent: undefined, and the agent is not asked', async () => {
  let asked = 0;
  const isStored = async () => { asked++; return false; };
  assert.equal(await M.folderDirForTurn(data, 'waiting-2', undefined, {remote: false, isStored}), undefined);
  assert.equal(await M.folderDirForTurn(data, 'nowhere', undefined, {remote: false, isStored}), undefined);
  assert.equal(await M.folderDirForTurn(data, 'waiting-1', undefined, {remote: true, isStored}), undefined);
  assert.equal(asked, 0);
});

test('an agent that cannot say counts the chat as stored (its own folder, as before)', async () => {
  assert.equal(await M.folderDirForTurn(data, 'waiting-1', undefined, {remote: false, isStored: async () => { throw new Error('down'); }}), undefined);
});

test('main.ts takes the turn directory from folderDirForTurn', () => {
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  assert.match(main, /const filedDir = await folderDirForTurn\(folders, known, projectId, \{/);
  assert.match(main, /void client\.chat\(turnId, clean, chatId, filedDir \?\? proj\.workingDir, instructions,/);
});
