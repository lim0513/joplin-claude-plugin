// End-to-end tests: spawn the MCP server over stdio against in-process mocks of
// the Joplin desktop Data API and Joplin Server. Run with `node --test test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseItem, serializeItem } from '../server/serializer.mjs';

const SERVER = new URL('../server/index.mjs', import.meta.url).pathname;

function listen(handler) {
  return new Promise((ok) => {
    const s = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      handler(req, res, body);
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}

function mcp(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-mcp-test-'));
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, 'cfg'), XDG_CACHE_HOME: path.join(tmp, 'cache'), ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '', nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  const rpc = (method, params) => new Promise((ok) => {
    const id = nextId++;
    pending.set(id, ok);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result;
    const text = r.content[0].text;
    if (r.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { rpc, call, tmp, close: () => child.kill() };
}

test('serializer round-trips Joplin items', () => {
  const text = 'My title\n\nline 1\n\nline 3: with colon\n\nid: abc\nparent_id: def\ntype_: 1';
  const item = parseItem(text);
  assert.equal(item.title, 'My title');
  assert.equal(item.body, 'line 1\n\nline 3: with colon');
  assert.equal(item.props.get('type_'), '1');
  assert.equal(serializeItem(item), text);
  const folder = parseItem('Folder\n\nid: x\ntype_: 2');
  assert.equal(folder.title, 'Folder');
  assert.equal(folder.body, '');
  const nt = parseItem('id: y\nnote_id: a\ntag_id: b\ntype_: 6');
  assert.equal(nt.title, undefined);
  assert.equal(serializeItem(nt), 'id: y\nnote_id: a\ntag_id: b\ntype_: 6');
});

test('local mode against a mock Joplin desktop Data API', async () => {
  const TOKEN = 'secret-token';
  const folders = [{ id: 'f1'.padEnd(32, '0'), title: 'Work', parent_id: '' }];
  const notes = [{ id: 'n1'.padEnd(32, '0'), title: 'Hello', body: 'World', parent_id: folders[0].id, updated_time: 1700000000000, created_time: 1700000000000, is_todo: 0 }];
  const tags = [];
  const noteTags = [];
  const page = (items) => ({ items, has_more: false });
  const srv = await listen((req, res, body) => {
    const u = new URL(req.url, 'http://x');
    const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/ping') return res.end('JoplinClipperServer');
    if (u.pathname === '/auth' && req.method === 'POST') return json({ auth_token: 'at' });
    if (u.pathname === '/auth/check') return json({ status: 'accepted', token: TOKEN });
    if (u.searchParams.get('token') !== TOKEN) return json({ error: 'Invalid token' }, 403);
    const b = body ? JSON.parse(body) : {};
    let m;
    if (u.pathname === '/folders' && req.method === 'GET') return json(page(folders));
    if (u.pathname === '/folders' && req.method === 'POST') { const f = { id: 'f2'.padEnd(32, '0'), ...b }; folders.push(f); return json(f); }
    if ((m = u.pathname.match(/^\/folders\/(\w+)\/notes$/))) return json(page(notes.filter((n) => n.parent_id === m[1])));
    if (u.pathname === '/notes' && req.method === 'GET') return json(page(notes));
    if (u.pathname === '/notes' && req.method === 'POST') { const n = { id: 'n2'.padEnd(32, '0'), updated_time: Date.now(), ...b }; notes.push(n); return json(n); }
    if ((m = u.pathname.match(/^\/notes\/(\w+)\/tags$/))) return json(page(tags.filter((t) => noteTags.some(([n, tg]) => n === m[1] && tg === t.id))));
    if ((m = u.pathname.match(/^\/notes\/(\w+)$/))) {
      const n = notes.find((x) => x.id === m[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      if (req.method === 'PUT') Object.assign(n, b);
      if (req.method === 'DELETE') { notes.splice(notes.indexOf(n), 1); return res.end(); }
      return json(n);
    }
    if (u.pathname === '/search') return json(page(notes.filter((n) => (n.title + n.body).includes(u.searchParams.get('query')))));
    if (u.pathname === '/tags' && req.method === 'GET') return json(page(tags));
    if (u.pathname === '/tags' && req.method === 'POST') { const t = { id: `t${tags.length}`.padEnd(32, '0'), title: b.title }; tags.push(t); return json(t); }
    if ((m = u.pathname.match(/^\/tags\/(\w+)\/notes$/))) { noteTags.push([b.id, m[1]]); return json({}); }
    json({ error: 'unhandled ' + u.pathname }, 404);
  });
  const url = `http://127.0.0.1:${srv.address().port}`;

  // First without a token: tools must explain the problem, then request_local_token fixes it.
  const c = mcp({ JOPLIN_URL: url });
  try {
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'joplin');
    const list = await c.rpc('tools/list', {});
    assert.ok(list.result.tools.length >= 12);
    await assert.rejects(c.call('list_notebooks'), /No Joplin API token/);
    const st = await c.call('request_local_token', { url });
    assert.equal(st.authenticated, true);
    assert.equal(JSON.parse(fs.readFileSync(st.saved_to, 'utf8')).local.token, TOKEN);

    assert.equal((await c.call('list_notebooks'))[0].title, 'Work');
    assert.equal((await c.call('list_notes', { notebook: 'work' }))[0].title, 'Hello');
    assert.equal((await c.call('search_notes', { query: 'World' })).length, 1);
    const created = await c.call('create_note', { title: 'New', body: 'Body', notebook: 'Work', tags: ['claude'] });
    assert.deepEqual(created.tags, ['claude']);
    await c.call('update_note', { note_id: created.id, append: 'More' });
    const got = await c.call('get_note', { note_id: created.id });
    assert.equal(got.body, 'Body\n\nMore');
    assert.deepEqual(got.tags, ['claude']);
    await c.call('delete_note', { note_id: created.id });
    await assert.rejects(c.call('get_note', { note_id: created.id }), /404/);
  } finally { c.close(); srv.close(); }
});

test('server mode against a mock Joplin Server', async () => {
  const store = new Map(); // name -> { content, updated_time }
  let clock = 1;
  const put = (name, content) => store.set(name, { content, updated_time: clock++ });
  const fid = 'a'.repeat(32), nid = 'b'.repeat(32);
  put(`${fid}.md`, `Inbox\n\nid: ${fid}\nparent_id: \ntype_: 2`);
  put(`${nid}.md`, `Shopping list\n\n- milk\n- eggs\n\nid: ${nid}\nparent_id: ${fid}\nupdated_time: 2024-01-01T00:00:00.000Z\nuser_updated_time: 2024-01-01T00:00:00.000Z\ndeleted_time: 0\ntype_: 1`);
  put('info.json', JSON.stringify({ version: 3, e2ee: { value: false } }));
  put('.resource/xyz', 'binary');
  const sessions = new Set();
  const srv = await listen((req, res, body) => {
    const u = new URL(req.url, 'http://x');
    const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/api/sessions' && req.method === 'POST') {
      const { email, password } = JSON.parse(body);
      if (email !== 'me@example.com' || password !== 'pw') return json({ error: 'Invalid username or password' }, 403);
      const id = `s${sessions.size}`; sessions.add(id); return json({ id });
    }
    if (!sessions.has(req.headers['x-api-auth'])) return json({ error: 'Invalid session' }, 403);
    const path_ = decodeURIComponent(u.pathname);
    if (path_ === '/api/items/root:/:/children') {
      // two pages to exercise cursor pagination
      const all = [...store].map(([name, v]) => ({ name, updated_time: v.updated_time }));
      const start = Number(u.searchParams.get('cursor') || 0);
      const items = all.slice(start, start + 2);
      return json({ items, has_more: start + 2 < all.length, cursor: String(start + 2) });
    }
    const m = path_.match(/^\/api\/items\/root:\/(.+):\/content$/);
    if (m && req.method === 'GET') { const v = store.get(m[1]); if (!v) return json({ error: 'nf' }, 404); return res.end(v.content); }
    if (m && req.method === 'PUT') { put(m[1], body); return json({ name: m[1], updated_time: store.get(m[1]).updated_time }); }
    json({ error: 'unhandled ' + path_ }, 404);
  });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const base = { JOPLIN_SERVER_URL: url, JOPLIN_SERVER_EMAIL: 'me@example.com', JOPLIN_SERVER_PASSWORD: 'pw' };

  const ro = mcp(base);
  try {
    const st = await ro.call('status');
    assert.equal(st.notes, 1);
    assert.equal(st.notebooks, 1);
    assert.equal(st.write_enabled, false);
    assert.equal((await ro.call('search_notes', { query: 'MILK' }))[0].title, 'Shopping list');
    assert.equal((await ro.call('get_note', { note_id: nid })).body, '- milk\n- eggs');
    await assert.rejects(ro.call('create_note', { title: 'x' }), /disabled/);
  } finally { ro.close(); }

  const rw = mcp({ ...base, JOPLIN_SERVER_ALLOW_WRITE: 'true' });
  try {
    const created = await rw.call('create_note', { title: 'From Claude', body: 'Hi', tags: ['ai'] });
    assert.equal(created.notebook_id, fid); // defaults to "Inbox"
    const stored = parseItem(store.get(`${created.id}.md`).content);
    assert.equal(stored.title, 'From Claude');
    assert.equal(stored.props.get('parent_id'), fid);
    await rw.call('update_note', { note_id: nid, append: '- bread' });
    assert.equal(parseItem(store.get(`${nid}.md`).content).body, '- milk\n- eggs\n\n- bread');
    const got = await rw.call('get_note', { note_id: created.id });
    assert.deepEqual(got.tags, ['ai']);
    const nb = await rw.call('create_notebook', { title: 'Projects', parent: 'Inbox' });
    await rw.call('update_note', { note_id: created.id, notebook: 'Projects' });
    assert.equal(parseItem(store.get(`${created.id}.md`).content).props.get('parent_id'), nb.id);
    await rw.call('delete_note', { note_id: created.id });
    assert.notEqual(parseItem(store.get(`${created.id}.md`).content).props.get('deleted_time'), '0');
    assert.equal((await rw.call('list_notes', {})).length, 1);
  } finally { rw.close(); srv.close(); }
});
