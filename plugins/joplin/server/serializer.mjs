// Joplin's sync item format (BaseItem.serialize / unserialize):
//
//   <title>
//
//   <body>
//
//   key: value
//   ...
//   type_: 1
//
// Property values are kept as raw strings so that round-tripping an item
// preserves every field we don't touch.
import crypto from 'node:crypto';

export const TYPE = { NOTE: 1, FOLDER: 2, RESOURCE: 4, TAG: 5, NOTE_TAG: 6 };

export function parseItem(text) {
  const lines = text.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') i--;
  const propLines = [];
  for (; i >= 0; i--) {
    const l = lines[i].trim();
    if (l === '') break;
    propLines.unshift(l);
  }
  const props = new Map();
  for (const l of propLines) {
    const p = l.indexOf(':');
    if (p < 0) throw new Error(`Invalid property line: ${l}`);
    props.set(l.slice(0, p).trim(), l.slice(p + 1).trim());
  }
  if (!props.has('type_')) throw new Error('Item has no type_ property');
  const head = lines.slice(0, Math.max(i, 0));
  return { title: head.length ? head[0] : undefined, body: head.slice(2).join('\n'), props };
}

export function serializeItem({ title, body, props }) {
  const parts = [];
  if (typeof title === 'string') parts.push(title.replace(/[\r\n]+/g, ' '));
  if (body) parts.push(body);
  parts.push([...props].map(([k, v]) => `${k}: ${String(v ?? '').replace(/\r?\n/g, '\\n')}`).join('\n'));
  return parts.join('\n\n');
}

export const newId = () => crypto.randomUUID().replace(/-/g, '');
export const nowIso = () => new Date().toISOString();
export const typeOf = (item) => Number(item.props.get('type_'));

const timestamps = (t) => [
  ['created_time', t], ['updated_time', t], ['user_created_time', t], ['user_updated_time', t],
];

export function newNote({ title, body, parentId, isTodo }) {
  const t = nowIso();
  return {
    title, body: body || '',
    props: new Map([
      ['id', newId()], ['parent_id', parentId], ...timestamps(t).slice(0, 2),
      ['is_conflict', 0], ['latitude', '0.00000000'], ['longitude', '0.00000000'], ['altitude', '0.0000'],
      ['author', ''], ['source_url', ''], ['is_todo', isTodo ? 1 : 0], ['todo_due', 0], ['todo_completed', 0],
      ['source', 'claude-code'], ['source_application', 'net.cozic.joplin-mcp'], ['application_data', ''],
      ['order', 0], ...timestamps(t).slice(2), ['encryption_cipher_text', ''], ['encryption_applied', 0],
      ['markup_language', 1], ['is_shared', 0], ['share_id', ''], ['conflict_original_id', ''],
      ['master_key_id', ''], ['user_data', ''], ['deleted_time', 0], ['type_', TYPE.NOTE],
    ]),
  };
}

export function newFolder({ title, parentId }) {
  const t = nowIso();
  return {
    title, body: '',
    props: new Map([
      ['id', newId()], ...timestamps(t), ['encryption_cipher_text', ''], ['encryption_applied', 0],
      ['parent_id', parentId || ''], ['is_shared', 0], ['share_id', ''], ['master_key_id', ''],
      ['icon', ''], ['user_data', ''], ['deleted_time', 0], ['type_', TYPE.FOLDER],
    ]),
  };
}

export function newTag({ title }) {
  return {
    title, body: '',
    props: new Map([
      ['id', newId()], ...timestamps(nowIso()), ['encryption_cipher_text', ''], ['encryption_applied', 0],
      ['is_shared', 0], ['parent_id', ''], ['user_data', ''], ['type_', TYPE.TAG],
    ]),
  };
}

export function newNoteTag({ noteId, tagId }) {
  return {
    title: undefined, body: '',
    props: new Map([
      ['id', newId()], ['note_id', noteId], ['tag_id', tagId], ...timestamps(nowIso()),
      ['encryption_cipher_text', ''], ['encryption_applied', 0], ['is_shared', 0], ['type_', TYPE.NOTE_TAG],
    ]),
  };
}

export function touch(item) {
  const t = nowIso();
  item.props.set('updated_time', t);
  item.props.set('user_updated_time', t);
}
