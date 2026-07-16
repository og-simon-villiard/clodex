// jira-cli.js — a thin adapter over whichever Jira CLI is installed, so the
// "New session from Jira ticket" flow works regardless of which one the operator
// has. Two grammars are supported:
//
//   acli   — Atlassian's OFFICIAL CLI (acli jira workitem …). Preferred.
//   jira   — ankitpokhrel/jira-cli community tool (jira issue …). Fallback.
//
// Detection prefers acli. Each operation (view / transition / comment) maps to
// the right grammar; both return normalized shapes so the caller never branches
// on which CLI ran. All commands run via execFile (never a shell). No new dep.

const { execFile } = require('child_process');

function run(cmd, args, { timeout = 20000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && err.code, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') });
    });
  });
}

// PATH lookup without a shell — mirrors engine.whichBin semantics enough for a
// presence check (execFile with ENOENT tells us the rest).
const fs = require('fs');
const path = require('path');
function whichBin(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// Which CLI to use: prefer acli (official), else jira (community), else null.
// Cached after first probe (binaries don't appear/vanish mid-session).
let _detected;
function detect() {
  if (_detected !== undefined) return _detected;
  if (whichBin('acli')) _detected = 'acli';
  else if (whichBin('jira')) _detected = 'jira';
  else _detected = null;
  return _detected;
}

// A ticket key looks like ABC-123. Validate before it ever reaches a command
// (defense-in-depth even though execFile doesn't use a shell).
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;
function validKey(k) { return typeof k === 'string' && KEY_RE.test(k.trim()); }

// Normalize a Jira issue (either CLI's JSON) → { key, summary, status, type,
// description }. Both acli and jira --raw emit the standard REST shape
// ({ key, fields: { summary, status.name, issuetype.name, description } }).
function normalizeIssue(json) {
  if (!json || typeof json !== 'object') return null;
  const f = json.fields || {};
  const descToText = (d) => {
    if (typeof d === 'string') return d;
    // Atlassian Document Format → flatten text nodes best-effort.
    if (d && Array.isArray(d.content)) {
      const walk = (n) => (n.text || '') + (Array.isArray(n.content) ? n.content.map(walk).join('') : '');
      return d.content.map(walk).join('\n').trim();
    }
    return '';
  };
  return {
    key: json.key || null,
    summary: f.summary || '',
    status: (f.status && f.status.name) || null,
    type: (f.issuetype && f.issuetype.name) || null,
    description: descToText(f.description),
  };
}

// Fetch a ticket. Returns { ok, cli, issue } | { ok:false, error }.
async function view(key) {
  const cli = detect();
  if (!cli) return { ok: false, error: 'No Jira CLI found (install acli or jira)' };
  if (!validKey(key)) return { ok: false, error: `Invalid ticket key: ${key}` };
  const k = key.trim().toUpperCase();
  const r = cli === 'acli'
    ? await run('acli', ['jira', 'workitem', 'view', k, '--json'])
    : await run('jira', ['issue', 'view', k, '--raw']);
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'ticket fetch failed').trim(), cli };
  let json;
  try { json = JSON.parse(r.stdout); } catch { return { ok: false, error: 'Could not parse Jira CLI output', cli }; }
  // acli search returns an array; view returns the object — accept either.
  const issue = normalizeIssue(Array.isArray(json) ? json[0] : json);
  if (!issue || !issue.key) return { ok: false, error: 'Ticket not found', cli };
  return { ok: true, cli, issue };
}

// Move a ticket to a status (e.g. "In Progress"). --yes/no-input to skip prompts.
async function transition(key, status) {
  const cli = detect();
  if (!cli) return { ok: false, error: 'No Jira CLI found' };
  if (!validKey(key)) return { ok: false, error: `Invalid ticket key: ${key}` };
  if (!status) return { ok: false, error: 'Target status required' };
  const k = key.trim().toUpperCase();
  const r = cli === 'acli'
    ? await run('acli', ['jira', 'workitem', 'transition', '--key', k, '--status', status, '--yes'])
    : await run('jira', ['issue', 'move', k, status]);
  return r.ok ? { ok: true, cli } : { ok: false, error: (r.stderr || r.stdout || 'transition failed').trim(), cli };
}

// Add a comment to a ticket.
async function comment(key, body) {
  const cli = detect();
  if (!cli) return { ok: false, error: 'No Jira CLI found' };
  if (!validKey(key)) return { ok: false, error: `Invalid ticket key: ${key}` };
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'Comment body required' };
  const k = key.trim().toUpperCase();
  const r = cli === 'acli'
    ? await run('acli', ['jira', 'workitem', 'comment', 'create', '--key', k, '--body', text])
    : await run('jira', ['issue', 'comment', 'add', k, text]);
  return r.ok ? { ok: true, cli } : { ok: false, error: (r.stderr || r.stdout || 'comment failed').trim(), cli };
}

module.exports = { detect, view, transition, comment, validKey, normalizeIssue, _whichBin: whichBin };
