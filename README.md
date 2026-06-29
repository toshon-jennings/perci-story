# perci-story

Build an evidence-backed product story from Git history and an optional [Graphify](https://github.com/graphify) knowledge graph.

```
npm install -g perci-story
```

## Usage

```bash
# By git range
story --range v1.0.0..HEAD

# By date
story --since 2026-06-01

# Write to files
story --range HEAD~20..HEAD --out CHANGES.md --json CHANGES.json

# With GitHub commit/compare links
story --range v1.0.0..HEAD --github https://github.com/owner/repo
```

## Options

| Flag | Description |
|------|-------------|
| `--range <rev-range>` | Git revision range, e.g. `v1.0.0..HEAD` |
| `--since <date>` | Include commits since a date |
| `--until <date>` | Include commits until a date |
| `--max-commits <n>` | Limit commits when `--range` is omitted (default: 50) |
| `--out <path>` | Write Markdown to a file (defaults to stdout) |
| `--json <path>` | Write structured story JSON to a file |
| `--github <url>` | GitHub repo URL for commit and compare links |
| `--graph <path>` | Path to a Graphify `graph.json` (auto-detected if omitted) |
| `--config <path>` | Path to a surface config file |

## Custom surfaces

Place a `perci-story.config.mjs` in your project root to teach the tool about your codebase surfaces:

```js
// perci-story.config.mjs
export const surfaces = [
  { id: 'auth',     title: 'Authentication',   match: f => f.includes('/auth/') },
  { id: 'api',      title: 'API layer',         match: f => f.startsWith('src/api/') },
  { id: 'payments', title: 'Payments',          match: f => f.includes('stripe') || f.includes('/billing/') },
];
```

Without a config file, perci-story falls back to generic path-based classification (`src/components/`, `src/lib/`, `electron/`, `test/`, etc.).

## Graphify integration

If your project has a Graphify graph (at `graphify-out/graph.json` or `docs/architecture/graphify-out/graph.json`), perci-story automatically enriches episodes with graph node counts, community IDs, and indexed symbol names.

Run `graphify update` to keep the graph fresh before generating stories over large ranges.
