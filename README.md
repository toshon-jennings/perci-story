# perci-story

Build an evidence-backed product story from Git history and an optional [Graphify](https://github.com/safishamsi/graphify) knowledge graph.

Turns noisy commit ranges into a narrative: clusters changed files by surface, adds GitHub compare links, detects IPC handlers / storage keys / React components / test coverage across commits, and reports Graphify coverage so stale indexes don't become false certainty.

```bash
npm install -g perci-story
```

Then run from any repo — no arguments needed, auto-detects the last 50 commits:

```bash
story
```

Or scope it:

```bash
story --range v1.0.0..HEAD
story --since 2026-06-01
story --range HEAD~20..HEAD --out CHANGES.md --json CHANGES.json
```

---

## Options

| Flag | Description |
|------|-------------|
| `--range <rev-range>` | Git revision range, e.g. `v1.0.0..HEAD` |
| `--since <date>` | Include commits since a date (ISO 8601) |
| `--until <date>` | Include commits up to a date |
| `--max-commits <n>` | Limit commits when `--range` is omitted (default: 50) |
| `--out <path>` | Write Markdown to a file (defaults to stdout) |
| `--json <path>` | Write structured story JSON to a file |
| `--github <url>` | GitHub repo URL for commit and compare links |
| `--graph <path>` | Path to a Graphify `graph.json` (auto-detected if omitted) |
| `--config <path>` | Path to a `perci-story.config.mjs` custom surface file |

---

## What it does

1. **Reads Git history** — pulls commit messages, diffs, and file stats for the range
2. **Clusters by surface** — groups changed files into product surfaces (IPC, storage, React, tests, docs, etc.)
3. **Adds Graphify context** — when a graph is available, labels nodes by community and reports coverage
4. **Emits narrative** — a Markdown narrative + optional JSON with per-commit ledger and GitHub compare link

Large grouped commits especially benefit: one 50-file commit reads as "IPC refactor" rather than 50 disjointed file changes.

---

## Project links

| | |
|---|---|
| **Source** | [github.com/toshon-jennings/perci-story](https://github.com/toshon-jennings/perci-story) |
| **npm** | [npmjs.com/package/perci-story](https://npmjs.com/package/perci-story) |
| **Issues** | [GitHub Issues](https://github.com/toshon-jennings/perci-story/issues) |
| **Changelog** | [CHANGELOG.md](CHANGELOG.md) |

---

## License

MIT © 2026 Toshon Jennings
