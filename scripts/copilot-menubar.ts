#!/usr/bin/env bun
/**
 * Copilot CLI Menu Bar Monitor — SwiftBar/xbar plugin helper
 *
 * Reads ~/.copilot/session-state/ to find the latest active session,
 * parses events.jsonl + workspace.yaml, and outputs SwiftBar-formatted text.
 *
 * Usage: bun run scripts/copilot-menubar.ts
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync, mkdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const COPILOT_DIR = join(homedir(), '.copilot');
const SESSION_DIR = join(COPILOT_DIR, 'session-state');
const PIN_FILE = join(COPILOT_DIR, '.comonitor-primary');
const CACHE_DIR = join(COPILOT_DIR, '.comonitor-cache');

const requireSync = createRequire(import.meta.url);
const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_DIR = dirname(MODULE_PATH);

// ── Types ──────────────────────────────────────────────────────────────

interface SessionMeta {
  id: string;
  cwd: string;
  gitRoot: string;
  repository: string;
  branch: string;
  summary: string;
}

interface InstructionFile {
  path: string;   // display path (~ for home, relative for repo)
  label: string;  // short human-readable type label
  scope: 'repo' | 'global';
}

interface ToolStat {
  name: string;
  count: number;
  failed: number;
  lastTs: string;
}

interface RecentTool {
  name: string;
  timestamp: string;
  success: boolean;
  callId: string;
}

interface SubagentInfo {
  callId: string;
  name: string;
  displayName: string;
  startTs: string;
  endTs?: string;
  model?: string;
  totalToolCalls?: number;
  totalTokens?: number;
  durationMs?: number;
}

interface SkillInvocation {
  name: string;
  description: string;
  timestamp: string;
}

interface HookFailure {
  hookType: string;
  ts: string;
  message: string;
}

interface ToolFailure {
  name: string;
  ts: string;
  code: string;
  message: string;
}

interface McpServerStatus {
  state: 'connected' | 'failed';
  ts: string;
  message: string;
}

interface Todo {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  description?: string;
}

interface InboxEntry {
  senderName: string;
  senderType: string;
  summary: string;
  unread: boolean;
  sentAt: number;
}

interface SessionStats {
  meta: SessionMeta;
  model: string;
  reasoningEffort: string;
  startTime: string;
  lastActivity: string;
  isActive: boolean; // has inuse lock
  tools: Map<string, ToolStat>;
  recentTools: RecentTool[];
  totalOutputTokens: number;
  turnCount: { user: number; assistant: number };
  pendingTools: Map<string, { name: string; startTs: string }>;
  activeSubagents: Map<string, SubagentInfo>;
  completedSubagents: SubagentInfo[];
  skills: SkillInvocation[];
  instructionFiles: InstructionFile[];
  hookFailures: HookFailure[];
  mcpStatus: Map<string, McpServerStatus>;
  todos: Todo[];
  inbox: InboxEntry[];
  toolFailures: ToolFailure[];
}

type JsonObject = Record<string, unknown>;

interface CopilotEvent {
  timestamp?: string;
  type?: string;
  data?: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Session Discovery ──────────────────────────────────────────────────

interface SessionEntry { id: string; dir: string; mtime: number; hasLock: boolean }

function findAllSessions(): SessionEntry[] {
  if (!existsSync(SESSION_DIR)) return [];

  const sessions: SessionEntry[] = [];

  for (const entry of readdirSync(SESSION_DIR)) {
    const dir = join(SESSION_DIR, entry);
    if (!statSync(dir).isDirectory()) continue;

    const eventsFile = join(dir, 'events.jsonl');
    if (!existsSync(eventsFile)) continue;

    const mtime = statSync(eventsFile).mtimeMs;
    const hasLock = readdirSync(dir).some(f => f.startsWith('inuse.'));
    sessions.push({ id: entry, dir, mtime, hasLock });
  }

  // Sort: locked sessions first (by recency), then unlocked by recency
  sessions.sort((a, b) => {
    if (a.hasLock !== b.hasLock) return a.hasLock ? -1 : 1;
    return b.mtime - a.mtime;
  });

  return sessions;
}

// ── Instruction File Discovery ─────────────────────────────────────────

// Known instruction file patterns checked relative to gitRoot (and cwd when different).
const INSTRUCTION_CANDIDATES: Array<{ rel: string; label: string }> = [
  { rel: '.github/copilot-instructions.md', label: 'Copilot' },
  { rel: 'AGENTS.md',                       label: 'Agents'  },
  { rel: 'CLAUDE.md',                       label: 'Claude'  },
  { rel: '.cursorrules',                    label: 'Cursor'  },
  { rel: 'copilot-instructions.md',         label: 'Copilot' },
];

// Global (user-level) directories to scan for instruction files.
// Each entry: absolute dir path, label, and file extension filter.
function globalInstructionDirs(): Array<{ dir: string; label: string; exts: string[] }> {
  const home = homedir();
  const vscodeBase = join(home, 'Library', 'Application Support');
  return [
    { dir: join(home, '.copilot', 'instructions'),               label: 'Copilot', exts: ['.md'] },
    { dir: join(home, '.claude', 'rules'),                       label: 'Claude',  exts: ['.md'] },
    { dir: join(home, '.copilot', 'hooks', '.github', 'instructions'), label: 'Copilot', exts: ['.md'] },
    { dir: join(home, '.copilot', 'hooks', '.claude', 'rules'),  label: 'Claude',  exts: ['.md'] },
    { dir: join(vscodeBase, 'Code', 'User', 'prompts'),          label: 'VSCode',  exts: ['.md', '.prompt.md', '.agent.md', '.instructions.md'] },
    { dir: join(vscodeBase, 'Code - Insiders', 'User', 'prompts'), label: 'VSCode', exts: ['.md', '.prompt.md', '.agent.md', '.instructions.md'] },
  ];
}

function scanDir(dir: string, exts: string[], label: string, scope: InstructionFile['scope'], seen: Set<string>, home: string): InstructionFile[] {
  const found: InstructionFile[] = [];
  if (!existsSync(dir)) return found;
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.bak')) continue;
      if (!exts.some(ext => f.endsWith(ext))) continue;
      const full = join(dir, f);
      if (seen.has(full)) continue;
      seen.add(full);
      const display = full.startsWith(home) ? '~' + full.slice(home.length) : full;
      found.push({ path: display, label, scope });
    }
  } catch { /* ignore unreadable dirs */ }
  return found;
}

