---
description: Connect Claude Code to Joplin desktop or a Joplin Server (official or self-hosted)
argument-hint: "[local|server]"
---

Help the user connect this plugin to Joplin. Requested mode (may be empty): $ARGUMENTS

1. Call the `status` tool from the joplin MCP server. If it already works, show the result and ask whether they want to change anything.
2. If no mode was given, ask which one they use:
   - **local** — Joplin desktop on this machine (recommended; works with end-to-end encryption and the full Joplin search syntax).
   - **server** — a Joplin Server instance, official or self-hosted (Docker, etc.), reached over HTTP(S) with email + password.

**Local mode**
- Tell the user to open Joplin desktop and enable *Tools > Options > Web Clipper > Enable Web Clipper Service* (macOS: *Joplin > Settings > Web Clipper*).
- The plugin auto-detects the token from Joplin's `settings.json` when Joplin runs on the same machine and user account. If `status` still fails, offer two options:
  a. Call `request_local_token` (optionally with a custom `url`) and tell the user to click **Grant authorisation** in the Joplin window within 2 minutes.
  b. The user copies the token shown in the Web Clipper settings and you call `configure` with `mode: "local"` and `local_token`.
- If Joplin runs elsewhere (another host, a VM, WSL → Windows), note that Joplin only listens on 127.0.0.1, so they need a port forward (e.g. `ssh -L 41184:127.0.0.1:41184 host`) and then set `local_url`.

**Server mode**
- Ask for the server base URL (e.g. `https://joplin.example.com`, the same URL used in Joplin's *Synchronisation* settings) and the account email.
- For the password, recommend setting the `JOPLIN_SERVER_PASSWORD` environment variable before starting Claude Code (so it never appears in the conversation). If they prefer, they may give it to you and you pass it to `configure` — warn that it will then be visible in this conversation and stored in the plugin's config file (permissions 0600).
- Ask whether Claude may create/modify notes on the server (`server_allow_write`, default off). Explain that writes are applied by Joplin clients on their next sync, and that end-to-end-encrypted accounts cannot be used in server mode.
- Call `configure` with `mode: "server"` and the collected values.

3. Finish by calling `status` and summarising: backend, URL, whether auth works, counts, and the config file path. Mention that environment variables (`JOPLIN_*`) override the config file.
