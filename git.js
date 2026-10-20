// Thin layer over the `git` command exposed by the Rust backend.
import { invoke } from './platform.js?v=8088795';

const US = '\x1f'; // field separator
const RS = '\x1e'; // record separator

// `input` is written to the standard input of git.
export async function gitRaw(repo, args, input) {
  return invoke('git', { repo, args, input });
}

export async function git(repo, args, input) {
  const r = await gitRaw(repo, args, input);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || '').trim();
    throw new Error(msg || `git ${args[0]} failed (exit code ${r.code})`);
  }
  return r.stdout;
}

export async function repoRoot(path) {
  return (await git(path, ['rev-parse', '--show-toplevel'])).trim();
}

// ---------- status ----------

// Porcelain v2 also tells what changed in each submodule: entries of submodules get
// `submodule: { commit, modified, untracked }` (a new commit checked out, changes to its
// tracked files, untracked files in it).
export async function getStatus(repo) {
  const out = await git(repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
  const parts = out.split('\0');
  const res = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, unborn: false, staged: [], unstaged: [], conflicts: [] };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('# ')) {
      parseBranchLine(p.slice(2), res);
      continue;
    }
    if (p[0] === '?') {
      res.unstaged.push({ path: p.slice(2), status: '?', untracked: true });
      continue;
    }
    // "1 XY sub mH mI mW hH hI path", "2 XY sub mH mI mW hH hI Xscore path\0orig",
    // "u XY sub m1 m2 m3 mW h1 h2 h3 path" (unmerged); "." stands for "unmodified".
    const f = p.split(' ');
    const x = f[1][0] === '.' ? ' ' : f[1][0], y = f[1][1] === '.' ? ' ' : f[1][1];
    if (p[0] === 'u') {
      res.conflicts.push(conflictEntry(f.slice(10).join(' '), x + y));
      continue;
    }
    if (p[0] !== '1' && p[0] !== '2') continue;
    const path = f.slice(p[0] === '1' ? 8 : 9).join(' ');
    const orig = p[0] === '2' ? parts[++i] : null;
    const s = f[2];
    const submodule = s[0] === 'S' ? { commit: s[1] === 'C', modified: s[2] === 'M', untracked: s[3] === 'U' } : null;
    if (x !== ' ') res.staged.push({ path, orig, status: x, submodule });
    if (y !== ' ') res.unstaged.push({ path, status: y, submodule });
  }
  return res;
}

// "# branch.oid <sha>|(initial)", "# branch.head <name>|(detached)",
// "# branch.upstream <name>", "# branch.ab +<ahead> -<behind>"
function parseBranchLine(line, res) {
  const [key, ...rest] = line.split(' ');
  const value = rest.join(' ');
  if (key === 'branch.oid') res.unborn = value === '(initial)';
  else if (key === 'branch.head') {
    if (value === '(detached)') res.detached = true;
    else res.branch = value;
  } else if (key === 'branch.upstream') res.upstream = value;
  else if (key === 'branch.ab') {
    const m = value.match(/^\+(\d+) -(\d+)$/);
    if (m) { res.ahead = +m[1]; res.behind = +m[2]; }
  }
}

// Unmerged paths. "Ours" is the current side (stage 2) and "theirs" the incoming one (stage 3);
// a side is missing when it deleted the file (or never had it).
const CONFLICT_KINDS = {
  UU: 'Both modified', AA: 'Both added', DD: 'Deleted on both sides',
  UD: 'Deleted on the incoming side', DU: 'Deleted on the current side',
  AU: 'Added on the current side', UA: 'Added on the incoming side',
};

function conflictEntry(path, xy) {
  return {
    path, status: 'U', conflict: xy, kind: CONFLICT_KINDS[xy],
    ours: ['UU', 'AA', 'UD', 'AU'].includes(xy),
    theirs: ['UU', 'AA', 'DU', 'UA'].includes(xy),
    content: xy === 'UU' || xy === 'AA', // both sides have the file: it may have conflict markers
  };
}

// ---------- files ----------

// `path` is relative to the repository. readFile resolves to null if the file doesn't exist.
export const readFile = (repo, path) => invoke('read_file', { repo, path });
export const writeFile = (repo, path, content) => invoke('write_file', { repo, path, content });

