/**
 * LLM-facing tool descriptions for the OMP Tools extension.
 */
export const READ_DESCRIPTION = `Read files, directories, archives, SQLite databases, PDFs, notebooks, images, and web URLs via one \`path\`.

Path suffixes:
- \`path:50\` or \`path:50-\` — from line 50 to the end | \`path:50-200\` (or \`50..200\`) — inclusive range | \`path:50+150\` — 150 lines from 50 | \`path:-60\` — last 60 lines
- Commas join ranges (\`:5-16,960-973\`) or pick individual lines (\`:19,59\`). An explicit single range also shows 1 line before and 3 lines after it.
- \`path:raw\` — verbatim content, no line numbers or snapshot header; combine with a range (\`:raw:50-100\` or \`50-100:raw\`).
- Reads page at 300 lines (cap 3000); truncated output names the exact continuation selector — re-issue ONLY that range.

Source kinds:
- Text file → \`[path#TAG]\` snapshot header + \`N:text\` numbered lines. Copy \`[FILENAME#TAG]\` verbatim for anchored \`edit\` patches; NEVER fabricate the tag.
- Directory → entry listing with sizes; page with \`dir:50-200\` / \`dir:-60\` (multi-range not supported).
- SQLite (\`.sqlite\`/\`.db\`/...): \`file.db\` (tables), \`file.db:table\` (schema+rows), \`file.db:table:key\` (row by PK), \`?limit=\`/\`?where=\`/\`?q=SELECT…\`.
- Archives (\`.zip\`/\`.jar\`/\`.tar\`/\`.tar.gz\`/...): bare path lists members; \`archive.ext:path/inside\` reads a member (optionally \`archive.ext:member:50-100\`).
- PDFs → extracted text (pdftotext). Notebooks (.ipynb) → rendered cells (edit via :raw JSON). Images → decoded inline.
- http(s) URLs → reader-mode text; \`path:raw\` → untouched body.

Parallelize independent reads.`;

export const WRITE_DESCRIPTION = `SHOULD \`edit\` existing files; \`write\` for required new files or whole-file replacement. NEVER create docs or emojis unless requested.
\`archive.ext:member\`: ZIP/tar families writable (whole-archive rewrite: member replaced, siblings preserved), others read-only. \`db.sqlite:table\`: insert; \`db.sqlite:table:key\`: JSON5 update, empty content deletes.
Response includes the new \`[path#TAG]\` snapshot header, so a follow-up \`edit\` can anchor immediately. Content starting with \`#!\` is made executable.`;

export const EDIT_DESCRIPTION = `Hashline patches existing files; new files: \`write\`. Each file: \`[PATH#TAG]\`, \`TAG\` required 4-hex snapshot from latest \`read\`/\`search\` (search match rows are prefixed with \`*\`). Numbers: original \`LINE:TEXT\`, never hunk-shifted.

<ops>
\`PUT N.=M:\` replace inclusive N–M with \`+\` body (\`N.=N\` for one line); \`PUT N*:\` replace block N.
\`PUT <N:\`/\`PUT >N:\` insert before/after N (\`<1\` head, \`>$\` tail). \`PUT >N*:\` insert after block N at sibling depth; inside, use \`PUT >M:\` at closer.
\`CUT N.=M\`/\`CUT N*\` delete and capture, optionally as \`@name\`.
\`PUT <N @name\`/\`PUT >N @name\` paste at gap (omit name for anonymous CUT); \`PUT N.=M @name\`/\`PUT N* @name\` paste over range/block (name REQUIRED). Register pastes have NO body; named registers persist across calls.
\`REM\` delete file; \`MV DEST\` rename after prior edits (quote spaced paths).
</ops>

<rules>
- \`:\` ops only: body rows \`+TEXT\` verbatim incl. indent; lone \`+\` blank. Literal \`- item\`/\`+ item\` → \`+- item\`/\`++ item\`. NEVER \`-\`/bare context. Body length independent of range; delete with CUT, not empty PUT.
- Touch displayed changed lines only; \`…\`, \`..\`, collapsed \`N-M:\` and out-of-window lines UNSEEN. Re-read first. Tight ranges: split nonadjacent changes; NEVER include keepers or start/end mid-expression/block. Pure addition uses gap PUT.
- \`*\` requires multi-line opener, NEVER closer/last/inner statement; use range/gap for one statement. Anchor first decorator/attribute/doc-comment to include it; standalone comments need explicit range.
- Markdown heading blocks run through deeper headings until next same/higher; after section \`PUT >N*:\`, end body with blank line.
- NEVER restyle unrelated code. After EVERY edit tag/numbers change: use edit response or fresh \`read\`; stale tag/surprise → STOP, re-read.
</rules>

<example>
\`\`\`
[greet.py#A1B2]
PUT 1*:
+@cache
+def greet(name):
+    print(name)
[PLAN.md#3C4D]
PUT >2:
+- task
\`\`\`
Cross-file move: \`CUT 1* @fn\` in source, then \`PUT <1 @fn\` in destination section.
</example>`;

export const SEARCH_DESCRIPTION = `Regex search over files, directories, and globs (ripgrep-powered).

- \`path\`: file, directory, or glob; \`;\`-separated list. Default \`.\`.
- Case-sensitive by default; \`case: false\` for case-insensitive. Gitignore respected; \`gitignore: false\` searches ignored files too.
- File-only line selector: \`src/foo.ts:50-100\` (ranges joined by comma: \`src/foo.ts:5-16,960-973\`; \`src/foo.ts:19,59\` picks individual lines).
- A literal \`\\n\` in the pattern enables cross-line (multiline) matching.
- Bare glob \`*.ts\` matches any depth; \`dir/*.ts\` only \`dir\`'s direct children (\`dir/**/*.ts\` recurses).
- Match rows \`*N:text\`, context rows \` N:text\` (1 before / 3 after); multi-scope groups under \`# dir\` tree headers with a \`#TAG\` suffix, single file under \`[path#TAG]\` — line numbers + tag are valid \`edit\` anchors.
- \`skip\` paginates files (20 per page). Prefer this over shell grep/rg.`;

export const FIND_DESCRIPTION = `Glob files/dirs: glob, file, or directory; semicolon-separated list (existing literal paths keep their delimiters). Omitted → workspace root; a slash-only input (\`/\`) means the session cwd. \`gitignore\` and \`hidden\` default true — ignored dotfiles need \`gitignore: false\`.

- Bare top-level globs are recursive (\`*.ts\` matches at any depth); \`dir/*.ts\` matches only \`dir\`'s direct children. Each path is its own scan root; missing paths in a multi-path call are skipped and named; a single missing path is an error.
- Results newest-first by directory; dirs end in \`/\`; \`limit\` (default 200) is clamped to 1..200 with a notice; scans time out at 5s and return partial results with an incomplete-scan notice, not an error.
- Use search when you need content matches; find only matches paths.`;
