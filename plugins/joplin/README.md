# Joplin plugin for Claude Code

Lets Claude search, read, create, update, tag and organise your [Joplin](https://joplinapp.org) notes. It connects to either:

| Mode | Connects to | Auth | Best for |
|---|---|---|---|
| `local` (default) | **Joplin desktop** on this machine, via its Data API (Web Clipper service, `http://127.0.0.1:41184`) | API token (auto-detected) | Everyday use. Works with end-to-end encryption and the full Joplin search syntax. |
| `server` | **Joplin Server**: official, or self-hosted (Docker etc.) | Email + password | Headless machines, servers, CI: anywhere Joplin desktop isn't running. |

The plugin includes a zero-dependency MCP server (Node.js ≥ 18). There is nothing to `npm install`.

## Install

```bash
# inside Claude Code
/plugin marketplace add lim0513/joplin-claude-plugin
/plugin install joplin@joplin-tools
```

Then run **`/joplin:setup`** and Claude walks you through the connection.

## Configure

Settings are read in this order: **environment variables → config file → auto-detection**.
Config file: `~/.config/joplin-mcp/config.json` (or `$XDG_CONFIG_HOME/joplin-mcp/config.json`, or `$JOPLIN_CONFIG`). The `configure` and `request_local_token` tools write this file with `0600` permissions.

### Local Joplin desktop

1. In Joplin: *Tools → Options → Web Clipper → Enable Web Clipper Service* (macOS: *Joplin → Settings → Web Clipper*).
2. That's usually it. The token and port are auto-detected from Joplin's `settings.json` (standard, Snap and Flatpak profiles; override with `JOPLIN_PROFILE_DIR`).
3. Otherwise, ask Claude to run `request_local_token` and click **Grant authorisation** in Joplin, or set the token yourself:

```json
{ "mode": "local", "local": { "url": "http://127.0.0.1:41184", "token": "…" } }
```

Joplin only listens on `127.0.0.1`. To reach a Joplin desktop on another host, a VM or Windows-from-WSL, forward the port (`ssh -L 41184:127.0.0.1:41184 host`) or set `local.url`.

### Joplin Server (official or self-hosted)

```json
{
  "mode": "server",
  "server": {
    "url": "https://joplin.example.com",
    "email": "you@example.com",
    "password": "…",
    "allowWrite": false
  }
}
```

Use the same URL as in Joplin's *Synchronisation → Joplin Server* settings. Keeping the password in an environment variable is better than writing it to the file:

| Variable | Meaning |
|---|---|
| `JOPLIN_MODE` | `local` or `server` (inferred as `server` when a server URL is set) |
| `JOPLIN_URL`, `JOPLIN_TOKEN` | Local Data API URL and token |
| `JOPLIN_SERVER_URL`, `JOPLIN_SERVER_EMAIL`, `JOPLIN_SERVER_PASSWORD` | Joplin Server connection |
| `JOPLIN_SERVER_ALLOW_WRITE` | `true` to allow creating/changing notes on the server |
| `JOPLIN_SERVER_CACHE` | `false` to disable the on-disk item cache |
| `JOPLIN_CONFIG`, `JOPLIN_PROFILE_DIR` | Custom config file / Joplin profile directory |

How server mode works: Joplin Server has no note-level REST API. It stores your sync target as one serialized item per note, notebook and tag. The plugin logs in (`/api/sessions`), indexes the items, and reads and writes them in Joplin's sync format. Joplin apps pick up changes on their next sync. Notes to be aware of:

- **Read-only by default.** Enable writes with `allowWrite` / `JOPLIN_SERVER_ALLOW_WRITE=true`. Writes don't take Joplin's sync lock. If a client is editing the same note at the same moment, Joplin keeps both versions as a conflict note and nothing is lost.
- **End-to-end encrypted accounts** can't be read or written in server mode. Use local mode instead.
- Item contents are cached in `~/.cache/joplin-mcp/` (permissions `0600`) so later starts are fast. The first index of a large account takes a while.
- Search is a simple all-words match on title + body. Local mode supports the full Joplin query syntax.
- Joplin Cloud uses the same protocol and may work with `url: https://api.joplincloud.com`, but this is untested.

## Tools

`status`, `list_notebooks`, `list_notes`, `search_notes`, `get_note`, `create_note`, `update_note` (replace or `append`, move), `delete_note` (to trash), `create_notebook`, `list_tags`, `tag_note`, `configure`, `request_local_token`.

Wherever a notebook is expected, you can pass its id or its exact title.

Also included: the `/joplin:setup` command and a `joplin` skill that teaches Claude to search before browsing, to append rather than rewrite, and to confirm before deleting.

## Examples

- "Search my Joplin notes for the Kubernetes upgrade plan and summarise it."
- "Save a summary of this debugging session to my *Work* notebook, tagged `postmortem`."
- "Append today's standup notes to the note *Standups 2026*."

## 中文简介

让 Claude Code 读写你的 Joplin 笔记。支持两种连接方式：

- **本地模式**：连接本机运行的 Joplin 桌面版（需在“选项 → 网页剪辑器”中启用服务，令牌会自动读取）。
- **服务器模式**：连接 Joplin Server，官方或自建（Docker 等）均可，使用邮箱 + 密码登录。默认只读，设置 `allowWrite: true` 后才能写入。开启端到端加密的账号请用本地模式。

安装后运行 `/joplin:setup` 按提示配置即可。

## Development

```bash
cd plugins/joplin && npm test   # e2e tests against mock Joplin desktop + Joplin Server
```