// Folders of the working tree (explorer mode). Entries are { name, dir, size, modified, created, hidden },
// with times in seconds since the Unix epoch.
export const listDir = (repo, path) => invoke('list_dir', { repo, path });
export const statPath = (repo, path) => invoke('stat_path', { repo, path });
export const walkDir = repo => invoke('walk_dir', { repo });
export const readPreview = (repo, path, max) => invoke('read_preview', { repo, path, max });
export const openPath = (repo, path) => invoke('open_path', { repo, path });

// Files that are tracked, or untracked but not ignored.
export async function listFiles(repo) {
  const out = await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return [...new Set(out.split('\0').filter(Boolean))];
}

// Ignored files and folders; whole ignored folders are listed once, ending with "/".
export async function listIgnored(repo) {
  const r = await gitRaw(repo, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : [];
}

// Files whose content contains `text` (ignoring case), skipping binary files. With `plain`,
// searches a folder that is not a Git repository.
export async function grepFiles(repo, text, plain = false) {
  const r = await gitRaw(repo, ['grep', ...(plain ? ['--no-index'] : ['--untracked']), '-z', '-l', '-I', '-i', '-F', '-e', text]);
  return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : [];
}

// Commits that changed a file or folder ("" for the whole repository), newest first.
// `follow` keeps a file's history across renames.
export async function getPathLog(repo, path, { limit = 100, follow = false } = {}) {
  const fmt = ['%H', '%an', '%ae', '%at', '%s'].join('%x1f') + '%x1e';
  const r = await gitRaw(repo, ['log', ...(follow ? ['--follow'] : []), '-n', String(limit), `--format=${fmt}`, '--', path || '.']);
  if (r.code !== 0) return [];
  return r.stdout.split(RS).map(s => s.replace(/^\n/, '')).filter(Boolean).map(rec => {
    const [sha, author, email, time, subject] = rec.split(US);
    return { sha, author, email, time: +time, subject };
  });
}

// The commit that last changed each line of the working copy of a file:
// { commits: Map(sha -> { sha, author, time, summary }), lines: [{ sha, text }] }.
// Lines changed since the last commit have an all-zero sha.
export async function getBlame(repo, path) {
  const out = await git(repo, ['blame', '--porcelain', '--', path]);
  const commits = new Map(), lines = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line[0] === '\t') {
      lines.push({ sha: cur.sha, text: line.slice(1).replace(/\r$/, '') });
      continue;
    }
    // "<sha> <original line> <final line> [<lines in group>]", then the commit's details the first time
    const m = line.match(/^([0-9a-f]{40,64}) \d+ \d+/);
    if (m) {
      if (!commits.has(m[1])) commits.set(m[1], { sha: m[1], author: '', time: 0, summary: '' });
      cur = commits.get(m[1]);
      continue;
    }
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp), value = line.slice(sp + 1);
    if (key === 'author') cur.author = value;
    else if (key === 'author-time') cur.time = +value;
    else if (key === 'summary') cur.summary = value;
  }
  return { commits, lines };
}

// ---------- operation in progress ----------