function findInstructionFiles(gitRoot: string, cwd: string): InstructionFile[] {
  const found: InstructionFile[] = [];
  const seen = new Set<string>();
  const home = homedir();

  const checkFile = (base: string, rel: string, label: string) => {
    if (!base || !existsSync(base)) return;
    const full = join(base, rel);
    if (seen.has(full) || !existsSync(full)) return;
    seen.add(full);
    const display = base === gitRoot ? rel : join(base.replace(gitRoot + '/', ''), rel);
    found.push({ path: display, label, scope: 'repo' });
  };

  // ── Repo-level fixed candidates ──
  for (const { rel, label } of INSTRUCTION_CANDIDATES) {
    checkFile(gitRoot, rel, label);
    if (cwd && cwd !== gitRoot) checkFile(cwd, rel, label);
  }

  // ── Repo-level directory scans ──
  for (const [subDir, label] of [
    ['.github/instructions', 'Copilot'],
    ['.cursor/rules',        'Cursor' ],
  ] as const) {
    const dir = gitRoot ? join(gitRoot, subDir) : '';
    found.push(...scanDir(dir, ['.md', '.mdc', '.instructions.md'], label, 'repo', seen, home));
  }

  // ── Global / user-level directory scans ──
  for (const { dir, label, exts } of globalInstructionDirs()) {
    found.push(...scanDir(dir, exts, label, 'global', seen, home));
  }

  // ── Global / user-level single files ──
  for (const { abs, label } of [
    { abs: join(home, '.copilot', 'copilot-instructions.md'), label: 'Copilot' },
    { abs: join(home, '.claude', 'CLAUDE.md'),                label: 'Claude'  },
  ]) {
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    const display = '~' + abs.slice(home.length);
    found.push({ path: display, label, scope: 'global' });
  }

  return found;
}

// ── Parsing ────────────────────────────────────────────────────────────

function parseWorkspaceYaml(dir: string): SessionMeta {
  const yamlPath = join(dir, 'workspace.yaml');
  const defaults: SessionMeta = { id: '', cwd: '', gitRoot: '', repository: '', branch: '', summary: '' };
  if (!existsSync(yamlPath)) return defaults;

  const text = readFileSync(yamlPath, 'utf-8');
  const get = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m?.[1]?.trim() ?? '';
  };

  return {
    id: get('id'),
    cwd: get('cwd'),
    gitRoot: get('git_root'),
    repository: get('repository'),
    branch: get('branch'),
    summary: get('summary'),
  };
}

function freshStats(meta: SessionMeta, hasLock: boolean): SessionStats {
  return {
    meta,
    model: 'unknown',
    reasoningEffort: '',
    startTime: '',
    lastActivity: '',
    isActive: hasLock,
    tools: new Map(),
    recentTools: [],
    totalOutputTokens: 0,
    turnCount: { user: 0, assistant: 0 },
    pendingTools: new Map(),
    activeSubagents: new Map(),
    completedSubagents: [],
    skills: [],
    instructionFiles: findInstructionFiles(meta.gitRoot, meta.cwd),
    hookFailures: [],
    mcpStatus: new Map(),
    todos: [],
    inbox: [],
    toolFailures: [],
  };
}

// Reads bytes [fromOffset, totalSize) of events.jsonl and folds full lines
// into `stats`/`pendingHooks`. Returns the new offset (advanced only past
// complete, newline-terminated lines so a half-written tail line gets re-read
// on the next tick).
function parseEventsRange(
  eventsFile: string,
  fromOffset: number,
  totalSize: number,
  stats: SessionStats,
  pendingHooks: Map<string, { hookType: string; startTs: string }>,
): number {
  const remaining = totalSize - fromOffset;
  if (remaining <= 0) return fromOffset;

  const fd = openSync(eventsFile, 'r');
  const buf = Buffer.alloc(remaining);
  let read = 0;
  while (read < remaining) {
    const n = readSync(fd, buf, read, remaining - read, fromOffset + read);
    if (n <= 0) break;
    read += n;
  }
  closeSync(fd);

  const text = buf.subarray(0, read).toString('utf-8');
  // Advance only past the last newline so partial trailing line is re-read.
  const lastNl = text.lastIndexOf('\n');
  const consumable = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  const consumedBytes = Buffer.byteLength(consumable, 'utf-8');

  for (const line of consumable.split('\n')) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line) as unknown;
      if (isObject(evt)) processEvent(stats, evt as CopilotEvent, pendingHooks);
    } catch {
      // skip malformed lines
    }
  }

  return fromOffset + consumedBytes;
}

