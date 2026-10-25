---
name: joplin
description: Work with the user's Joplin notes — search, read, summarise, create, update, tag or organise notes and notebooks. Use when the user mentions Joplin, "my notes", a notebook, or asks to save something (meeting notes, a summary, a snippet, a TODO) to their notes.
---

# Working with Joplin notes

The `joplin` MCP server exposes these tools: `status`, `list_notebooks`, `list_notes`, `search_notes`, `get_note`, `create_note`, `update_note`, `delete_note`, `create_notebook`, `list_tags`, `tag_note`, `configure`, `request_local_token`.

## Getting connected
- If a tool fails with a connection, token or "not configured" error, call `status` and then follow the `/joplin:setup` flow (or suggest the user runs `/joplin:setup`).

## Reading
- Find notes with `search_notes` first; only fall back to `list_notes` for browsing a notebook or "recent notes".
- In **local** mode `search_notes` accepts Joplin's search syntax: `tag:x`, `notebook:x`, `title:x`, `body:x`, `created:20240101`, `updated:day-7`, `type:todo`, `iscompleted:0`, `-word` to exclude, `"exact phrase"`, `any:1` for OR. In **server** mode it is a simple all-words match, so keep queries to a few distinctive words.
- `list_*`/`search_notes` return only ids and titles. Call `get_note` for the body; don't fetch dozens of bodies when a few will do.
- Note bodies are Markdown. Links like `[x](:/<32-char id>)` point to other notes or attachments (resources); attachments themselves are not downloaded.

## Writing
- Notebook arguments accept an id or an exact title. Run `list_notebooks` when unsure where something belongs, and ask the user if it is ambiguous.
- Prefer `update_note` with `append` for adding to an existing note (journals, logs, meeting series) instead of rewriting the whole body.
- `delete_note` moves notes to Joplin's trash. Confirm with the user before deleting or before replacing a note's whole body.
- In **server** mode writes are disabled unless the user enabled them; if a write fails with that message, tell the user how to enable it rather than retrying. Changes appear in Joplin apps after their next sync.
- After creating or changing a note, report its title, notebook and id.