// The merge, rebase, cherry-pick or revert that stopped to let the user resolve conflicts
// (or that is waiting to be committed), read from the state files git keeps meanwhile.
// Returns null when there is none.
export async function getOperation(repo) {
  const names = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'MERGE_MSG', 'rebase-merge', 'rebase-apply'];
  const out = await git(repo, ['rev-parse', ...names.flatMap(n => ['--git-path', n])]);
  const p = Object.fromEntries(out.split('\n').map((s, i) => [names[i], s.trim()]));
  const read = path => readFile(repo, path).then(s => (s == null ? null : s.trim()), () => null);
  const [merge, pick, revert, rebaseHead, mergeHead, applyHead] = await Promise.all([
    read(p.MERGE_HEAD), read(p.CHERRY_PICK_HEAD), read(p.REVERT_HEAD), read(p.REBASE_HEAD),
    read(p['rebase-merge'] + '/head-name'), read(p['rebase-apply'] + '/head-name'),
  ]);

  let op = null;
  if (mergeHead != null || applyHead != null) {
    // "rebase-merge" is the default backend, "rebase-apply" the one of `git rebase --apply`
    const dir = mergeHead != null ? p['rebase-merge'] : p['rebase-apply'];
    const [onto, step, total] = await Promise.all(mergeHead != null
      ? [read(dir + '/onto'), read(dir + '/msgnum'), read(dir + '/end')]
      : [read(dir + '/onto'), read(dir + '/next'), read(dir + '/last')]);
    const head = mergeHead ?? applyHead;
    op = { kind: 'rebase', sha: rebaseHead, branch: head.replace(/^refs\/heads\//, ''), onto, step: +step || 0, total: +total || 0 };
  } else if (merge) {
    const message = (await read(p.MERGE_MSG)) || '';
    op = { kind: 'merge', sha: merge.split('\n')[0], message: message.split('\n').filter(l => !l.startsWith('#')).join('\n').trim() };
  } else if (pick) {
    op = { kind: 'cherry-pick', sha: pick };
  } else if (revert) {
    op = { kind: 'revert', sha: revert };
  }
  if (op?.sha) {
    const r = await gitRaw(repo, ['log', '-1', '--format=%s', op.sha]);
    op.subject = r.code === 0 ? r.stdout.trim() : '';
  }
  return op;
}

export async function getMergeTool(repo) {
  const r = await gitRaw(repo, ['config', '--get', 'merge.tool']);
  return (r.code === 0 && r.stdout.trim()) || null;
}

// ---------- submodules ----------

// Submodules declared in .gitmodules, with the state of their checkout:
// 'ok', 'uninitialized', 'changed' (the checked-out commit is not the one recorded here),
// 'conflict' or 'unknown'. Repositories without .gitmodules cost no git call.
export async function getSubmodules(repo) {
  if ((await readFile(repo, '.gitmodules').catch(() => null)) == null) return [];
  const r = await gitRaw(repo, ['config', '-z', '-f', '.gitmodules', '--get-regexp', '^submodule\\.']);
  if (r.code !== 0) return [];
  const byName = new Map();
  for (const entry of r.stdout.split('\0')) {
    const nl = entry.indexOf('\n');
    const m = entry.slice(0, nl).match(/^submodule\.(.*)\.([^.]+)$/);
    if (!m) continue;
    if (!byName.has(m[1])) byName.set(m[1], { name: m[1], path: null, url: '', branch: null, sha: null, state: 'unknown', describe: '' });
    if (['path', 'url', 'branch'].includes(m[2])) byName.get(m[1])[m[2]] = entry.slice(nl + 1);
  }
  const subs = [...byName.values()].filter(s => s.path);
  // " <sha> path (describe)" up to date, "-" not initialized, "+" other commit checked out, "U" conflict
  const st = await gitRaw(repo, ['submodule', 'status']);
  const states = { ' ': 'ok', '-': 'uninitialized', '+': 'changed', U: 'conflict' };
  for (const line of st.code === 0 ? st.stdout.split('\n') : []) {
    const m = line.match(/^([ +\-U])([0-9a-f]+) (.*)$/);
    const s = m && subs.find(x => m[3] === x.path || m[3].startsWith(x.path + ' ('));
    if (!s) continue;
    s.state = states[m[1]];
    s.sha = m[2];
    s.describe = m[3].slice(s.path.length).replace(/^ \((.*)\)$/, '$1');
  }
  return subs.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------- Git LFS ----------

let lfsInstalled = null; // checked once per run
export function hasLfs(repo) {
  lfsInstalled ??= gitRaw(repo, ['lfs', 'version']).then(r => r.code === 0, () => false);
  return lfsInstalled;
}

// The patterns tracked with LFS (from the .gitattributes at the root) and how many LFS files
// of the checkout are only pointers because their content was never downloaded.
export async function getLfs(repo) {
  const [attrs, installed] = await Promise.all([readFile(repo, '.gitattributes').catch(() => null), hasLfs(repo)]);
  const patterns = (attrs || '').split(/\r?\n/)
    .map(l => l.trim().split(/\s+/))
    .filter(([p, ...a]) => p && !p.startsWith('#') && a.includes('filter=lfs'))
    .map(([p]) => p);
  const res = { installed, patterns, files: 0, missing: 0 };
  if (!patterns.length || !installed) return res;
  // "<oid> * path" when the content is here, "<oid> - path" when only the pointer is
  const r = await gitRaw(repo, ['lfs', 'ls-files']);
  for (const line of r.code === 0 ? r.stdout.split('\n') : []) {
    const m = line.match(/^[0-9a-f]+ ([*-]) /);
    if (!m) continue;
    res.files++;
    if (m[1] === '-') res.missing++;
  }
  return res;
}

// ---------- refs ----------

export async function getRefs(repo) {
  const fmt = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)', '%(*objectname)'].join('%1f');
  const out = await git(repo, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
  const remotesOut = await git(repo, ['remote']);
  const remotes = remotesOut.split('\n').map(s => s.trim()).filter(Boolean);
  const res = { local: [], remotes: Object.fromEntries(remotes.map(r => [r, []])), tags: [], remoteNames: remotes };
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, sha, upstream, track, head, peeled] = line.split(US);
    if (ref.startsWith('refs/heads/')) {
      const ahead = +(track.match(/ahead (\d+)/)?.[1] || 0);
      const behind = +(track.match(/behind (\d+)/)?.[1] || 0);
      res.local.push({ name: ref.slice(11), sha, upstream, ahead, behind, gone: track.includes('gone'), current: head === '*' });
    } else if (ref.startsWith('refs/remotes/')) {
      const full = ref.slice(13);
      const slash = full.indexOf('/');
      const remote = full.slice(0, slash), name = full.slice(slash + 1);
      if (name === 'HEAD') continue;
      (res.remotes[remote] ||= []).push({ name, full, sha });
    } else if (ref.startsWith('refs/tags/')) {
      res.tags.push({ name: ref.slice(10), sha: peeled || sha });
    }
  }
  res.tags.reverse();
  return res;
}

