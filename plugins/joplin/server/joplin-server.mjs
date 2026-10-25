// Backend for Joplin Server (official or self-hosted).
//
// Joplin Server has no note-level REST API: it stores the sync target, i.e. one
// serialized item per note/notebook/tag (`<id>.md`). We log in with a session,
// list the items, keep a local index (memory + optional disk cache keyed by the
// item's updated_time) and read/write items in Joplin's sync format. Joplin
// clients pick up our changes on their next sync.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TYPE, parseItem, serializeItem, typeOf, newNote, newFolder, newTag, newNoteTag, touch } from './serializer.mjs';

const ITEM_RE = /^[0-9a-zA-Z]{32}\.md$/;
const REFRESH_TTL_MS = 10000;

async function pool(list, size, fn) {
  let next = 0;
  const worker = async () => { while (next < list.length) await fn(list[next++]); };
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, worker));
}

const alive = (item) => !Number(item.props.get('deleted_time') || 0);
const encrypted = (item) => item.props.get('encryption_applied') === '1';

export class ServerBackend {
  constructor(cfg) {
    if (!cfg.url) throw new Error('Joplin Server URL is not configured. Run /joplin:setup or set JOPLIN_SERVER_URL.');
    if (!cfg.email || !cfg.password) throw new Error('Joplin Server email/password are not configured. Run /joplin:setup or set JOPLIN_SERVER_EMAIL and JOPLIN_SERVER_PASSWORD.');
    this.kind = 'server';
    this.url = cfg.url.replace(/\/+$/, '');
    this.email = cfg.email;
    this.password = cfg.password;
    this.allowWrite = cfg.allowWrite;
    this.items = new Map(); // name -> { updated, text, item }
    this.lastRefresh = 0;
    this.cacheFile = cfg.cache
      ? path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'joplin-mcp',
        crypto.createHash('sha1').update(`${this.url}\n${this.email}`).digest('hex') + '.json')
      : null;
    this.loadDiskCache();
  }

  // ---- HTTP ---------------------------------------------------------------

  async fetch(method, p, { query, headers = {}, body } = {}) {
    const u = new URL(this.url + p);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) u.searchParams.set(k, String(v));
    try {
      return await fetch(u, { method, headers, body });
    } catch (e) {
      throw new Error(`Cannot reach Joplin Server at ${this.url} (${e.cause?.code || e.message}).`);
    }
  }

  async login() {
    const res = await this.fetch('POST', '/api/sessions', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Joplin Server login failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    this.session = JSON.parse(text).id;
  }

  async req(method, p, { query, body, retry = true } = {}) {
    if (!this.session) await this.login();
    const headers = { 'X-API-AUTH': this.session };
    if (body !== undefined) headers['Content-Type'] = 'application/octet-stream';
    const res = await this.fetch(method, p, { query, headers, body });
    if ((res.status === 401 || res.status === 403) && retry) {
      this.session = null; // session expired: log in again once
      return this.req(method, p, { query, body, retry: false });
    }
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Joplin Server ${method} ${p} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return text;
  }

  itemPath(name) { return `/api/items/root:/${name}:`; }

  async listChildren() {
    const out = [];
    let cursor;
    do {
      const r = JSON.parse(await this.req('GET', '/api/items/root:/:/children', { query: { cursor } }));
      out.push(...r.items);
      cursor = r.has_more ? r.cursor : undefined;
    } while (cursor);
    return out;
  }

  async syncInfo() {
    if (this.info !== undefined) return this.info;
    try {
      this.info = JSON.parse(await this.req('GET', `${this.itemPath('info.json')}/content`));
    } catch (e) {
      if (e.status !== 404) throw e;
      this.info = null;
    }
    return this.info;
  }

  async e2ee() {
    const info = await this.syncInfo();
    return !!(info?.e2ee?.value ?? info?.e2ee);
  }

  // ---- Index --------------------------------------------------------------

  loadDiskCache() {
    if (!this.cacheFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      for (const [name, { updated, text }] of Object.entries(data.items || {})) this.setItem(name, updated, text);
    } catch { /* no cache yet */ }
  }

  saveDiskCache() {
    if (!this.cacheFile) return;
    const items = {};
    for (const [name, { updated, text }] of this.items) items[name] = { updated, text };
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, JSON.stringify({ version: 1, items }), { mode: 0o600 });
  }

  setItem(name, updated, text) {
    let item = null;
    try { item = parseItem(text); } catch { /* not an item we understand */ }
    this.items.set(name, { updated, text, item });
  }

  async refresh(force = false) {
    if (!force && Date.now() - this.lastRefresh < REFRESH_TTL_MS) return;
    const children = (await this.listChildren()).filter((c) => ITEM_RE.test(c.name));
    const seen = new Set(children.map((c) => c.name));
    let changed = false;
    for (const name of [...this.items.keys()]) {
      if (!seen.has(name)) { this.items.delete(name); changed = true; }
    }
    const stale = children.filter((c) => this.items.get(c.name)?.updated !== c.updated_time);
    await pool(stale, 8, async (c) => {
      this.setItem(c.name, c.updated_time, await this.req('GET', `${this.itemPath(c.name)}/content`));
    });
    this.lastRefresh = Date.now();
    if (changed || stale.length) this.saveDiskCache();
  }

  *all(type) {
    for (const { item } of this.items.values()) if (item && typeOf(item) === type && alive(item)) yield item;
  }

  find(id, type) {
    const item = this.items.get(`${id}.md`)?.item;
    if (!item || (type && typeOf(item) !== type) || !alive(item)) throw new Error(`No ${type === TYPE.FOLDER ? 'notebook' : 'note'} with id ${id}`);
    return item;
  }

  async assertWritable() {
    if (!this.allowWrite) {
      throw new Error('Writing to Joplin Server is disabled (read-only by default). Set "allowWrite": true in the server section of the config file, or JOPLIN_SERVER_ALLOW_WRITE=true, then restart Claude Code.');
    }
    if (await this.e2ee()) {
      throw new Error('This Joplin Server account uses end-to-end encryption; this plugin cannot write encrypted items. Use local mode against Joplin desktop instead.');
    }
  }

  async putItem(item) {
    await this.assertWritable();
    const name = `${item.props.get('id')}.md`;
    const text = serializeItem(item);
    const r = await this.req('PUT', `${this.itemPath(name)}/content`, { body: text });
    let updated;
    try { updated = JSON.parse(r).updated_time; } catch { /* refetched on next refresh */ }
    this.setItem(name, updated, text);
    this.saveDiskCache();
    return item;
  }

  // ---- Presentation -------------------------------------------------------

  summary(n) {
    return {
      id: n.props.get('id'),
      title: encrypted(n) ? '[encrypted]' : n.title,
      notebook_id: n.props.get('parent_id'),
      updated: n.props.get('user_updated_time') || n.props.get('updated_time'),
      ...(n.props.get('is_todo') === '1' ? { todo: true, done: Number(n.props.get('todo_completed')) > 0 } : {}),
    };
  }

  notesSorted() {
    return [...this.all(TYPE.NOTE)].sort((a, b) =>
      String(b.props.get('user_updated_time') || b.props.get('updated_time')).localeCompare(String(a.props.get('user_updated_time') || a.props.get('updated_time'))));
  }

  tagsOf(noteId) {
    const tags = new Map([...this.all(TYPE.TAG)].map((t) => [t.props.get('id'), t.title]));
    return [...this.all(TYPE.NOTE_TAG)]
      .filter((nt) => nt.props.get('note_id') === noteId)
      .map((nt) => tags.get(nt.props.get('tag_id')))
      .filter(Boolean);
  }

  // ---- Backend interface --------------------------------------------------

  async status() {
    await this.login();
    await this.refresh(true);
    const count = (t) => [...this.all(t)].length;
    return {
      backend: 'Joplin Server (sync API)', url: this.url, user: this.email,
      e2ee: await this.e2ee(), write_enabled: this.allowWrite,
      notebooks: count(TYPE.FOLDER), notes: count(TYPE.NOTE), tags: count(TYPE.TAG),
      cache: this.cacheFile || 'disabled',
    };
  }

  async listNotebooks() {
    await this.refresh();
    return [...this.all(TYPE.FOLDER)].map((f) => ({ id: f.props.get('id'), title: encrypted(f) ? '[encrypted]' : f.title, parent_id: f.props.get('parent_id') || '' }));
  }

  async listNotes({ notebookId, limit }) {
    await this.refresh();
    return this.notesSorted().filter((n) => !notebookId || n.props.get('parent_id') === notebookId).slice(0, limit).map((n) => this.summary(n));
  }

  async search({ query, limit }) {
    await this.refresh();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];
    for (const n of this.notesSorted()) {
      if (encrypted(n)) continue;
      const title = (n.title || '').toLowerCase();
      const hay = `${title}\n${n.body.toLowerCase()}`;
      if (!terms.every((t) => hay.includes(t))) continue;
      scored.push({ n, score: terms.filter((t) => title.includes(t)).length });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ n }) => this.summary(n));
  }

  async getNote(id) {
    await this.refresh();
    const n = this.find(id, TYPE.NOTE);
    if (encrypted(n)) throw new Error('This note is end-to-end encrypted and cannot be read through Joplin Server. Use local mode instead.');
    return {
      ...this.summary(n), created: n.props.get('user_created_time') || n.props.get('created_time'),
      ...(n.props.get('source_url') ? { source_url: n.props.get('source_url') } : {}),
      tags: this.tagsOf(id), body: n.body,
    };
  }

  async createNote({ title, body, notebookId, isTodo }) {
    await this.refresh();
    if (!notebookId) {
      const folders = [...this.all(TYPE.FOLDER)].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      const target = folders.find((f) => /^inbox$/i.test(f.title)) || folders[0];
      if (!target) throw new Error('There are no notebooks yet; create one first with create_notebook.');
      notebookId = target.props.get('id');
    } else this.find(notebookId, TYPE.FOLDER);
    const n = await this.putItem(newNote({ title, body, parentId: notebookId, isTodo }));
    return { id: n.props.get('id'), title: n.title, notebook_id: notebookId };
  }

  async updateNote({ id, title, body, notebookId }) {
    await this.refresh(true);
    const n = this.find(id, TYPE.NOTE);
    if (encrypted(n)) throw new Error('Cannot modify an encrypted note.');
    if (title !== undefined) n.title = title;
    if (body !== undefined) n.body = body;
    if (notebookId !== undefined) { this.find(notebookId, TYPE.FOLDER); n.props.set('parent_id', notebookId); }
    touch(n);
    await this.putItem(n);
    return { id, title: n.title, notebook_id: n.props.get('parent_id') };
  }

  async deleteNote(id) {
    await this.refresh(true);
    const n = this.find(id, TYPE.NOTE);
    n.props.set('deleted_time', Date.now()); // soft delete: the note goes to Joplin's trash
    touch(n);
    await this.putItem(n);
    return { id, deleted: true, note: 'Moved to trash; clients apply it on next sync.' };
  }

  async createNotebook({ title, parentId }) {
    await this.refresh();
    if (parentId) this.find(parentId, TYPE.FOLDER);
    const f = await this.putItem(newFolder({ title, parentId }));
    return { id: f.props.get('id'), title, parent_id: parentId || '' };
  }

  async listTags() {
    await this.refresh();
    return [...this.all(TYPE.TAG)].map((t) => ({ id: t.props.get('id'), title: t.title }));
  }

  async tagNote({ noteId, tags }) {
    await this.refresh(true);
    this.find(noteId, TYPE.NOTE);
    const existing = this.tagsOf(noteId).map((t) => t.toLowerCase());
    const applied = [];
    for (const name of tags) {
      let tag = [...this.all(TYPE.TAG)].find((t) => (t.title || '').toLowerCase() === name.toLowerCase());
      if (!tag) tag = await this.putItem(newTag({ title: name }));
      if (!existing.includes(tag.title.toLowerCase())) {
        await this.putItem(newNoteTag({ noteId, tagId: tag.props.get('id') }));
      }
      applied.push(tag.title);
    }
    return { note_id: noteId, tags: applied };
  }
}
