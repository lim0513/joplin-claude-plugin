// Backend for the Joplin desktop Data API (the "Web Clipper" service).
// Docs: https://joplinapp.org/help/api/references/rest_api/

const NOTE_FIELDS = 'id,title,parent_id,updated_time,is_todo,todo_completed';
const NOTE_FULL_FIELDS = 'id,title,body,parent_id,created_time,updated_time,is_todo,todo_completed,source_url';

const HINT = 'Make sure Joplin desktop is running and the Web Clipper service is enabled ' +
  '(Tools > Options > Web Clipper, or Joplin > Settings > Web Clipper on macOS).';

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : undefined);

async function call(baseUrl, method, p, { token, query = {}, body } = {}) {
  const u = new URL(baseUrl.replace(/\/+$/, '') + p);
  if (token) u.searchParams.set('token', token);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(u, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Cannot reach Joplin at ${baseUrl} (${e.cause?.code || e.message}). ${HINT}`);
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 403) throw new Error('Joplin rejected the API token (HTTP 403). Copy the token from the Web Clipper settings or run the request_local_token tool.');
    throw new Error(`Joplin API ${method} ${p} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// Interactive authorisation: Joplin shows a prompt, the user accepts, we receive the token.
export async function requestLocalToken(baseUrl, { timeoutMs = 120000, interval = 2000 } = {}) {
  const { auth_token } = await call(baseUrl, 'POST', '/auth');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await call(baseUrl, 'GET', '/auth/check', { query: { auth_token } });
    if (r?.status === 'accepted') return r.token;
    if (r?.status === 'rejected') throw new Error('The authorisation request was rejected in Joplin.');
    await new Promise((ok) => setTimeout(ok, interval));
  }
  throw new Error('Timed out waiting for the authorisation to be accepted in Joplin.');
}

export class LocalBackend {
  constructor(cfg) {
    this.kind = 'local';
    this.url = cfg.url.replace(/\/+$/, '');
    this.token = cfg.token;
    this.tokenSource = cfg.tokenSource;
  }

  req(method, p, opts = {}) {
    if (!this.token) throw new Error('No Joplin API token configured. Run /joplin:setup, set JOPLIN_TOKEN, or call the request_local_token tool.');
    return call(this.url, method, p, { ...opts, token: this.token });
  }

  async paginate(p, query = {}, max = Infinity) {
    const out = [];
    for (let page = 1; ; page++) {
      const r = await this.req('GET', p, { query: { ...query, page, limit: 100 } });
      out.push(...r.items);
      if (!r.has_more || out.length >= max) break;
    }
    return out.slice(0, max);
  }

  summary(n) {
    return { id: n.id, title: n.title, notebook_id: n.parent_id, updated: iso(n.updated_time), ...(n.is_todo ? { todo: true, done: !!n.todo_completed } : {}) };
  }

  async status() {
    const ping = await call(this.url, 'GET', '/ping');
    const folders = await this.req('GET', '/folders', { query: { limit: 1 } });
    return { backend: 'local Joplin desktop (Data API)', url: this.url, ping, token: this.tokenSource || 'configured', authenticated: Array.isArray(folders?.items) };
  }

  async listNotebooks() {
    const items = await this.paginate('/folders', { fields: 'id,title,parent_id' });
    return items.map((f) => ({ id: f.id, title: f.title, parent_id: f.parent_id || '' }));
  }

  async listNotes({ notebookId, limit }) {
    const p = notebookId ? `/folders/${notebookId}/notes` : '/notes';
    const items = await this.paginate(p, { fields: NOTE_FIELDS, order_by: 'updated_time', order_dir: 'DESC' }, limit);
    return items.map((n) => this.summary(n));
  }

  async search({ query, limit }) {
    const items = await this.paginate('/search', { query, fields: NOTE_FIELDS }, limit);
    return items.map((n) => this.summary(n));
  }

  async getNote(id) {
    const n = await this.req('GET', `/notes/${id}`, { query: { fields: NOTE_FULL_FIELDS } });
    const tags = await this.paginate(`/notes/${id}/tags`, { fields: 'id,title' });
    return {
      id: n.id, title: n.title, notebook_id: n.parent_id, created: iso(n.created_time), updated: iso(n.updated_time),
      ...(n.is_todo ? { todo: true, done: !!n.todo_completed } : {}),
      ...(n.source_url ? { source_url: n.source_url } : {}),
      tags: tags.map((t) => t.title), body: n.body,
    };
  }

  async createNote({ title, body, notebookId, isTodo }) {
    const n = await this.req('POST', '/notes', { body: { title, body: body || '', parent_id: notebookId, is_todo: isTodo ? 1 : 0 } });
    return { id: n.id, title: n.title, notebook_id: n.parent_id };
  }

  async updateNote({ id, title, body, notebookId }) {
    const patch = {};
    if (title !== undefined) patch.title = title;
    if (body !== undefined) patch.body = body;
    if (notebookId !== undefined) patch.parent_id = notebookId;
    const n = await this.req('PUT', `/notes/${id}`, { body: patch });
    return { id: n.id, title: n.title, notebook_id: n.parent_id };
  }

  async deleteNote(id) {
    await this.req('DELETE', `/notes/${id}`); // moves to trash on Joplin >= 2.15
    return { id, deleted: true };
  }

  async createNotebook({ title, parentId }) {
    const f = await this.req('POST', '/folders', { body: { title, parent_id: parentId || '' } });
    return { id: f.id, title: f.title, parent_id: f.parent_id || '' };
  }

  async listTags() {
    const items = await this.paginate('/tags', { fields: 'id,title' });
    return items.map((t) => ({ id: t.id, title: t.title }));
  }

  async tagNote({ noteId, tags }) {
    const existing = await this.listTags();
    const applied = [];
    for (const name of tags) {
      let tag = existing.find((t) => t.title.toLowerCase() === name.toLowerCase());
      if (!tag) {
        tag = await this.req('POST', '/tags', { body: { title: name } });
        existing.push(tag);
      }
      await this.req('POST', `/tags/${tag.id}/notes`, { body: { id: noteId } });
      applied.push(tag.title);
    }
    return { note_id: noteId, tags: applied };
  }
}
