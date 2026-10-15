# pi-omp-tools

A standalone [pi](https://pi.dev) extension that registers five focused file and search tools:

| Tool | Description |
|------|-------------|
| `read` | Read files, directories, archives, SQLite databases, PDFs, notebooks, images, and URLs through one path. |
| `write` | Create or overwrite files, archive entries, and SQLite rows. |
| `edit` | Apply line-anchored hashline patches with stale-anchor recovery. |
| `search` | Search files and globs with regex. Results also provide edit anchors. |
| `find` | Find paths by glob, newest first, with gitignore support. |

All five tools share one process-global snapshot store. Tags minted by `read` or `search` therefore validate in `edit` within the same process.

## Install

Point the host at this directory:

```bash
pi -e /path/to/pi-omp-tools
```

Or list it in the host settings:

```json
{ "packages": ["/path/to/pi-omp-tools"] }
```

## System-prompt integration

The extension adds three forms of host integration:

1. **`promptGuidelines`** add focused usage guidance for each tool.
2. **`before_agent_start`** adds the shared `## OMP Tools` workflow block and the `read → edit` anchor loop.
3. **Built-in retirement** deactivates overlapping built-ins such as `grep`, `glob`, `rg`, and `ls` when their OMP Tools replacements are installed. Set `OMP_TOOLS_KEEP_BUILTINS=1` to opt out.

## Environment variables

| Variable | Effect |
|----------|--------|
| `OMP_TOOLS_KEEP_BUILTINS=1` | Keep host built-ins (`grep`, `glob`, `rg`, `ls`) active. |
| `OMP_TOOLS_GREP_CONTEXT_BEFORE` | Lines of context before a match (default 1). |
| `OMP_TOOLS_GREP_CONTEXT_AFTER` | Lines of context after a match (default 3). |

## The hashline edit loop

```
read src/foo.ts          →  [src/foo.ts#1A2B]
                            1:import { x } from "./x";
                            2:export function main() {
                            ...

edit                     →  [src/foo.ts#1A2B]
                            PUT 2*:
                            +export function main(): void {
                            +  run();
                            +}

response                 →  [src/foo.ts#9F3E] updated
                            2:export function main(): void {
                            ...fresh numbers for the next edit
```

- `PUT A.=B:` replaces lines. `PUT <A:` and `PUT >A:` insert lines. `PUT A*:` replaces a block. `CUT A.=B [@r]` captures a range. `PUT >N @r` pastes it. `REM` and `MV` remove or move a file.
- Tags are four-character content hashes. Stale tags can recover when their anchor lines still match. Ambiguous edits fail with a re-read instruction.
- Markdown sections, tree-sitter syntax blocks, and bracket or indentation fallbacks provide block resolution.

## Requirements

- Node 20 or newer, or Bun, in the host agent.
- Recommended commands on `PATH`: `rg`, `unzip`, `zip`, `tar`, and `pdftotext`.
- SQLite support uses `node:sqlite`, `bun:sqlite`, or the `sqlite3` CLI, whichever is available.
- The `find` engine cascades: ripgrep (`rg --files`, exact gitignore semantics) plus a JS directory/symlink walker — `rg --files` lists regular files only, while OMP's native glob walker also emits directories and symlinks — then tinyglobby when `rg` is not on PATH. Both engines share the same contract: 5s timeout returning partial results with an incomplete-scan notice, never an error.
- Optional native grammars are used automatically when installed: `@ast-grep/napi` plus `@ast-grep/lang-*` grammars (tree-sitter block resolution for Python, Rust, Go, Java, C, C++, JSON, and YAML in `edit`).

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