function parseEvents(dir: string): SessionStats {
  const meta = parseWorkspaceYaml(dir);
  const hasLock = readdirSync(dir).some(f => f.startsWith('inuse.'));
  const stats = freshStats(meta, hasLock);

  const eventsFile = join(dir, 'events.jsonl');
  if (!existsSync(eventsFile)) return stats;

  const size = statSync(eventsFile).size;
  const pendingHooks = new Map<string, { hookType: string; startTs: string }>();
  parseEventsRange(eventsFile, 0, size, stats, pendingHooks);
  return stats;
}

// ── Cache layer ────────────────────────────────────────────────────────

const CACHE_VERSION = 4;

interface CacheEntry {
  v: number;
  size: number;
  mtimeMs: number;
  inode: number;
  lastOffset: number;
  stats: SerializedSessionStats;
  pendingHooks: Array<[string, { hookType: string; startTs: string }]>;
  cachedAt: number;
}

type SerializedSessionStats = Omit<SessionStats, 'tools' | 'pendingTools' | 'activeSubagents' | 'mcpStatus'> & {
  tools: Array<[string, ToolStat]>;
  pendingTools: Array<[string, { name: string; startTs: string }]>;
  activeSubagents: Array<[string, SubagentInfo]>;
  mcpStatus: Array<[string, McpServerStatus]>;
};

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
  }
}

function cachePath(sessionId: string): string {
  return join(CACHE_DIR, `${sessionId}.json`);
}

function serializeStats(s: SessionStats): SerializedSessionStats {
  return {
    ...s,
    tools:           Array.from(s.tools.entries()),
    pendingTools:    Array.from(s.pendingTools.entries()),
    activeSubagents: Array.from(s.activeSubagents.entries()),
    mcpStatus:       Array.from(s.mcpStatus.entries()),
  };
}

function deserializeStats(s: Partial<SerializedSessionStats>): SessionStats {
  return {
    ...s,
    meta:             s.meta             ?? { id: '', cwd: '', gitRoot: '', repository: '', branch: '', summary: '' },
    model:            s.model            ?? 'unknown',
    reasoningEffort:  s.reasoningEffort  ?? '',
    startTime:        s.startTime        ?? '',
    lastActivity:     s.lastActivity     ?? '',
    isActive:         s.isActive         ?? false,
    totalOutputTokens: s.totalOutputTokens ?? 0,
    tools:           new Map(s.tools ?? []),
    pendingTools:    new Map(s.pendingTools ?? []),
    activeSubagents: new Map(s.activeSubagents ?? []),
    mcpStatus:       new Map(s.mcpStatus ?? []),
    // Defensive defaults in case schema added fields since cache was written.
    recentTools:        s.recentTools        ?? [],
    completedSubagents: s.completedSubagents ?? [],
    skills:             s.skills             ?? [],
    instructionFiles:   s.instructionFiles   ?? [],
    hookFailures:       s.hookFailures       ?? [],
    todos:              s.todos              ?? [],
    inbox:              s.inbox              ?? [],
    toolFailures:       s.toolFailures       ?? [],
    turnCount:          s.turnCount          ?? { user: 0, assistant: 0 },
  };
}

