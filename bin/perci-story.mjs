#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GRAPH_PATH_CANDIDATES = [
  'graphify-out/graph.json',
  'docs/architecture/graphify-out/graph.json',
];

const CONFIG_FILE_NAME = 'perci-story.config.mjs';

const USER_FACING_VERBS = {
  A: 'added',
  C: 'copied',
  D: 'removed',
  M: 'changed',
  R: 'renamed',
  T: 'changed type of',
  U: 'merged',
  X: 'updated',
};

// ── config loading ────────────────────────────────────────────────────────────

async function loadSurfaceRules(cwd, configPath) {
  const target = configPath
    ? resolve(configPath)
    : join(cwd, CONFIG_FILE_NAME);

  if (!existsSync(target)) return [];

  try {
    const mod = await import(pathToFileURL(target).href);
    if (!Array.isArray(mod.surfaces)) {
      console.warn(`perci-story: config at ${target} must export a "surfaces" array — ignoring.`);
      return [];
    }
    return mod.surfaces;
  } catch (error) {
    console.warn(`perci-story: could not load config from ${target}: ${error.message}`);
    return [];
  }
}

// ── entry point ───────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const surfaceRules = await loadSurfaceRules(cwd, options.config);
  const commits = readCommits(cwd, options);
  const graph = loadGraph(resolveGraphPath(cwd, options.graphPath));
  const githubBaseUrl = options.github || detectGitHubBaseUrl(cwd);
  const story = buildStory({ cwd, commits, graph, options, githubBaseUrl, surfaceRules });
  const markdown = renderMarkdown(story);

  if (options.out) {
    writeTextFile(resolve(cwd, options.out), markdown);
  } else {
    process.stdout.write(markdown);
  }

  if (options.json) {
    writeTextFile(resolve(cwd, options.json), `${JSON.stringify(story, null, 2)}\n`);
  }
}

function resolveGraphPath(cwd, explicit) {
  if (explicit) return resolve(cwd, explicit);
  for (const candidate of GRAPH_PATH_CANDIDATES) {
    const full = join(cwd, candidate);
    if (existsSync(full)) return full;
  }
  // Return first candidate — loadGraph will report it as unavailable gracefully.
  return join(cwd, GRAPH_PATH_CANDIDATES[0]);
}

// ── args ──────────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const options = {
    range: null,
    since: null,
    until: null,
    maxCommits: 50,
    out: null,
    json: null,
    github: null,
    graphPath: null,
    config: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      if (index >= args.length) throw new Error(`Missing value for ${arg}`);
      return args[index];
    };

    if (arg === '--range') options.range = next();
    else if (arg === '--since') options.since = next();
    else if (arg === '--until') options.until = next();
    else if (arg === '--max-commits') options.maxCommits = Number(next());
    else if (arg === '--out') options.out = next();
    else if (arg === '--json') options.json = next();
    else if (arg === '--github') options.github = normalizeGitHubUrl(next());
    else if (arg === '--graph') options.graphPath = next();
    else if (arg === '--config') options.config = next();
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.maxCommits) || options.maxCommits < 1) {
    throw new Error('--max-commits must be a positive number');
  }

  return options;
}

function printHelp() {
  process.stdout.write(`story (perci-story)

Build an evidence-backed product story from Git history and an optional Graphify knowledge graph.

Usage:
  story --range v1.0.0..HEAD
  story --since 2026-06-01 --out CHANGES.md --json CHANGES.json
  story --range HEAD~10..HEAD --github https://github.com/owner/repo

Options:
  --range <rev-range>     Git revision range, e.g. v1.0.0..HEAD.
  --since <date>          Include commits since a date (ISO 8601 or natural).
  --until <date>          Include commits until a date.
  --max-commits <number>  Limit commits when --range is omitted. Default: 50.
  --out <path>            Write Markdown output to a file. Defaults to stdout.
  --json <path>           Write structured story JSON to a file.
  --github <url>          GitHub repo URL for commit and compare links.
  --graph <path>          Path to a Graphify graph.json. Auto-detected if omitted.
  --config <path>         Path to a perci-story.config.mjs surface config file.

Config file:
  Place a perci-story.config.mjs in your project root to define custom surfaces.
  The file must export a "surfaces" array:

    export const surfaces = [
      { id: 'auth',    title: 'Authentication',  match: f => f.includes('/auth/') },
      { id: 'api',     title: 'API layer',        match: f => f.startsWith('src/api/') },
    ];

  Without a config file, story falls back to path-based classification
  (src/components/, src/lib/, src/context/, electron/, test/, etc.).
`);
}

