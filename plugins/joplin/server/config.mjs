// Configuration loading for the Joplin MCP server.
// Precedence: environment variables > config file > auto-detection.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Empty values and unexpanded placeholders (e.g. "${user_config.x}" from an
// .mcpb host, "${VAR}" from .mcp.json) count as unset.
const env = (k) => {
  const v = process.env[k]?.trim();
  return v && !/^\$\{[^}]*\}$/.test(v) ? v : undefined;
};
const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

const parseBool = (v, dflt) => {
  if (v === undefined) return dflt;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

export function configPath() {
  if (env('JOPLIN_CONFIG')) return env('JOPLIN_CONFIG');
  const base = env('XDG_CONFIG_HOME') || path.join(os.homedir(), '.config');
  return path.join(base, 'joplin-mcp', 'config.json');
}

export function readConfigFile() {
  const p = configPath();
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Cannot parse config file ${p}: ${e.message}`);
  }
}

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a?.[k] || {}, v) : v;
  }
  return out;
}

export function saveConfigFile(patch) {
  const p = configPath();
  const next = merge(readConfigFile(), patch);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* best effort on Windows */ }
  return p;
}

// Joplin desktop stores its Web Clipper token and port in <profile>/settings.json.
function desktopProfileDirs() {
  const h = os.homedir();
  return [
    env('JOPLIN_PROFILE_DIR'),
    path.join(h, '.config', 'joplin-desktop'),
    path.join(h, 'snap', 'joplin-desktop', 'current', '.config', 'joplin-desktop'),
    path.join(h, '.var', 'app', 'net.cozic.joplin_desktop', 'config', 'joplin-desktop'),
  ].filter(Boolean);
}

export function detectDesktopSettings() {
  for (const dir of desktopProfileDirs()) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
      if (s['api.token']) return { token: s['api.token'], port: s['api.port'], profileDir: dir };
    } catch { /* try next */ }
  }
  return null;
}

export function loadConfig() {
  const file = readConfigFile();
  const serverUrl = first(env('JOPLIN_SERVER_URL'), file.server?.url);
  const mode = String(first(env('JOPLIN_MODE'), file.mode) || (serverUrl ? 'server' : 'local')).toLowerCase();

  if (mode === 'server') {
    return {
      mode,
      server: {
        url: serverUrl,
        email: first(env('JOPLIN_SERVER_EMAIL'), file.server?.email),
        password: first(env('JOPLIN_SERVER_PASSWORD'), file.server?.password),
        allowWrite: parseBool(first(env('JOPLIN_SERVER_ALLOW_WRITE'), file.server?.allowWrite), false),
        cache: parseBool(first(env('JOPLIN_SERVER_CACHE'), file.server?.cache), true),
      },
    };
  }
  if (mode !== 'local') throw new Error(`Unknown JOPLIN_MODE "${mode}" (expected "local" or "server").`);

  let url = first(env('JOPLIN_URL'), file.local?.url);
  let token = first(env('JOPLIN_TOKEN'), file.local?.token);
  let tokenSource = token ? 'config' : undefined;
  if (!token || !url) {
    const detected = detectDesktopSettings();
    if (detected) {
      if (!token) { token = detected.token; tokenSource = `auto-detected from ${detected.profileDir}`; }
      if (!url && detected.port) url = `http://127.0.0.1:${detected.port}`;
    }
  }
  return { mode, local: { url: url || 'http://127.0.0.1:41184', token, tokenSource } };
}