export async function getStashes(repo) {
  const r = await gitRaw(repo, ['stash', 'list', `--format=%gd${US}%s${US}%H`]);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map(l => {
    const [ref, subject, sha] = l.split(US);
    return { ref, subject, sha };
  });
}

// ---------- history ----------

export async function getLog(repo, limit = 1500) {
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f') + '%x1e';
  const r = await gitRaw(repo, ['log', '--exclude=refs/stash', '--all', '--date-order', '-n', String(limit), `--format=${fmt}`]);
  if (r.code !== 0) return []; // repository without commits
  return r.stdout.split(RS).map(s => s.replace(/^\n/, '')).filter(Boolean).map(rec => {
    const [sha, parents, author, email, time, refs, subject] = rec.split(US);
    return {
      sha,
      parents: parents ? parents.split(' ') : [],
      author, email,
      time: +time,
      refs: refs ? refs.split(', ') : [],
      subject,
    };
  });
}

export async function getCommit(repo, sha) {
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f');
  const out = await git(repo, ['show', '-s', `--format=${fmt}`, sha]);
  const [h, parents, author, email, time, committer, cemail, ctime, body] = out.split(US);
  return { sha: h, parents: parents ? parents.split(' ') : [], author, email, time: +time, committer, cemail, ctime: +ctime, message: body.trimEnd() };
}

export async function getCommitFiles(repo, sha) {
  const out = await git(repo, ['show', '--format=', '--name-status', '-z', '-M', '--diff-merges=first-parent', sha]);
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].trim();
    if (!s) continue;
    const status = s[0];
    if (status === 'R' || status === 'C') {
      const orig = parts[++i], path = parts[++i];
      files.push({ status, orig, path });
    } else {
      files.push({ status, path: parts[++i] });
    }
  }
  return files;
}

export async function getCommitDiff(repo, sha, file) {
  const paths = file.orig ? [file.orig, file.path] : [file.path];
  return git(repo, ['show', '--format=', '-M', '--submodule=log', '--diff-merges=first-parent', sha, '--', ...paths]);
}

// The prefixes are fixed (whatever diff.noprefix or diff.mnemonicPrefix say) so that parts of
// the diff can be turned into patches for `git apply`.
const PREFIXES = ['--src-prefix=a/', '--dst-prefix=b/'];

export async function getWorkDiff(repo, file, staged) {
  if (file.untracked) {
    const r = await gitRaw(repo, ['diff', ...PREFIXES, '--no-index', '--', '/dev/null', file.path]);
    return r.stdout;
  }
  if (staged) {
    const paths = file.orig ? [file.orig, file.path] : [file.path];
    return git(repo, ['diff', '--cached', ...PREFIXES, '-M', '--submodule=log', '--', ...paths]);
  }
  return git(repo, ['diff', ...PREFIXES, '--submodule=log', '--', file.path]);
}

// Applies a patch made by partialPatch (patch.js) to the index only: staging part of a file,
// or unstaging it with `reverse`.
export const applyToIndex = (repo, patch, reverse = false) =>
  git(repo, ['apply', '--cached', '--whitespace=nowarn', ...(reverse ? ['-R'] : []), '-'], patch);