function readCache(sessionId: string): CacheEntry | null {
  const p = cachePath(sessionId);
  if (!existsSync(p)) return null;
  try {
    const entry = JSON.parse(readFileSync(p, 'utf-8'));
    if (entry?.v !== CACHE_VERSION) return null;
    return entry as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(sessionId: string, entry: CacheEntry): void {
  ensureCacheDir();
  try {
    writeFileSync(cachePath(sessionId), JSON.stringify(entry));
  } catch { /* best-effort, never fail the render */ }
}

// Public entry point: parse a session's events.jsonl, using the on-disk cache
// to avoid re-reading bytes we've already folded into derived stats.
function loadStats(sessionId: string, dir: string): SessionStats {
  const eventsFile = join(dir, 'events.jsonl');
  if (!existsSync(eventsFile)) return parseEvents(dir);

  const st = statSync(eventsFile);
  const cache = readCache(sessionId);

  // Cache valid + file unchanged → reuse verbatim. Most ticks land here for
  // idle "other sessions" — that's where the saved I/O matters.
  if (
    cache &&
    cache.inode === st.ino &&
    cache.size === st.size &&
    cache.mtimeMs === st.mtimeMs
  ) {
    const reused = deserializeStats(cache.stats);
    // Lock state is filesystem-driven, not event-driven; refresh each tick.
    reused.isActive = readdirSync(dir).some(f => f.startsWith('inuse.'));
    return reused;
  }

  // Cache valid + file only grew on same inode → tail-read new bytes.
  if (
    cache &&
    cache.inode === st.ino &&
    st.size > cache.size &&
    cache.lastOffset <= st.size
  ) {
    const stats = deserializeStats(cache.stats);
    const pendingHooks = new Map<string, { hookType: string; startTs: string }>(cache.pendingHooks ?? []);
    const newOffset = parseEventsRange(eventsFile, cache.lastOffset, st.size, stats, pendingHooks);
    stats.isActive = readdirSync(dir).some(f => f.startsWith('inuse.'));
    writeCache(sessionId, {
      v: CACHE_VERSION,
      size: st.size,
      mtimeMs: st.mtimeMs,
      inode: st.ino,
      lastOffset: newOffset,
      stats: serializeStats(stats),
      pendingHooks: Array.from(pendingHooks.entries()),
      cachedAt: Date.now(),
    });
    return stats;
  }

  // Cache missing, stale, or file rotated/shrunk → full reparse.
  const meta = parseWorkspaceYaml(dir);
  const hasLock = readdirSync(dir).some(f => f.startsWith('inuse.'));
  const stats = freshStats(meta, hasLock);
  const pendingHooks = new Map<string, { hookType: string; startTs: string }>();
  const newOffset = parseEventsRange(eventsFile, 0, st.size, stats, pendingHooks);
  writeCache(sessionId, {
    v: CACHE_VERSION,
    size: st.size,
    mtimeMs: st.mtimeMs,
    inode: st.ino,
    lastOffset: newOffset,
    stats: serializeStats(stats),
    pendingHooks: Array.from(pendingHooks.entries()),
    cachedAt: Date.now(),
  });
  return stats;
}

// Best-effort pruning: drop cache entries whose session directory is gone.
// Runs once per tick (cheap: a single readdir of the cache dir).
function pruneCache(liveSessionIds: Set<string>): void {
  if (!existsSync(CACHE_DIR)) return;
  try {
    for (const f of readdirSync(CACHE_DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -'.json'.length);
      if (!liveSessionIds.has(id)) {
        try { unlinkSync(join(CACHE_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function processEvent(stats: SessionStats, evt: CopilotEvent, pendingHooks: Map<string, { hookType: string; startTs: string }>): void {
  const ts = evt.timestamp ?? '';
  const data = evt.data ?? {};
  if (ts) stats.lastActivity = ts;

  switch (evt.type) {
    case 'session.start':
      stats.startTime = typeof data.startTime === 'string' ? data.startTime : ts;
      break;

    case 'session.model_change': {
      const newModel = data.newModel;
      if (typeof newModel === 'string') stats.model = newModel;
      const effort = data.reasoningEffort;
      if (typeof effort === 'string') stats.reasoningEffort = effort;
      break;
    }

    case 'user.message':
      stats.turnCount.user++;
      break;

    case 'assistant.message': {
      stats.turnCount.assistant++;
      if (typeof data.outputTokens === 'number') stats.totalOutputTokens += data.outputTokens;
      // Extract model from tool execution_complete events (more reliable)
      break;
    }

    case 'tool.execution_start': {
      const name = typeof data.toolName === 'string' ? data.toolName : 'unknown';
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
      stats.pendingTools.set(callId, { name, startTs: ts });

      const existing = stats.tools.get(name);
      if (existing) {
        existing.count++;
        existing.lastTs = ts;
      } else {
        stats.tools.set(name, { name, count: 1, failed: 0, lastTs: ts });
      }
      break;
    }

    case 'tool.execution_complete': {
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
      const success = typeof data.success === 'boolean' ? data.success : true;
      const model = data.model;
      if (typeof model === 'string') stats.model = model;

      const pending = stats.pendingTools.get(callId);
      const name = pending?.name ?? 'unknown';
      stats.pendingTools.delete(callId);

      if (!success) {
        const stat = stats.tools.get(name);
        if (stat) stat.failed++;
        const error = isObject(data.error) ? data.error : {};
        const errMsg = String(error.message ?? data.error ?? 'unknown error');
        const errCode = String(error.code ?? '');
        stats.toolFailures.push({ name, ts, code: errCode, message: errMsg });
        if (stats.toolFailures.length > 10) {
          stats.toolFailures = stats.toolFailures.slice(-10);
        }
      }

      stats.recentTools.push({ name, timestamp: ts, success, callId });
      // Keep only last 10
      if (stats.recentTools.length > 10) {
        stats.recentTools = stats.recentTools.slice(-10);
      }
      break;
    }

    case 'skill.invoked': {
      const name = data.name;
      if (typeof name === 'string') {
        stats.skills.push({
          name,
          description: typeof data.description === 'string' ? data.description : '',
          timestamp: ts,
        });
      }
      break;
    }

    case 'subagent.started': {
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
      const agentName = typeof data.agentName === 'string' ? data.agentName : 'unknown';
      const displayName = typeof data.agentDisplayName === 'string' ? data.agentDisplayName : agentName;
      const info: SubagentInfo = {
        callId,
        name: agentName,
        displayName,
        startTs: ts,
      };
      stats.activeSubagents.set(callId, info);
      break;
    }

    case 'subagent.completed': {
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
      const active = stats.activeSubagents.get(callId);
      const completed: SubagentInfo = {
        callId,
        name: typeof data.agentName === 'string' ? data.agentName : active?.name ?? 'unknown',
        displayName: typeof data.agentDisplayName === 'string' ? data.agentDisplayName : active?.displayName ?? 'unknown',
        startTs: active?.startTs ?? ts,
        endTs: ts,
        model: typeof data.model === 'string' ? data.model : undefined,
        totalToolCalls: typeof data.totalToolCalls === 'number' ? data.totalToolCalls : undefined,
        totalTokens: typeof data.totalTokens === 'number' ? data.totalTokens : undefined,
        durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
      };
      stats.activeSubagents.delete(callId);
      stats.completedSubagents.push(completed);
      break;
    }

    case 'hook.start': {
      const id = typeof data.hookInvocationId === 'string' ? data.hookInvocationId : '';
      const hookType = typeof data.hookType === 'string' ? data.hookType : 'unknown';
      if (id) pendingHooks.set(id, { hookType, startTs: ts });
      break;
    }

    case 'hook.end': {
      const id = typeof data.hookInvocationId === 'string' ? data.hookInvocationId : '';
      const success = data.success !== false; // default true if missing
      const pending = pendingHooks.get(id);
      pendingHooks.delete(id);
      if (!success) {
        const error = isObject(data.error) ? data.error : {};
        const msg = error.message ?? 'hook failed';
        stats.hookFailures.push({
          hookType: pending?.hookType ?? (typeof data.hookType === 'string' ? data.hookType : 'unknown'),
          ts,
          message: String(msg).split('\n')[0].slice(0, 200),
        });
        if (stats.hookFailures.length > 5) {
          stats.hookFailures = stats.hookFailures.slice(-5);
        }
      }
      break;
    }

    case 'session.info':
    case 'session.warning': {
      const kind = data.infoType ?? data.warningType;
      if (kind !== 'mcp') break;
      const message = typeof data.message === 'string' ? data.message : '';
      // Messages look like:
      //   "GitHub MCP Server: Connected"
      //   `Failed to connect to MCP server "powerbi-remote". Execute …`
      const failed = evt.type === 'session.warning' || /fail/i.test(message);
      // Extract a server name. Prefer a quoted name; otherwise take the
      // leading "<name>: …" segment up to the first colon.
      let server = '';
      const quoted = message.match(/"([^"]+)"/);
      if (quoted) {
        server = quoted[1];
      } else {
        const colon = message.indexOf(':');
        if (colon > 0) server = message.slice(0, colon).trim();
      }
      if (!server) break;
      stats.mcpStatus.set(server, {
        state: failed ? 'failed' : 'connected',
        ts,
        message: message.slice(0, 200),
      });
      break;
    }
  }
}

// ── Session DB (todos + inbox) ─────────────────────────────────────────

// Best-effort SQLite read of <sessionDir>/session.db. Tries bun:sqlite first
// (the recommended runtime), then node:sqlite (Node ≥ 22 with the experimental
// flag, stable in Node 24). Returns null if neither is available — the rest
// of the UI continues to render without todos/inbox.
type AnyDb = { prepare(sql: string): { all(): unknown[] }; close(): void };

interface TodoRow {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  description?: unknown;
}

interface InboxRow {
  sender_name?: unknown;
  sender_type?: unknown;
  summary?: unknown;
  unread?: unknown;
  sent_at?: unknown;
}

function openSessionDb(dir: string): AnyDb | null {
  const path = join(dir, 'session.db');
  if (!existsSync(path)) return null;

  // Bun's built-in SQLite. {readonly:true} prevents WAL/shm writes.
  try {
    const { Database } = requireSync('bun:sqlite');
    return new Database(path, { readonly: true });
  } catch { /* not on Bun */ }

  // Node 22+ built-in SQLite (experimental until 24). Same prepare/all API.
  try {
    const { DatabaseSync } = requireSync('node:sqlite');
    return new DatabaseSync(path, { readOnly: true });
  } catch { /* not on Node 22+ with sqlite enabled */ }

  return null;
}

function readTodos(db: AnyDb): Todo[] {
  try {
    const rows = db.prepare(
      `SELECT id, title, status, description FROM todos
       ORDER BY CASE status
         WHEN 'in_progress' THEN 0
         WHEN 'pending'     THEN 1
         WHEN 'blocked'     THEN 2
         WHEN 'done'        THEN 3
         ELSE 4
       END, updated_at DESC`
    ).all() as TodoRow[];
    return rows.map((r) => ({
      id: String(r.id ?? ''),
      title: String(r.title ?? ''),
      status: (r.status ?? 'pending') as Todo['status'],
      description: typeof r.description === 'string' ? r.description : undefined,
    }));
  } catch {
    return []; // table may not exist in older session.db files
  }
}

function readInbox(db: AnyDb): InboxEntry[] {
  try {
    const rows = db.prepare(
      `SELECT sender_name, sender_type, summary, unread, sent_at
       FROM inbox_entries ORDER BY sent_at DESC LIMIT 5`
    ).all() as InboxRow[];
    return rows.map((r) => ({
      senderName: String(r.sender_name ?? ''),
      senderType: String(r.sender_type ?? ''),
      summary: String(r.summary ?? ''),
      unread: !!r.unread,
      sentAt: Number(r.sent_at ?? 0),
    }));
  } catch {
    return [];
  }
}

function enrichWithSessionDb(stats: SessionStats, dir: string): void {
  const db = openSessionDb(dir);
  if (!db) return;
  try {
    stats.todos = readTodos(db);
    stats.inbox = readInbox(db);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ── Formatting ─────────────────────────────────────────────────────────

function formatDuration(startIso: string): string {
  const start = new Date(startIso).getTime();
  const now = Date.now();
  const secs = Math.floor((now - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '??:??:??';
  }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatMs(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

// GitHub Invertocat mark — 18x18 black-on-transparent PNG for templateImage
const GITHUB_ICON = 'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAABmJLR0QA/wD/AP+gvaeTAAABbUlEQVQ4jZXTPWtUQRTG8V/uEhBXRBQUWTbFLrZCBBtBsTZYpDIYCPY2wS8gaGcnqI2VnVba2Il+gEhIsoEEzErSJBokCagoi2/Fnasn17tJ9oGBuXOe85+ZM+cOqVYT47iI0/iNdbzBC3zok/dXx/AAvZRcNb7hHg73g7SxvAegPGbRKENOYCUZvhwAUnjmcQSGEugprqX5CI7jDo7iPTK0sInbKW8x+R/hJoziV9jtUL+7B50K/h5aGa6Hk322RxGDavie5sOYgLlAv3sASKH7Ie91Ju+ZQjMDgKK3maEeFrIBQLUwr2f4FBZGBwCdC/NNeO7fXTfkT7+fGtgJeY9hKn10U7CDy6WjFxrGGN7Z3aBXyPtmDUs4j9UU3MLJAGnjq/+7fEGo7Rh+4hnOyH/c6YoTdUuQHi6UTbfkHf4Ql+wuZqG3AfIDNyo8YBLbyfiqIj6bYh9xNQbKBe3gSdptowJ2Fi/lDzQfA38Am7p3Of8VttAAAAAASUVORK5CYII=';

function statusIcon(stats: SessionStats): string {
  const hasProblem = stats.hookFailures.length > 0 || hasFailedMcp(stats);
  if (!stats.isActive) {
    // No inuse lock — check recency of last event
    if (!stats.lastActivity) return '⚪ | size=14';
    const ageSec = (Date.now() - new Date(stats.lastActivity).getTime()) / 1000;
    if (ageSec < 300) return `${hasProblem ? '🟠' : '🟡'} | size=14`; // recently finished
    return '⚪ | size=14';
  }
  // Session has an inuse lock → show GitHub icon, append a warning dot
  // alongside when hooks/MCP servers are in a failed state so the user
  // notices without opening the menu.
  if (hasProblem) return `⚠️ | size=14`;
  return `| templateImage=${GITHUB_ICON}`;
}

function hasFailedMcp(stats: SessionStats): boolean {
  for (const [, s] of stats.mcpStatus) if (s.state === 'failed') return true;
  return false;
}

// ── Output ─────────────────────────────────────────────────────────────

// SwiftBar adaptive colors: color accepts light_color,dark_color format
const CLR = 'color=#1d1d1f,#f5f5f7';        // primary text
const CLR_SUB = 'color=#3a3a3c,#d1d1d6';    // secondary / mono text
const CLR_HEAD = 'color=#000000,#ffffff';    // section headers

function renderNoSession(): void {
  console.log('⚪ | size=14');
  console.log('---');
  console.log(`No active Copilot CLI session | ${CLR}`);
  console.log('---');
  console.log(`Session dir: ${SESSION_DIR} | size=12 ${CLR_SUB}`);
}

function render(stats: SessionStats): void {
  // ── Menu bar line ──
  console.log(statusIcon(stats));
  console.log('---');

  // ── Session info ──
  const repo = stats.meta.repository?.split('/').pop() || (stats.meta.cwd ? basename(stats.meta.cwd) : 'unknown');
  const branch = stats.meta.branch ? ` (${stats.meta.branch})` : '';
  console.log(`📂 ${repo}${branch} | size=13 ${CLR}`);

  if (stats.meta.summary) {
    console.log(`💬 ${stats.meta.summary} | size=12 ${CLR}`);
  }

  const modelShort = stats.model.replace('claude-', '').replace('gpt-', 'GPT ');
  const effort = stats.reasoningEffort ? ` (${stats.reasoningEffort})` : '';
  console.log(`🤖 ${modelShort}${effort} | size=12 ${CLR}`);

  if (stats.startTime) {
    console.log(`⏱ ${formatDuration(stats.startTime)} | size=12 ${CLR}`);
  }

  const sessionDir = join(SESSION_DIR, stats.meta.id);
  console.log(`🔑 ${stats.meta.id.slice(0, 8)}… | size=12 ${CLR}`);

  // ── Stats ──
  const totalCalls = Array.from(stats.tools.values()).reduce((s, t) => s + t.count, 0);
  const totalFailed = Array.from(stats.tools.values()).reduce((s, t) => s + (t.failed ?? 0), 0);
  const subagentTokens = stats.completedSubagents.reduce((s, sa) => s + (sa.totalTokens ?? 0), 0);
  const combinedTokens = stats.totalOutputTokens + subagentTokens;
  console.log('---');
  const failedSuffix = totalFailed > 0 ? ` (${totalFailed} failed)` : '';
  console.log(`🔧 ${totalCalls} tool calls${failedSuffix} | size=12 ${CLR}`);
  console.log(`📊 ${formatNumber(combinedTokens)} tokens${subagentTokens > 0 ? ` (${formatNumber(stats.totalOutputTokens)} out + ${formatNumber(subagentTokens)} subagent)` : ''} | size=12 ${CLR}`);
  console.log(`💬 ${stats.turnCount.user} user / ${stats.turnCount.assistant} assistant turns | size=12 ${CLR}`);

  // ── Recent tool failures ──
  if (stats.toolFailures.length > 0) {
    console.log('---');
    console.log(`❌ Recent tool failures (${stats.toolFailures.length}) | size=13 ${CLR_HEAD}`);
    const recent = stats.toolFailures.slice(-5).reverse();
    for (const f of recent) {
      const timeLabel = new Date(f.ts).toLocaleTimeString();
      const firstLine = String(f.message).split('\n')[0]?.trim() ?? '';
      const shortMsg = truncate(firstLine, 70);
      console.log(`-- ${timeLabel} · 🔧 ${f.name} | size=11 ${CLR_SUB}`);
      console.log(`---- ${shortMsg} | size=11 ${CLR_SUB}`);
    }
  }

  // ── Todos (from session.db) ──
  if (stats.todos.length > 0) {
    const inProgress = stats.todos.filter(t => t.status === 'in_progress');
    const pending    = stats.todos.filter(t => t.status === 'pending');
    const blocked    = stats.todos.filter(t => t.status === 'blocked');
    const done       = stats.todos.filter(t => t.status === 'done');
    console.log('---');
    const parts = [
      inProgress.length ? `${inProgress.length} in-progress` : '',
      pending.length    ? `${pending.length} pending`        : '',
      blocked.length    ? `${blocked.length} blocked`        : '',
      done.length       ? `${done.length} done`              : '',
    ].filter(Boolean).join(' · ');
    console.log(`📝 Todos (${parts}) | size=13 ${CLR_HEAD}`);
    for (const t of inProgress) {
      console.log(`  🔄 ${truncate(t.title, 80)} | size=12 font=Menlo ${CLR_SUB}`);
    }
    for (const t of pending.slice(0, 5)) {
      console.log(`  ⬜ ${truncate(t.title, 80)} | size=12 font=Menlo ${CLR_SUB}`);
    }
    if (pending.length > 5) {
      console.log(`  … and ${pending.length - 5} more pending | size=11 ${CLR_SUB}`);
    }
    for (const t of blocked) {
      const why = t.description ? ` — ${truncate(t.description, 60)}` : '';
      console.log(`  🚫 ${truncate(t.title, 60)}${why} | size=12 font=Menlo ${CLR_SUB}`);
    }
    // Drill-down with everything (including all done items).
    if (stats.todos.length > inProgress.length + Math.min(pending.length, 5) + blocked.length) {
      console.log(`All Todos (${stats.todos.length}) | size=12 ${CLR_SUB}`);
      for (const t of stats.todos) {
        const icon = t.status === 'done' ? '✅'
                   : t.status === 'in_progress' ? '🔄'
                   : t.status === 'blocked' ? '🚫'
                   : '⬜';
        console.log(`--${icon} ${truncate(t.title, 90)} | size=12 font=Menlo ${CLR_SUB}`);
      }
    }
  }

  // ── Subagents ──
  const totalSubagents = stats.activeSubagents.size + stats.completedSubagents.length;
  if (totalSubagents > 0) {
    console.log('---');
    console.log(`🤖 Subagents (${totalSubagents}) | size=13 ${CLR_HEAD}`);

    // Active subagents first
    for (const [, sa] of stats.activeSubagents) {
      const elapsed = formatDuration(sa.startTs);
      console.log(`  🔄 ${sa.displayName} (${elapsed}) | size=12 font=Menlo ${CLR_SUB}`);
    }

    // Completed subagents (most recent first)
    const recent = stats.completedSubagents.slice(-5).reverse();
    for (const sa of recent) {
      const dur = sa.durationMs ? formatMs(sa.durationMs) : '?';
      const tools = sa.totalToolCalls ?? 0;
      const tokens = sa.totalTokens ? formatNumber(sa.totalTokens) : '?';
      console.log(`  ✅ ${sa.displayName} | size=12 font=Menlo ${CLR_SUB}`);
      console.log(`     ${dur} · ${tools} calls · ${tokens} tok | size=11 font=Menlo ${CLR_SUB}`);
    }
    if (stats.completedSubagents.length > 5) {
      console.log(`  … and ${stats.completedSubagents.length - 5} more | size=12 ${CLR_SUB}`);
    }
  }

  // ── Skills ──
  if (stats.skills.length > 0) {
    console.log('---');
    console.log(`📚 Skills (${stats.skills.length}) | size=13 ${CLR_HEAD}`);
    for (const sk of stats.skills) {
      const time = formatTime(sk.timestamp);
      console.log(`  ${time} ${sk.name} | size=12 font=Menlo ${CLR_SUB}`);
    }
  }

  // ── Inbox (from session.db) ──
  if (stats.inbox.length > 0) {
    const unread = stats.inbox.filter(e => e.unread).length;
    console.log('---');
    const tag = unread > 0 ? ` (${unread} unread)` : '';
    console.log(`📬 Inbox${tag} | size=13 ${CLR_HEAD}`);
    for (const e of stats.inbox) {
      const font = e.unread ? 'font=Menlo-Bold' : 'font=Menlo';
      const tagPart = e.senderType ? `[${e.senderType}] ` : '';
      console.log(`  ${tagPart}${e.senderName} — ${truncate(e.summary, 60)} | size=12 ${font} ${CLR_SUB}`);
    }
  }

  // ── Hooks & MCP health ──
  const failedMcp = Array.from(stats.mcpStatus.entries())
    .filter(([, s]) => s.state === 'failed');
  const connectedMcp = Array.from(stats.mcpStatus.entries())
    .filter(([, s]) => s.state === 'connected');
  if (stats.hookFailures.length > 0 || failedMcp.length > 0) {
    console.log('---');
    const parts = [
      stats.hookFailures.length > 0 ? `${stats.hookFailures.length} hook fail` : '',
      failedMcp.length > 0          ? `${failedMcp.length} MCP down`          : '',
    ].filter(Boolean).join(' · ');
    console.log(`🪝 Hooks & MCP (${parts}) | size=13 ${CLR_HEAD}`);
    for (const h of stats.hookFailures.slice(-5).reverse()) {
      console.log(`  ❌ ${formatTime(h.ts)} ${h.hookType} — ${truncate(h.message, 70)} | size=12 font=Menlo ${CLR_SUB}`);
    }
    for (const [name, s] of failedMcp) {
      console.log(`  🔌 ${name}: failed — ${truncate(s.message, 70)} | size=12 font=Menlo ${CLR_SUB}`);
    }
    if (connectedMcp.length > 0) {
      console.log(`MCP servers (${connectedMcp.length} ok) | size=12 ${CLR_SUB}`);
      for (const [name] of connectedMcp) {
        console.log(`--✅ ${name} | size=12 font=Menlo ${CLR_SUB}`);
      }
    }
  }

  // ── Instructions ──
  if (stats.instructionFiles.length > 0) {
    const repo    = stats.instructionFiles.filter(f => f.scope === 'repo');
    const nonVsc  = stats.instructionFiles.filter(f => f.scope === 'global' && f.label !== 'VSCode');
    const vscode  = stats.instructionFiles.filter(f => f.label === 'VSCode');
    const visible = [...repo, ...nonVsc];

    if (visible.length > 0 || vscode.length > 0) {
      console.log('---');
      const parts = [
        repo.length   > 0 ? `${repo.length} repo`   : '',
        nonVsc.length > 0 ? `${nonVsc.length} global` : '',
        vscode.length > 0 ? `${vscode.length} vscode` : '',
      ].filter(Boolean).join(' · ');
      console.log(`📋 Instructions (${parts}) | size=13 ${CLR_HEAD}`);

      for (const f of repo) {
        console.log(`  [${f.label}] ${f.path} | size=12 font=Menlo ${CLR_SUB}`);
      }
      if (repo.length > 0 && nonVsc.length > 0) {
        console.log(`  ─── global ─── | size=11 ${CLR_SUB}`);
      }
      for (const f of nonVsc) {
        console.log(`  [${f.label}] ${f.path} | size=12 font=Menlo ${CLR_SUB}`);
      }

      // VSCode prompts as a drill-down submenu (hidden by default)
      if (vscode.length > 0) {
        console.log(`VSCode Prompts (${vscode.length}) | size=12 ${CLR_SUB}`);
        for (const f of vscode) {
          const name = f.path.split('/').pop() ?? f.path;
          console.log(`--${name} | size=12 font=Menlo ${CLR_SUB}`);
        }
      }
    }
  }

  // // ── Recent Activity ──
  // if (stats.recentTools.length > 0) {
  //   console.log('---');
  //   console.log(`⚡ Recent Activity | size=13 ${CLR_HEAD}`);
  //   const recent = stats.recentTools.slice(-5).reverse();
  //   for (const r of recent) {
  //     if (r.name === 'report_intent') continue;
  //     const icon = r.success ? '✅' : '❌';
  //     const time = formatTime(r.timestamp);
  //     console.log(`  ${time} ${icon} ${r.name} | size=12 font=Menlo ${CLR_SUB}`);
  //   }
  // }

  // ── Currently Running ──
  if (stats.pendingTools.size > 0) {
    console.log('---');
    console.log(`⏳ Running Now | size=13 ${CLR_HEAD}`);
    for (const [, info] of stats.pendingTools) {
      if (info.name === 'report_intent') continue;
      const time = formatTime(info.startTs);
      console.log(`  ${time} 🔄 ${info.name} | size=12 font=Menlo ${CLR_SUB}`);
    }
  }

  // ── Actions ──
  console.log('---');
  console.log(`Open Session Folder | bash="open" param1="${sessionDir}" terminal=false`);
  console.log('Refresh | refresh=true');
}

// ── Pin / Switch Session ───────────────────────────────────────────────

const cmd = process.argv[2];
if (cmd === 'pin' && process.argv[3]) {
  writeFileSync(PIN_FILE, process.argv[3].trim());
  process.exit(0);
}
if (cmd === 'unpin') {
  if (existsSync(PIN_FILE)) unlinkSync(PIN_FILE);
  process.exit(0);
}

function readPinnedId(): string | null {
  if (!existsSync(PIN_FILE)) return null;
  return readFileSync(PIN_FILE, 'utf-8').trim() || null;
}

// ── Main ───────────────────────────────────────────────────────────────

const sessions = findAllSessions();
if (sessions.length === 0) {
  renderNoSession();
} else {
  const pinnedId = readPinnedId();
  let primaryIdx = 0;
  if (pinnedId) {
    const idx = sessions.findIndex(s => s.id === pinnedId);
    if (idx >= 0) primaryIdx = idx;
  }

  const primary = sessions[primaryIdx];
  const stats = loadStats(primary.id, primary.dir);
  enrichWithSessionDb(stats, primary.dir);
  render(stats);
  pruneCache(new Set(sessions.map(s => s.id)));

  const SELF = join(MODULE_DIR, basename(MODULE_PATH));
  const BUN = process.argv[0]; // full path to the runtime that launched us
  if (pinnedId) {
    console.log(`📌 Pinned — Reset to Auto | bash="${BUN}" param1="${SELF}" param2="unpin" terminal=false refresh=true`);
  }

  // ── Other Sessions ──
  const others = sessions.filter((_, i) => i !== primaryIdx).slice(0, 15);
  if (others.length > 0) {
    console.log('---');
    console.log(`Other Sessions (${others.length}) | size=13 ${CLR_HEAD}`);
    for (const s of others) {
      const other = loadStats(s.id, s.dir);
      const repo = other.meta.repository?.split('/').pop() || (other.meta.cwd ? basename(other.meta.cwd) : 'unknown');
      const model = other.model.replace('claude-', '').replace('gpt-', 'GPT ');
      const calls = Array.from(other.tools.values()).reduce((sum, t) => sum + t.count, 0);
      const tokens = formatNumber(other.totalOutputTokens);
      const dot = s.hasLock ? '🟢' : '⚪';
      const timeLabel = other.lastActivity ? `updated ${formatDuration(other.lastActivity)} ago` : '?';
      console.log(`--${dot} ${repo} · ${model} | bash="${BUN}" param1="${SELF}" param2="pin" param3="${s.id}" terminal=false refresh=true size=12 ${CLR}`);
      console.log(`--   ${timeLabel} · 🔧 ${calls} · 📊 ${tokens} tok | size=11 ${CLR_SUB}`);
      if (other.meta.summary) {
        console.log(`--   💬 ${other.meta.summary} | size=11 ${CLR_SUB}`);
      }
    }
  }
}