// ── git ───────────────────────────────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 50,
  }).trimEnd();
}

function readCommits(cwd, options) {
  const args = [
    'log',
    '--reverse',
    '--date=iso-strict',
    '--pretty=format:%H%x1f%h%x1f%ad%x1f%an%x1f%s%x1e',
  ];
  if (options.since) args.push(`--since=${options.since}`);
  if (options.until) args.push(`--until=${options.until}`);
  if (!options.range) args.push(`--max-count=${options.maxCommits}`);
  if (options.range) args.push(options.range);

  const raw = git(cwd, args);
  if (!raw) return [];

  return raw
    .split('\x1e')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [sha, shortSha, date, author, subject] = entry.split('\x1f');
      const files = readCommitFiles(cwd, sha);
      return {
        sha,
        shortSha,
        date,
        author,
        subject,
        files,
        totals: summarizeFiles(files),
        surfaces: summarizeSurfaces(files),
      };
    });
}

function readCommitFiles(cwd, sha) {
  const statusRows = git(cwd, ['show', '--format=', '--name-status', '--find-renames', '--no-ext-diff', sha])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseNameStatus);
  const numstat = new Map(
    git(cwd, ['show', '--format=', '--numstat', '--no-ext-diff', sha])
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(parseNumstat)
      .map(row => [row.path, row])
  );

  return statusRows.map(row => {
    const stats = numstat.get(row.path) || numstat.get(row.oldPath) || { additions: 0, deletions: 0, binary: true };
    const content = readFileAtCommit(cwd, sha, row.path);
    const addedLines = readAddedLines(cwd, sha, row.path);
    return {
      ...row,
      additions: stats.additions,
      deletions: stats.deletions,
      binary: stats.binary,
      surfaces: classifyFile(row.path),
      observations: extractFileObservations({ ...row, additions: stats.additions, deletions: stats.deletions, binary: stats.binary }, content, addedLines),
    };
  });
}

function readFileAtCommit(cwd, sha, path) {
  try {
    return git(cwd, ['show', `${sha}:${path}`]);
  } catch {
    return '';
  }
}

function readAddedLines(cwd, sha, path) {
  try {
    return git(cwd, ['show', '--format=', '--unified=0', '--no-ext-diff', sha, '--', path])
      .split('\n')
      .filter(line => line.startsWith('+') && !line.startsWith('+++'))
      .map(line => line.slice(1));
  } catch {
    return [];
  }
}

// ── surface classification ────────────────────────────────────────────────────

// surfaceRules is passed through from config; this module-level ref is set
// in main() before any classification runs.
let _surfaceRules = [];

function classifyFile(file) {
  // User-defined surface rules take priority.
  const surfaces = _surfaceRules.filter(rule => rule.match(file)).map(({ id, title }) => ({ id, title }));
  if (surfaces.length > 0) return surfaces;

  // Generic fallback classification.
  const modeMatch = file.match(/^src\/components\/(.+Mode)\.[jt]sx?$/);
  if (modeMatch) {
    return [{ id: `mode-${slugify(modeMatch[1])}`, title: `${splitWords(modeMatch[1])} surface` }];
  }

  if (file.startsWith('src/components/')) return [{ id: 'components', title: 'Renderer components' }];
  if (file.startsWith('src/lib/')) return [{ id: 'libraries', title: 'Shared renderer libraries' }];
  if (file.startsWith('src/context/')) return [{ id: 'context', title: 'React contexts and state' }];
  if (file.startsWith('src/hooks/')) return [{ id: 'hooks', title: 'React hooks' }];
  if (file.startsWith('src/')) return [{ id: 'renderer', title: 'Renderer application' }];
  if (file.startsWith('electron/') || file.endsWith('.cjs')) return [{ id: 'desktop-bridge', title: 'Desktop bridge and IPC' }];
  if (file.startsWith('test/') || /\.test\.[cm]?[jt]sx?$/.test(file)) return [{ id: 'tests', title: 'Tests and validation harnesses' }];
  if (file.endsWith('.css')) return [{ id: 'assets-style', title: 'Visual assets and styling' }];
  if (file.startsWith('src/assets/')) return [{ id: 'assets-style', title: 'Visual assets and styling' }];
  if (file.startsWith('docs/') || ['CHANGELOG.md', 'HANDOFF.md', 'README.md', 'package.json'].includes(file)) {
    return [{ id: 'docs-release', title: 'Docs and release notes' }];
  }
  if (file.startsWith('.github/')) return [{ id: 'github-automation', title: 'GitHub automation' }];
  return [{ id: 'repo-maintenance', title: 'Repository maintenance' }];
}

