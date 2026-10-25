#!/usr/bin/env node
// Zero-dependency MCP server (stdio, newline-delimited JSON-RPC) exposing Joplin
// notes from either Joplin desktop (Data API) or Joplin Server.
import { createInterface } from 'node:readline';
import { loadConfig, saveConfigFile, configPath } from './config.mjs';
import { LocalBackend, requestLocalToken } from './local.mjs';
import { ServerBackend } from './joplin-server.mjs';

const VERSION = '0.1.0';
const log = (...a) => console.error('[joplin-mcp]', ...a);

let backend = null;
function getBackend() {
  if (!backend) {
    const cfg = loadConfig();
    backend = cfg.mode === 'server' ? new ServerBackend(cfg.server) : new LocalBackend(cfg.local);
  }
  return backend;
}

// Accept a notebook id or an (unambiguous, case-insensitive) notebook title.
async function resolveNotebook(b, ref) {
  if (!ref) return undefined;
  const notebooks = await b.listNotebooks();
  if (notebooks.some((f) => f.id === ref)) return ref;
  const matches = notebooks.filter((f) => f.title.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error(`Several notebooks are named "${ref}"; pass one of these ids: ${matches.map((m) => m.id).join(', ')}`);
  throw new Error(`No notebook with id or title "${ref}". Use list_notebooks to see what exists.`);
}

const str = (description) => ({ type: 'string', description });
const NOTEBOOK = str('Notebook id or exact notebook title');

const TOOLS = [
  {
    name: 'status',
    description: 'Check the Joplin connection: which backend is configured (local desktop or Joplin Server), whether authentication works, and basic counts.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({ config_file: configPath(), ...(await getBackend().status()) }),
  },
  {
    name: 'list_notebooks',
    description: 'List all Joplin notebooks (folders) with their ids and parent ids.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => getBackend().listNotebooks(),
  },
  {
    name: 'list_notes',
    description: 'List notes, most recently updated first, optionally restricted to one notebook. Returns ids and titles only (use get_note for content).',
    inputSchema: { type: 'object', properties: { notebook: NOTEBOOK, limit: { type: 'number', description: 'Max notes to return (default 50)' } } },
    run: async ({ notebook, limit = 50 }) => {
      const b = getBackend();
      return b.listNotes({ notebookId: await resolveNotebook(b, notebook), limit });
    },
  },
  {
    name: 'search_notes',
    description: 'Full-text search notes. In local mode the full Joplin search syntax works (e.g. "tag:work notebook:Projects created:202401"); in server mode all words must appear in the title or body.',
    inputSchema: { type: 'object', properties: { query: str('Search query'), limit: { type: 'number', description: 'Max results (default 20)' } }, required: ['query'] },
    run: async ({ query, limit = 20 }) => getBackend().search({ query, limit }),
  },
  {
    name: 'get_note',
    description: 'Get a note\'s full Markdown body, notebook, tags and timestamps.',
    inputSchema: { type: 'object', properties: { note_id: str('Note id') }, required: ['note_id'] },
    run: async ({ note_id }) => getBackend().getNote(note_id),
  },
  {
    name: 'create_note',
    description: 'Create a new Markdown note, optionally in a notebook and with tags.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('Note title'), body: str('Markdown body'), notebook: NOTEBOOK,
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names (created if missing)' },
        is_todo: { type: 'boolean', description: 'Create as a to-do' },
      },
      required: ['title'],
    },
    run: async ({ title, body, notebook, tags, is_todo }) => {
      const b = getBackend();
      const note = await b.createNote({ title, body, notebookId: await resolveNotebook(b, notebook), isTodo: is_todo });
      if (tags?.length) note.tags = (await b.tagNote({ noteId: note.id, tags })).tags;
      return note;
    },
  },
  {
    name: 'update_note',
    description: 'Update a note: replace its title and/or body, append text to the body, or move it to another notebook.',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: str('Note id'), title: str('New title'), body: str('New body (replaces the whole body)'),
        append: str('Text appended to the end of the body (ignored if body is given)'), notebook: { ...NOTEBOOK, description: 'Move to this notebook (id or title)' },
      },
      required: ['note_id'],
    },
    run: async ({ note_id, title, body, append, notebook }) => {
      const b = getBackend();
      if (body === undefined && append) {
        const current = (await b.getNote(note_id)).body || '';
        body = current ? `${current.replace(/\s+$/, '')}\n\n${append}` : append;
      }
      return b.updateNote({ id: note_id, title, body, notebookId: await resolveNotebook(b, notebook) });
    },
  },
  {
    name: 'delete_note',
    description: 'Move a note to the Joplin trash.',
    inputSchema: { type: 'object', properties: { note_id: str('Note id') }, required: ['note_id'] },
    run: async ({ note_id }) => getBackend().deleteNote(note_id),
  },
  {
    name: 'create_notebook',
    description: 'Create a notebook, optionally nested inside another notebook.',
    inputSchema: { type: 'object', properties: { title: str('Notebook title'), parent: { ...NOTEBOOK, description: 'Parent notebook id or title' } }, required: ['title'] },
    run: async ({ title, parent }) => {
      const b = getBackend();
      return b.createNotebook({ title, parentId: await resolveNotebook(b, parent) });
    },
  },
  {
    name: 'list_tags',
    description: 'List all tags.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => getBackend().listTags(),
  },
  {
    name: 'tag_note',
    description: 'Add tags to a note (tags are created if they do not exist).',
    inputSchema: { type: 'object', properties: { note_id: str('Note id'), tags: { type: 'array', items: { type: 'string' } } }, required: ['note_id', 'tags'] },
    run: async ({ note_id, tags }) => getBackend().tagNote({ noteId: note_id, tags }),
  },
  {
    name: 'request_local_token',
    description: 'Obtain an API token from a running Joplin desktop app: Joplin shows an authorisation prompt that the user must accept within 2 minutes. The token is saved to the config file and local mode is selected.',
    inputSchema: { type: 'object', properties: { url: str('Data API URL (default http://127.0.0.1:41184)') } },
    run: async ({ url = 'http://127.0.0.1:41184' }) => {
      const token = await requestLocalToken(url);
      const file = saveConfigFile({ mode: 'local', local: { url, token } });
      backend = null;
      return { saved_to: file, ...(await getBackend().status()) };
    },
  },
  {
    name: 'configure',
    description: 'Save connection settings to the plugin config file and reconnect. Only pass fields that should change. Environment variables (JOPLIN_*) still take precedence over the file.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['local', 'server'] },
        local_url: str('Joplin desktop Data API URL, e.g. http://127.0.0.1:41184'),
        local_token: str('Joplin desktop Web Clipper API token'),
        server_url: str('Joplin Server base URL, e.g. https://joplin.example.com'),
        server_email: str('Joplin Server account email'),
        server_password: str('Joplin Server account password'),
        server_allow_write: { type: 'boolean', description: 'Allow creating/modifying notes on Joplin Server' },
      },
    },
    run: async (a) => {
      const file = saveConfigFile({
        mode: a.mode,
        local: { url: a.local_url, token: a.local_token },
        server: { url: a.server_url, email: a.server_email, password: a.server_password, allowWrite: a.server_allow_write },
      });
      backend = null;
      let status;
      try { status = await getBackend().status(); } catch (e) { status = { error: e.message }; }
      return { saved_to: file, status };
    },
  },
];

// ---- JSON-RPC plumbing -----------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'joplin', version: VERSION },
        instructions: 'Tools for reading and writing the user\'s Joplin notes. Call status first if unsure whether Joplin is configured.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool ${params?.name}`), { code: -32602 });
      try {
        const out = await tool.run(params.arguments || {});
        return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
      } catch (e) {
        log(`${tool.name} failed:`, e.message);
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined; // notification
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const inFlight = new Set();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  const p = handle(msg).then(
    (result) => { if (msg.id !== undefined && result !== undefined) send({ id: msg.id, result }); },
    (e) => { if (msg.id !== undefined) send({ id: msg.id, error: { code: e.code || -32603, message: e.message } }); },
  ).finally(() => inFlight.delete(p));
  inFlight.add(p);
});
// Finish answering in-flight requests before exiting when the client closes stdin.
rl.on('close', () => Promise.allSettled([...inFlight]).then(() => process.exit(0)));
