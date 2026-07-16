// ticket-providers.js — a pluggable registry of issue-tracker providers, so the
// "new session from a ticket" flow (and the per-session ticket badge) isn't
// hardwired to Jira. Jira is the first provider (backed by jira-cli.js); adding
// Linear / GitHub Issues / Azure DevOps later is a new entry here + a module
// exposing the same shape — no UI or data-model changes.
//
// A provider exposes:
//   id                       'jira' | 'linear' | …  (stored on the session)
//   detect()      → truthy when this provider is usable on this machine
//   view(key)     → { ok, ticket } | { ok:false, error }
//   transition(key, status) → { ok } | { ok:false, error }
//   comment(key, body)      → { ok } | { ok:false, error }
//   ticketUrl(key)          → browsable URL | null   (async)
//   defaultStatus           the "started work" target (e.g. 'In Progress')
//
// A normalized TICKET shape (returned by view, stored/rendered generically):
//   { system, key, summary, status, type, description, url }

const jiraCli = require('./jira-cli');

// --- Jira provider (wraps jira-cli.js: acli | jira community CLI) ----------
const jiraProvider = {
  id: 'jira',
  label: 'Jira',
  defaultStatus: 'In Progress',
  detect() { return jiraCli.detect(); }, // 'acli' | 'jira' | null
  async view(key) {
    const r = await jiraCli.view(key);
    if (!r.ok) return r;
    const url = await jiraCli.ticketUrl(r.issue.key).catch(() => null);
    return { ok: true, cli: r.cli, ticket: { system: 'jira', ...r.issue, url } };
  },
  transition: (key, status) => jiraCli.transition(key, status),
  comment: (key, body) => jiraCli.comment(key, body),
  ticketUrl: (key) => jiraCli.ticketUrl(key),
  branchName(key, summary) {
    const k = String(key || '').trim().toLowerCase();
    const slug = String(summary || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
    return slug ? `${k}-${slug}` : k;
  },
};

// Registry — ordered by preference. Future: push linearProvider, ghProvider, …
const PROVIDERS = [jiraProvider];

function byId(id) { return PROVIDERS.find((p) => p.id === id) || null; }

// The active provider = the first whose detect() is truthy. null when none is
// available (the UI greys the ticket section).
function activeProvider() {
  for (const p of PROVIDERS) { try { if (p.detect()) return p; } catch {} }
  return null;
}

// Which providers are usable right now — [{ id, label, cli }]. Lets the UI show
// a picker if more than one is ever present.
function detect() {
  return PROVIDERS.map((p) => {
    let cli = null;
    try { cli = p.detect(); } catch {}
    return { id: p.id, label: p.label, cli: cli || null, available: !!cli };
  });
}

// Dispatch helpers — default to the active provider, or a named one via `system`.
function resolve(system) { return system ? byId(system) : activeProvider(); }

module.exports = {
  PROVIDERS, byId, activeProvider, detect, resolve, jiraProvider,
};