// ── observations ──────────────────────────────────────────────────────────────

function extractFileObservations(file, content, addedLines) {
  const observations = [];
  const add = (kind, label, detail = '', evidence = file.path) => {
    const key = `${kind}:${label}:${detail}`;
    if (observations.some(item => `${item.kind}:${item.label}:${item.detail}` === key)) return;
    observations.push({ kind, label, detail, evidence });
  };

  const path = file.path;
  const addedText = addedLines.join('\n');
  const isSourceCode = /\.(jsx?|tsx?)$/.test(path);
  const isSharedSource = /^src\/(lib|context|hooks|utils)\//.test(path);
  const isTestFile = path.startsWith('test/') || /\.test\.[cm]?[jt]sx?$/.test(path);
  const semanticText = file.status === 'A' ? content : addedText;

  if (file.status === 'A') {
    const modeMatch = path.match(/^src\/components\/(.+Mode)\.[jt]sx?$/);
    if (modeMatch) {
      add('surface', `Added ${splitWords(modeMatch[1])}`, 'New first-class mode component file.');
    }

    const testMatch = path.match(/^test\/(.+)\.test\.[cm]?[jt]sx?$/);
    if (testMatch) {
      add('validation', `Added ${testMatch[1]} tests`, 'New focused test coverage.');
    }
  }

  if (isSourceCode) {
    for (const name of extractMatches(semanticText, /export default function\s+([A-Z][A-Za-z0-9_]*)/g)) {
      add('component', `Exports ${name}`, 'React component export detected.');
    }
    for (const name of extractMatches(semanticText, /function\s+([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
      add('component', `Defines ${name}`, 'React component/function detected.');
    }
  }

  if (isSharedSource) {
    for (const name of extractMatches(semanticText, /export function\s+([a-zA-Z][A-Za-z0-9_]*)\s*\(/g)) {
      add('api', `Exports ${name}()`, 'Shared library API export detected.');
    }
    for (const name of extractMatches(semanticText, /export const\s+([A-Z][A-Z0-9_]*)\s*=/g)) {
      add('api', `Exports ${name}`, 'Shared library constant export detected.');
    }
  }

  // IPC handler detection (Electron or similar).
  for (const channel of extractMatches(addedText, /ipcMain\.handle\(['"`]([^'"`]+)['"`]/g)) {
    add('ipc', `Handles ${channel}`, 'Main-process IPC handler added.');
  }
  for (const channel of extractMatches(addedText, /ipcRenderer\.invoke\(['"`]([^'"`]+)['"`]/g)) {
    add('ipc', `Invokes ${channel}`, 'Renderer IPC invoke path added.');
  }

  // Storage key detection.
  for (const key of extractStorageKeys(addedText)) {
    add('storage', `Persists ${key}`, 'Persistent storage key appears in added lines.');
  }

  if (isTestFile && (/describe\(['"`]/.test(content) || /it\(['"`]/.test(content) || /test\(['"`]/.test(content))) {
    const testNames = [...extractMatches(content, /(?:it|test)\(['"`]([^'"`]+)['"`]/g)].slice(0, 4);
    if (testNames.length > 0) {
      add('validation', 'Adds executable assertions', testNames.join('; '));
    }
  }

  if (path.endsWith('.css')) {
    const selectors = extractMatches(addedText, /\.([a-z][a-z0-9_-]+)\b/g).slice(0, 6);
    if (selectors.length > 0) {
      add('style', 'Adds visual styling hooks', selectors.map(s => `.${s}`).join(', '));
    }
  }

  if (path.startsWith('src/assets/')) {
    add('asset', `Adds ${path.split('/').pop()}`, 'Visual asset included in the product surface.');
  }

  return observations.slice(0, 16);
}

function extractMatches(value, regex) {
  if (!value) return [];
  return [...value.matchAll(regex)]
    .map(m => m[1])
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);
}

function extractStorageKeys(value) {
  const keys = new Set();
  const regexes = [
    /(?:readStringStorage|writeStringStorage|readJsonStorage|writeJsonStorage|removeStorageKey)\(['"`]([^'"`]+)['"`]/g,
    /\b([A-Z][A-Z0-9_]+_KEY)\s*=\s*['"`]([^'"`]+)['"`]/g,
  ];
  for (const key of extractMatches(value, regexes[0])) keys.add(key);
  for (const match of value.matchAll(regexes[1])) keys.add(match[2]);
  return [...keys].sort();
}

// ── parse git output ──────────────────────────────────────────────────────────

function parseNameStatus(line) {
  const parts = line.split('\t');
  const rawStatus = parts[0] || 'X';
  const status = rawStatus[0];

  if (status === 'R' || status === 'C') {
    return { status, statusLabel: USER_FACING_VERBS[status] || 'changed', path: parts[2], oldPath: parts[1] };
  }
  return { status, statusLabel: USER_FACING_VERBS[status] || 'changed', path: parts[1] || parts[0], oldPath: null };
}

function parseNumstat(line) {
  const [added, deleted, ...pathParts] = line.split('\t');
  const path = pathParts.join('\t');
  const binary = added === '-' || deleted === '-';
  return { path, additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary };
}

// ── summary helpers ───────────────────────────────────────────────────────────

function summarizeFiles(files) {
  return files.reduce((acc, file) => {
    acc.files += 1;
    acc.additions += file.additions || 0;
    acc.deletions += file.deletions || 0;
    acc.binary += file.binary ? 1 : 0;
    acc.statuses[file.status] = (acc.statuses[file.status] || 0) + 1;
    return acc;
  }, { files: 0, additions: 0, deletions: 0, binary: 0, statuses: {} });
}

function summarizeSurfaces(files) {
  const map = new Map();
  for (const file of files) {
    for (const surface of file.surfaces) {
      const current = map.get(surface.id) || { id: surface.id, title: surface.title, files: 0, additions: 0, deletions: 0 };
      current.files += 1;
      current.additions += file.additions || 0;
      current.deletions += file.deletions || 0;
      map.set(surface.id, current);
    }
  }
  return [...map.values()].sort(sortSurfaceSummary);
}

// ── graph ─────────────────────────────────────────────────────────────────────

function loadGraph(path) {
  const manifestPath = join(dirname(path), 'manifest.json');

  if (!existsSync(path)) {
    return { available: false, path, manifestPath, files: new Map(), nodeCount: 0, linkCount: 0, reason: 'Graphify graph not found' };
  }

  try {
    const graph = JSON.parse(readFileSync(path, 'utf8'));
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const links = Array.isArray(graph.links) ? graph.links : [];
    const files = new Map();

    for (const node of nodes) {
      const graphFiles = new Set([
        normalizeGraphSourceFile(node.source_file),
        normalizeGraphSourceFile(pathLikeLabel(node.label)),
      ].filter(Boolean));

      for (const sourceFile of graphFiles) {
        const current = files.get(sourceFile) || {
          path: sourceFile,
          nodeCount: 0,
          communities: new Set(),
          labels: [],
          fromManifest: false,
        };
        current.nodeCount += 1;
        if (Number.isInteger(node.community)) current.communities.add(node.community);
        if (typeof node.label === 'string' && current.labels.length < 8) current.labels.push(node.label);
        files.set(sourceFile, current);
      }
    }

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const key of Object.keys(manifest)) {
        const sourceFile = normalizeGraphSourceFile(key);
        const current = files.get(sourceFile) || {
          path: sourceFile,
          nodeCount: 0,
          communities: new Set(),
          labels: [],
          fromManifest: true,
        };
        current.fromManifest = true;
        if (!current.labels.includes(sourceFile)) current.labels.unshift(sourceFile);
        files.set(sourceFile, current);
      }
    }

    return { available: true, path, manifestPath, files, nodeCount: nodes.length, linkCount: links.length };
  } catch (error) {
    return { available: false, path, manifestPath, files: new Map(), nodeCount: 0, linkCount: 0, reason: error.message };
  }
}

// ── story building ────────────────────────────────────────────────────────────

function buildStory({ cwd, commits, graph, options, githubBaseUrl, surfaceRules }) {
  _surfaceRules = surfaceRules;
  const episodes = buildEpisodes(commits, graph);
  const range = options.range || describeDateRange(options);
  const graphCoverage = summarizeGraphCoverage(commits, graph);

  return {
    generatedAt: new Date().toISOString(),
    repo: relative(process.cwd(), cwd) || cwd,
    range,
    githubBaseUrl,
    compareUrl: buildCompareUrl(githubBaseUrl, range),
    graph: {
      available: graph.available,
      path: graph.path,
      manifestPath: graph.manifestPath,
      nodeCount: graph.nodeCount,
      linkCount: graph.linkCount,
      reason: graph.reason || null,
      coverage: graphCoverage,
    },
    totals: summarizeCommits(commits),
    commits,
    episodes,
  };
}

function summarizeGraphCoverage(commits, graph) {
  const changedSourceFiles = new Set();
  const matchedSourceFiles = new Set();

  for (const commit of commits) {
    for (const file of commit.files) {
      if (!/\.(jsx?|tsx?)$/.test(file.path)) continue;
      changedSourceFiles.add(file.path);
      if (lookupGraphFile(graph, file.path)) matchedSourceFiles.add(file.path);
    }
  }

  return {
    changedRendererFiles: changedSourceFiles.size,
    matchedRendererFiles: matchedSourceFiles.size,
    unmatchedRendererFiles: changedSourceFiles.size - matchedSourceFiles.size,
    unmatchedSamples: [...changedSourceFiles]
      .filter(f => !matchedSourceFiles.has(f))
      .sort()
      .slice(0, 12),
  };
}

function buildEpisodes(commits, graph) {
  const bySurface = new Map();

  for (const commit of commits) {
    for (const file of commit.files) {
      for (const surface of file.surfaces) {
        const episode = bySurface.get(surface.id) || {
          id: surface.id,
          title: surface.title,
          commits: new Map(),
          files: new Map(),
          additions: 0,
          deletions: 0,
          graphFiles: new Map(),
          observations: new Map(),
        };

        episode.commits.set(commit.sha, { sha: commit.sha, shortSha: commit.shortSha, date: commit.date, subject: commit.subject });

        const fileEntry = episode.files.get(file.path) || { path: file.path, statuses: new Set(), additions: 0, deletions: 0, observations: [] };
        fileEntry.statuses.add(file.status);
        fileEntry.additions += file.additions || 0;
        fileEntry.deletions += file.deletions || 0;
        fileEntry.observations.push(...file.observations);
        episode.files.set(file.path, fileEntry);
        episode.additions += file.additions || 0;
        episode.deletions += file.deletions || 0;

        for (const observation of file.observations) {
          const key = `${observation.kind}:${observation.label}:${observation.detail}`;
          const current = episode.observations.get(key) || { ...observation, files: new Set(), commits: new Set() };
          current.files.add(file.path);
          current.commits.add(commit.sha);
          episode.observations.set(key, current);
        }

        const graphInfo = lookupGraphFile(graph, file.path);
        if (graphInfo) episode.graphFiles.set(file.path, graphInfo);
        bySurface.set(surface.id, episode);
      }
    }
  }

  return [...bySurface.values()]
    .map(finalizeEpisode)
    .sort((a, b) => {
      const weight = (b.filesChanged + b.commits.length + b.additions + b.deletions) - (a.filesChanged + a.commits.length + a.additions + a.deletions);
      return weight || a.title.localeCompare(b.title);
    });
}

function finalizeEpisode(episode) {
  const files = [...episode.files.values()]
    .map(file => ({
      ...file,
      statuses: [...file.statuses].sort(),
      observations: dedupeObservations(file.observations).slice(0, 6),
      changeWeight: file.additions + file.deletions,
    }))
    .sort((a, b) => b.changeWeight - a.changeWeight || a.path.localeCompare(b.path));

  const graphFiles = [...episode.graphFiles.values()];
  const communities = [...new Set(graphFiles.flatMap(info => [...info.communities]))].sort((a, b) => a - b);
  const observations = [...episode.observations.values()]
    .map(obs => ({ kind: obs.kind, label: obs.label, detail: obs.detail, evidence: obs.evidence, fileCount: obs.files.size, commitCount: obs.commits.size }))
    .sort(sortObservations)
    .slice(0, 14);

  return {
    id: episode.id,
    title: episode.title,
    summary: summarizeEpisodeIntent(episode.title, files, graphFiles, observations),
    commits: [...episode.commits.values()],
    files: files.slice(0, 20),
    observations,
    filesChanged: episode.files.size,
    additions: episode.additions,
    deletions: episode.deletions,
    graph: {
      filesMatched: graphFiles.length,
      communities,
      symbols: graphFiles.flatMap(info => info.labels.slice(0, 3)).slice(0, 12),
      nodeCount: graphFiles.reduce((sum, info) => sum + info.nodeCount, 0),
    },
    confidence: graphFiles.length > 0 || files.length <= 4 ? 'high' : 'medium',
  };
}

function summarizeEpisodeIntent(title, files, graphFiles, observations) {
  const addedFiles = files.filter(f => f.statuses.includes('A')).length;
  const changedFiles = files.filter(f => f.statuses.includes('M')).length;
  const removedFiles = files.filter(f => f.statuses.includes('D')).length;
  const renamedFiles = files.filter(f => f.statuses.includes('R')).length;
  const graphPhrase = graphFiles.length > 0
    ? ` Graphify matched ${graphFiles.length} changed file${graphFiles.length === 1 ? '' : 's'}, so this is tied to indexed architecture.`
    : '';
  const verbs = [];
  if (addedFiles) verbs.push(`${addedFiles} added`);
  if (changedFiles) verbs.push(`${changedFiles} changed`);
  if (renamedFiles) verbs.push(`${renamedFiles} renamed`);
  if (removedFiles) verbs.push(`${removedFiles} removed`);
  const observationPhrase = observations.length > 0
    ? ` Detected signals include ${observations.slice(0, 3).map(o => o.label).join(', ')}.`
    : '';
  return `${title} touched ${verbs.join(', ') || `${files.length} changed`} file${files.length === 1 ? '' : 's'}.${graphPhrase}${observationPhrase}`;
}

function dedupeObservations(observations) {
  const seen = new Set();
  return observations.filter(obs => {
    const key = `${obs.kind}:${obs.label}:${obs.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortObservations(a, b) {
  const priority = { surface: 0, 'mode-routing': 1, ipc: 2, api: 3, component: 4, storage: 5, validation: 6, asset: 7, style: 8 };
  return (priority[a.kind] ?? 99) - (priority[b.kind] ?? 99)
    || b.fileCount - a.fileCount
    || a.label.localeCompare(b.label);
}

function lookupGraphFile(graph, repoPath) {
  if (!graph.available) return null;
  const normalized = normalizeGraphSourceFile(repoPath);
  return graph.files.get(normalized) || graph.files.get(normalized.replace(/^src\//, '')) || null;
}

function normalizeGraphSourceFile(file) {
  if (!file || typeof file !== 'string') return '';
  return file.replace(/^\.\//, '').replace(/^src\//, '');
}

function pathLikeLabel(label) {
  if (typeof label !== 'string') return '';
  if (!/\.(jsx?|tsx?|css|json|md|cjs|mjs)$/.test(label)) return '';
  return label;
}

function summarizeCommits(commits) {
  return commits.reduce((acc, commit) => {
    acc.commits += 1;
    acc.files += commit.totals.files;
    acc.additions += commit.totals.additions;
    acc.deletions += commit.totals.deletions;
    acc.binary += commit.totals.binary;
    return acc;
  }, { commits: 0, files: 0, additions: 0, deletions: 0, binary: 0 });
}

// ── markdown rendering ────────────────────────────────────────────────────────

function renderMarkdown(story) {
  const lines = [];
  const titleRange = story.range ? ` (${story.range})` : '';
  lines.push(`# Change Story${titleRange}`);
  lines.push('');
  lines.push(`Generated: ${story.generatedAt}`);
  lines.push('');
  lines.push(`Analyzed ${story.totals.commits} commit${story.totals.commits === 1 ? '' : 's'}, ${story.totals.files} changed file entries, ${story.totals.additions} additions, and ${story.totals.deletions} deletions.`);
  if (story.compareUrl) {
    lines.push(`GitHub compare: ${story.compareUrl}`);
  }
  if (story.graph.available) {
    lines.push(`Graphify context: ${story.graph.nodeCount} nodes and ${story.graph.linkCount} links from \`${story.graph.path}\`.`);
    lines.push(`Graphify coverage: ${story.graph.coverage.matchedRendererFiles}/${story.graph.coverage.changedRendererFiles} changed source files matched the local index.`);
    if (story.graph.coverage.unmatchedRendererFiles > 0) {
      lines.push(`Graphify refresh recommended: ${story.graph.coverage.unmatchedRendererFiles} changed source files were not in the current index. Run \`graphify update\` for a sharper architectural story.`);
    }
  } else {
    lines.push(`Graphify context: unavailable (${story.graph.reason || 'not found'}). Story is based on Git/path evidence only.`);
  }
  lines.push('');

  if (story.episodes.length === 0) {
    lines.push('No commits matched the requested range.');
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  lines.push('## Narrative Read');
  lines.push('');
  lines.push(...renderNarrativeRead(story));
  lines.push('');

  lines.push('## Story Episodes');
  lines.push('');
  for (const episode of story.episodes) {
    lines.push(`### ${episode.title}`);
    lines.push('');
    lines.push(episode.summary);
    lines.push('');
    lines.push(`Evidence: ${episode.commits.length} commit${episode.commits.length === 1 ? '' : 's'}, ${episode.filesChanged} file${episode.filesChanged === 1 ? '' : 's'}, +${episode.additions}/-${episode.deletions}. Confidence: ${episode.confidence}.`);
    if (episode.graph.filesMatched > 0) {
      lines.push(`Graphify signal: ${episode.graph.filesMatched} indexed file${episode.graph.filesMatched === 1 ? '' : 's'}, ${episode.graph.nodeCount} graph node${episode.graph.nodeCount === 1 ? '' : 's'}, communities ${episode.graph.communities.join(', ') || 'none'}.`);
      if (episode.graph.symbols.length > 0) {
        lines.push(`Indexed symbols/files: ${episode.graph.symbols.map(v => `\`${v}\``).join(', ')}.`);
      }
    }
    if (episode.observations.length > 0) {
      lines.push('');
      lines.push('Detected changes:');
      for (const obs of episode.observations.slice(0, 8)) {
        const detail = obs.detail ? ` — ${obs.detail}` : '';
        const scope = obs.fileCount > 1 ? ` (${obs.fileCount} files)` : '';
        lines.push(`- ${obs.label}${detail}${scope}`);
      }
    }
    lines.push('');
    lines.push('Key files:');
    for (const file of episode.files.slice(0, 8)) {
      lines.push(`- \`${file.path}\` (${file.statuses.join('/')}, +${file.additions}/-${file.deletions})`);
    }
    lines.push('');
    lines.push('Commits:');
    for (const commit of episode.commits.slice(0, 8)) {
      const link = story.githubBaseUrl
        ? ` ([${commit.shortSha}](${story.githubBaseUrl}/commit/${commit.sha}))`
        : ` (${commit.shortSha})`;
      lines.push(`- ${commit.date.slice(0, 10)}${link}: ${commit.subject}`);
    }
    lines.push('');
  }

  lines.push('## Commit Ledger');
  lines.push('');
  for (const commit of story.commits) {
    const link = story.githubBaseUrl
      ? `[${commit.shortSha}](${story.githubBaseUrl}/commit/${commit.sha})`
      : commit.shortSha;
    const surfaceNames = commit.surfaces.slice(0, 5).map(s => s.title).join(', ') || 'Unclassified';
    lines.push(`- ${commit.date.slice(0, 10)} ${link}: ${commit.subject}`);
    lines.push(`  - ${commit.totals.files} files, +${commit.totals.additions}/-${commit.totals.deletions}; surfaces: ${surfaceNames}`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function renderNarrativeRead(story) {
  const lines = [];
  const INFRA_IDS = new Set(['assets-style', 'docs-release', 'repo-maintenance', 'tests', 'github-automation']);
  const productEpisodes = story.episodes.filter(e => !INFRA_IDS.has(e.id)).slice(0, 6);

  if (productEpisodes.length === 0) {
    return ['The requested range mostly contains repository maintenance, documentation, tests, or visual asset work.'];
  }

  lines.push(`This range reads as ${describeRangeShape(story)}: ${joinHumanList(productEpisodes.slice(0, 4).map(e => e.title))}.`);

  // IPC signals (Electron or similar patterns).
  const ipcSignals = story.episodes
    .flatMap(e => (e.observations || []).filter(o => o.kind === 'ipc').map(o => o.label))
    .slice(0, 4);
  if (ipcSignals.length > 0) {
    lines.push(`IPC bridge changes detected: ${joinHumanList(ipcSignals)}.`);
  }

  // Validation.
  const validationEpisode = story.episodes.find(e => e.id === 'tests');
  const validationSignals = (validationEpisode?.observations || []).filter(o => o.kind === 'validation');
  if (validationSignals.length > 0) {
    lines.push(`Validation evidence appears in ${joinHumanList(validationSignals.slice(0, 3).map(o => o.label))}.`);
  }

  if (story.graph.available && story.graph.coverage.unmatchedRendererFiles > 0) {
    lines.push(`Graphify currently explains part of this story, but ${story.graph.coverage.unmatchedRendererFiles} changed source files are not in the local index yet; run \`graphify update\` before treating architecture-community labels as complete.`);
  }

  return lines;
}

function describeRangeShape(story) {
  if (story.totals.files > 80) return 'a large grouped update';
  if (story.totals.commits <= 2 && story.totals.files > 20) return 'a compact but high-blast-radius update';
  return 'a focused product update';
}

// ── utils ─────────────────────────────────────────────────────────────────────

function joinHumanList(items) {
  const values = items.filter(Boolean);
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function describeDateRange(options) {
  if (options.since && options.until) return `${options.since}..${options.until}`;
  if (options.since) return `since ${options.since}`;
  if (options.until) return `until ${options.until}`;
  return `last ${options.maxCommits} commits`;
}

function detectGitHubBaseUrl(cwd) {
  try {
    return normalizeGitHubUrl(git(cwd, ['remote', 'get-url', 'origin']));
  } catch {
    return null;
  }
}

function normalizeGitHubUrl(remote) {
  if (!remote) return null;
  if (remote.startsWith('git@github.com:')) {
    return `https://github.com/${remote.slice('git@github.com:'.length).replace(/\.git$/, '')}`;
  }
  return remote.replace(/\.git$/, '');
}

function buildCompareUrl(githubBaseUrl, range) {
  if (!githubBaseUrl || !range || !range.includes('..')) return null;
  const [base, head] = range.split('..');
  if (!base || !head || range.includes('...')) return null;
  return `${githubBaseUrl}/compare/${base}...${head}`;
}

function writeTextFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function sortSurfaceSummary(a, b) {
  return (b.files + b.additions + b.deletions) - (a.files + a.additions + a.deletions) || a.title.localeCompare(b.title);
}

function splitWords(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function slugify(value) {
  return splitWords(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── run ───────────────────────────────────────────────────────────────────────

try {
  await main();
} catch (error) {
  console.error(`perci-story: ${error.message}`);
  process.exit(1);
}
