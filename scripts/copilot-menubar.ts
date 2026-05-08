#!/usr/bin/env bun
/**
 * Copilot CLI Menu Bar Monitor — SwiftBar/xbar plugin helper
 *
 * Reads ~/.copilot/session-state/ to find the latest active session,
 * parses events.jsonl + workspace.yaml, and outputs SwiftBar-formatted text.
 *
 * Usage: bun run scripts/copilot-menubar.ts
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const COPILOT_DIR = join(homedir(), '.copilot');
const SESSION_DIR = join(COPILOT_DIR, 'session-state');
const PIN_FILE = join(COPILOT_DIR, '.comonitor-primary');

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

function parseEvents(dir: string): SessionStats {
  const meta = parseWorkspaceYaml(dir);
  const hasLock = readdirSync(dir).some(f => f.startsWith('inuse.'));

  const stats: SessionStats = {
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
  };

  const eventsFile = join(dir, 'events.jsonl');
  if (!existsSync(eventsFile)) return stats;

  const content = readFileSync(eventsFile, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      processEvent(stats, evt);
    } catch {
      // skip malformed lines
    }
  }

  return stats;
}

function processEvent(stats: SessionStats, evt: any): void {
  const ts = evt.timestamp ?? '';
  if (ts) stats.lastActivity = ts;

  switch (evt.type) {
    case 'session.start':
      stats.startTime = evt.data?.startTime ?? ts;
      break;

    case 'session.model_change': {
      const newModel = evt.data?.newModel;
      if (newModel) stats.model = newModel;
      const effort = evt.data?.reasoningEffort;
      if (effort) stats.reasoningEffort = effort;
      break;
    }

    case 'user.message':
      stats.turnCount.user++;
      break;

    case 'assistant.message': {
      stats.turnCount.assistant++;
      const data = evt.data ?? {};
      if (data.outputTokens) stats.totalOutputTokens += data.outputTokens;
      // Extract model from tool execution_complete events (more reliable)
      break;
    }

    case 'tool.execution_start': {
      const name = evt.data?.toolName ?? 'unknown';
      const callId = evt.data?.toolCallId ?? '';
      stats.pendingTools.set(callId, { name, startTs: ts });

      const existing = stats.tools.get(name);
      if (existing) {
        existing.count++;
        existing.lastTs = ts;
      } else {
        stats.tools.set(name, { name, count: 1, lastTs: ts });
      }
      break;
    }

    case 'tool.execution_complete': {
      const callId = evt.data?.toolCallId ?? '';
      const success = evt.data?.success ?? true;
      const model = evt.data?.model;
      if (model) stats.model = model;

      const pending = stats.pendingTools.get(callId);
      const name = pending?.name ?? 'unknown';
      stats.pendingTools.delete(callId);

      stats.recentTools.push({ name, timestamp: ts, success, callId });
      // Keep only last 10
      if (stats.recentTools.length > 10) {
        stats.recentTools = stats.recentTools.slice(-10);
      }
      break;
    }

    case 'skill.invoked': {
      const name = evt.data?.name;
      if (name) {
        stats.skills.push({
          name,
          description: evt.data?.description ?? '',
          timestamp: ts,
        });
      }
      break;
    }

    case 'subagent.started': {
      const callId = evt.data?.toolCallId ?? '';
      const info: SubagentInfo = {
        callId,
        name: evt.data?.agentName ?? 'unknown',
        displayName: evt.data?.agentDisplayName ?? evt.data?.agentName ?? 'unknown',
        startTs: ts,
      };
      stats.activeSubagents.set(callId, info);
      break;
    }

    case 'subagent.completed': {
      const callId = evt.data?.toolCallId ?? '';
      const active = stats.activeSubagents.get(callId);
      const completed: SubagentInfo = {
        callId,
        name: evt.data?.agentName ?? active?.name ?? 'unknown',
        displayName: evt.data?.agentDisplayName ?? active?.displayName ?? 'unknown',
        startTs: active?.startTs ?? ts,
        endTs: ts,
        model: evt.data?.model,
        totalToolCalls: evt.data?.totalToolCalls,
        totalTokens: evt.data?.totalTokens,
        durationMs: evt.data?.durationMs,
      };
      stats.activeSubagents.delete(callId);
      stats.completedSubagents.push(completed);
      break;
    }
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

// GitHub Invertocat mark — 18x18 black-on-transparent PNG for templateImage
const GITHUB_ICON = 'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAABmJLR0QA/wD/AP+gvaeTAAABbUlEQVQ4jZXTPWtUQRTG8V/uEhBXRBQUWTbFLrZCBBtBsTZYpDIYCPY2wS8gaGcnqI2VnVba2Il+gEhIsoEEzErSJBokCagoi2/Fnasn17tJ9oGBuXOe85+ZM+cOqVYT47iI0/iNdbzBC3zok/dXx/AAvZRcNb7hHg73g7SxvAegPGbRKENOYCUZvhwAUnjmcQSGEugprqX5CI7jDo7iPTK0sInbKW8x+R/hJoziV9jtUL+7B50K/h5aGa6Hk322RxGDavie5sOYgLlAv3sASKH7Ie91Ju+ZQjMDgKK3maEeFrIBQLUwr2f4FBZGBwCdC/NNeO7fXTfkT7+fGtgJeY9hKn10U7CDy6WjFxrGGN7Z3aBXyPtmDUs4j9UU3MLJAGnjq/+7fEGo7Rh+4hnOyH/c6YoTdUuQHi6UTbfkHf4Ql+wuZqG3AfIDNyo8YBLbyfiqIj6bYh9xNQbKBe3gSdptowJ2Fi/lDzQfA38Am7p3Of8VttAAAAAASUVORK5CYII=';

function statusIcon(stats: SessionStats): string {
  if (!stats.isActive) {
    // No inuse lock — check recency of last event
    if (!stats.lastActivity) return '⚪ | size=14';
    const ageSec = (Date.now() - new Date(stats.lastActivity).getTime()) / 1000;
    if (ageSec < 300) return '🟡 | size=14'; // recently finished
    return '⚪ | size=14';
  }
  // Session has an inuse lock → show GitHub icon
  return `| templateImage=${GITHUB_ICON}`;
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
  const subagentTokens = stats.completedSubagents.reduce((s, sa) => s + (sa.totalTokens ?? 0), 0);
  const combinedTokens = stats.totalOutputTokens + subagentTokens;
  console.log('---');
  console.log(`🔧 ${totalCalls} tool calls | size=12 ${CLR}`);
  console.log(`📊 ${formatNumber(combinedTokens)} tokens${subagentTokens > 0 ? ` (${formatNumber(stats.totalOutputTokens)} out + ${formatNumber(subagentTokens)} subagent)` : ''} | size=12 ${CLR}`);
  console.log(`💬 ${stats.turnCount.user} user / ${stats.turnCount.assistant} assistant turns | size=12 ${CLR}`);

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
  const stats = parseEvents(primary.dir);
  render(stats);

  const SELF = join(import.meta.dir, basename(import.meta.path));
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
      const other = parseEvents(s.dir);
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
