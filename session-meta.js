// session-meta.js — sidebar organizational metadata that isn't on the live
// session record: last-activity timestamp (from the transcript), and the cwd's
// git branch + pull-request state (like Claude Code's own PR awareness). Powers
// group-by / sort-by / filter in the sidebar toolbar.
//
// Two cost tiers, deliberately separated:
//   - Timestamps are a cheap fs.stat of the per-agent transcript symlink target
//     (works for claude AND codex — it's whatever the CLI actually writes), so
//     they're computed synchronously on every meta request.
//   - PR status shells out to `git` + `gh`, which is slow and network-bound, so
//     it's cached per-cwd with a TTL and only refreshed on demand.
//
// Pure except fs reads + the git/gh child processes. REGISTRY_DIR is injected so
// the module stays electron-free and testable (mirrors clodex-paths consumers).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathFor } = require('./clodex-paths');

function createSessionMeta({ REGISTRY_DIR, prTtlMs = 60_000 }) {
  // cwd -> { at, promise|value } PR-status cache. A promise while in flight so
  // concurrent requests for the same repo coalesce onto one git/gh run.
  const prCache = new Map();

  function run(cmd, args, cwd, timeoutMs = 5000) {
    return new Promise((resolve) => {
      execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout || '')));
    });
  }

  // Like run, but distinguishes the failure modes we care about for `gh`:
  //   { code: 'ENOENT' }  — the binary isn't installed / on PATH
  //   { code: <number> }  — ran but exited non-zero (e.g. "no PR for this branch")
  //   { stdout }          — success
  function runDetailed(cmd, args, cwd, timeoutMs = 6000) {
    return new Promise((resolve) => {
      execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (!err) return resolve({ ok: true, stdout: String(stdout || '') });
          resolve({ ok: false, code: err.code, stdout: String(stdout || '') });
        });
    });
  }

  // Last real write to this session's transcript. The run/<name>/transcript.jsonl
  // symlink points at the CLI's live transcript; its target mtime is the last
  // turn and survives GUI restarts. Returns epoch ms or null.
  function lastActivityTs(name) {
    try {
      const link = pathFor(REGISTRY_DIR, name, 'transcript');
      const real = fs.realpathSync(link);
      return fs.statSync(real).mtimeMs;
    } catch {
      return null;
    }
  }

  // git branch + PR state for a cwd. Cached with a TTL. Returns
  // { isRepo, branch, prState: 'open'|'merged'|'closed'|'none'|null, prNumber }.
  // `gh` absent / not authed / offline → prState:null (unknown), never throws.
  async function prStatus(cwd, { force = false } = {}) {
    if (!cwd) return { isRepo: false, branch: null, prState: null, prNumber: null, prUrl: null };
    const now = Date.now();
    const hit = prCache.get(cwd);
    if (!force && hit && (now - hit.at) < prTtlMs) return hit.value;
    // Coalesce concurrent in-flight computes for the same cwd.
    if (!force && hit && hit.promise) return hit.promise;

    const promise = (async () => {
      const branchOut = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      if (branchOut == null) return { isRepo: false, branch: null, prState: null, prNumber: null, prUrl: null };
      const branch = branchOut.trim() || null;
      let prState = null, prNumber = null, prUrl = null;
      // gh pr view on the current branch → JSON {state, number, url}. Distinguish
      // the three outcomes so the UI can bucket correctly:
      //   success        → the PR's state (open|merged|closed) + url (clickable)
      //   ran, exit ≠ 0  → no PR for this branch → 'none' (a real, groupable fact)
      //   ENOENT         → gh not installed → null (unknown; neutral group)
      const gh = await runDetailed('gh', ['pr', 'view', '--json', 'state,number,url'], cwd, 6000);
      if (gh.ok) {
        try {
          const j = JSON.parse(gh.stdout);
          prNumber = j.number || null;
          prUrl = j.url || null;
          prState = j.state ? String(j.state).toLowerCase() : 'none';
        } catch { prState = 'none'; }
      } else if (gh.code === 'ENOENT') {
        prState = null; // gh unavailable — genuinely unknown
      } else {
        prState = 'none'; // gh ran and reported no PR for this branch
      }
      return { isRepo: true, branch, prState, prNumber, prUrl };
    })();

    prCache.set(cwd, { at: now, promise });
    const value = await promise;
    prCache.set(cwd, { at: Date.now(), value });
    return value;
  }

  // Repo + name for a cwd, cached (the "Group: Project" sidebar mode buckets by
  // REPO, not the containing folder — and crucially, WORKTREES fold into their
  // parent repo). A worktree's own --show-toplevel is its own dir, so we key off
  // the COMMON git dir (--git-common-dir), which points at the MAIN repo's .git
  // for every linked worktree; its parent is the canonical repo. Falls back to
  // --show-toplevel for a plain checkout. `repo` is the main-repo path (shared
  // across worktrees → same group); repoName its basename.
  const repoCache = new Map();
  async function repoOf(cwd) {
    if (!cwd) return { repo: null, repoName: null };
    if (repoCache.has(cwd)) return repoCache.get(cwd);
    let repo = null;
    const common = await run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
    const cdir = common && common.trim();
    if (cdir) {
      const base = cdir.replace(/\/+$/, '');
      repo = /(^|\/)\.git$/.test(base) ? base.replace(/\/\.git$/, '') : base.replace(/\.git$/, '');
    }
    if (!repo) {
      const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], cwd);
      repo = top && top.trim();
    }
    const value = repo ? { repo, repoName: repo.split('/').filter(Boolean).pop() || repo } : { repo: null, repoName: null };
    repoCache.set(cwd, value);
    return value;
  }

  // Bulk metadata for a set of sessions [{ name, cwd }]. Timestamps + repo name
  // always; PR status only when includePr (it's the slow tier). Returns
  // { [name]: { lastActivityTs, repo, repoName, branch, prState, prNumber, prUrl } }.
  async function metaFor(sessions, { includePr = true } = {}) {
    const out = {};
    const byCwd = new Set();
    for (const s of sessions) {
      out[s.name] = { lastActivityTs: lastActivityTs(s.name), repo: null, repoName: null, branch: null, prState: null, prNumber: null, prUrl: null };
      if (s.cwd) byCwd.add(s.cwd);
    }
    // Repo name for every distinct cwd (cheap tier, always).
    const repoByCwd = new Map();
    await Promise.all([...byCwd].map(async (cwd) => { repoByCwd.set(cwd, await repoOf(cwd)); }));
    for (const s of sessions) {
      if (!s.cwd) continue;
      const rp = repoByCwd.get(s.cwd);
      if (rp) { out[s.name].repo = rp.repo; out[s.name].repoName = rp.repoName; }
    }
    if (includePr) {
      const prByCwd = new Map();
      await Promise.all([...byCwd].map(async (cwd) => { prByCwd.set(cwd, await prStatus(cwd)); }));
      for (const s of sessions) {
        if (!s.cwd) continue;
        const pr = prByCwd.get(s.cwd);
        if (pr) Object.assign(out[s.name], { branch: pr.branch, prState: pr.prState, prNumber: pr.prNumber, prUrl: pr.prUrl });
      }
    }
    return out;
  }

  return { lastActivityTs, prStatus, repoOf, metaFor, _prCache: prCache };
}

module.exports = { createSessionMeta };
