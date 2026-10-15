/**
 * `read` tool: files, dirs, archives, SQLite, PDFs, notebooks, and URLs
 * through one `path`, with `:selector` suffixes (ranges, :raw, sqlite
 * table/key, archive members).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolError, textResult, type ToolCtx, type ToolResult } from "../host.ts";
import { snapshots } from "../shared/snapshots.ts";
import { assertReadonlySql, assertSafeIdentifier, sqliteDriver, type Row } from "../shared/sqlite.ts";
import {
	capOutput,
	displayPath,
	formatBytes,
	formatNumberedLine,
	hasBinary,
	imageMimeFor,
	isProbablyBinary,
	isSqliteFile,
	normalizeText,
	pathExists,
	resolvePath,
	run,
	statOrNull,
	tarExtOf,
	ZIP_EXTS,
} from "../shared/util.ts";

interface LineRange {
	start: number;
	end: number; // Number.POSITIVE_INFINITY = to EOF
}

interface TextSelector {
	ranges: LineRange[];
	raw: boolean;
	tail: number | null;
}

/**
 * Read windowing — mirrors oh-my-pi's read tool, which exposes NO limit
 * parameter: the default window is DEFAULT_READ_LINES (its `read.defaultLimit`
 * setting default) and every read, explicit range included, is hard-capped at
 * MAX_READ_LINES (its `DEFAULT_MAX_LINES`).
 */
const DEFAULT_READ_LINES = 300;
const MAX_READ_LINES = 3000;

/** Bracket context around an explicit single range (OMP read-format constants). */
const RANGE_LEADING_CONTEXT_LINES = 1;
const RANGE_TRAILING_CONTEXT_LINES = 3;

/** OMP line-range chunk grammar: `N`, `N-M`, `N-` (open-ended), `N+K`, with `..` and `L` aliases. */
const LINE_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;
const TAIL_SELECTOR_RE = /^-(\d+)$/;

function invalidSelectorMessage(sel: string): string {
	return `Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), :-N (last N lines), ` +
		"a comma-separated list of ranges, :raw, or a range combined with raw (e.g. :raw:50-100).";
}

/**
 * Parse one range chunk (OMP `parseChunk`). `pinBare` makes a separator-less
 * `N` the single line N (bare numbers inside a comma list) instead of
 * "from N onward". Returns null on grammar mismatch; throws ToolError on
 * invalid bounds (0, inverted range, +0) — OMP's exact messages.
 */
function parseRangeChunk(chunk: string, pinBare: boolean): LineRange | null {
	const match = LINE_RANGE_CHUNK_RE.exec(chunk);
	if (!match) return null;
	const rawStart = Number.parseInt(match[1] as string, 10);
	if (rawStart < 1) throw new ToolError("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
	const sep = (match[2] === ".." ? "-" : match[2]) as string | undefined;
	const rhs = match[3] ? Number.parseInt(match[3], 10) : undefined;
	let end: number;
	if (sep === "+") {
		if (rhs === undefined || rhs < 1) throw new ToolError(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
		end = rawStart + rhs - 1;
	} else if (sep !== undefined) {
		// `-` (or its `..` alias); a missing end is open-ended (`301-` ≡ bare `301`).
		if (rhs !== undefined) {
			if (rhs < rawStart) throw new ToolError(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
			end = rhs;
		} else {
			end = Number.POSITIVE_INFINITY;
		}
	} else {
		end = pinBare ? rawStart : Number.POSITIVE_INFINITY;
	}
	return { start: rawStart, end };
}

/**
 * Parse a comma-separated list of ranges (e.g. `5-16,960-973` or `19,59`),
 * sorted ascending with overlapping/adjacent ranges merged; an open-ended
 * range absorbs every later range (OMP `parseLineRanges`). null when a chunk
 * is not a valid range.
 */
function parseLineRanges(sel: string): LineRange[] | null {
	const chunks = sel.split(",");
	const pinBare = chunks.length > 1;
	const parsed: LineRange[] = [];
	for (const chunk of chunks) {
		const range = parseRangeChunk(chunk.trim(), pinBare);
		if (!range) return null;
		parsed.push(range);
	}
	if (parsed.length === 0) return null;
	parsed.sort((a, b) => a.start - b.start);
	const merged: LineRange[] = [parsed[0] as LineRange];
	for (let i = 1; i < parsed.length; i++) {
		const current = parsed[i] as LineRange;
		const last = merged[merged.length - 1] as LineRange;
		if (last.end === Number.POSITIVE_INFINITY) continue; // to EOF — later ranges absorbed
		if (current.start <= last.end + 1) {
			if (current.end === Number.POSITIVE_INFINITY || current.end > last.end) {
				merged[merged.length - 1] = { start: last.start, end: current.end };
			}
			continue;
		}
		merged.push(current);
	}
	return merged;
}

/** Parse a `-N` tail selector into its line count (last N lines); null when not tail-shaped. */
function parseTailCount(sel: string): number | null {
	const match = TAIL_SELECTOR_RE.exec(sel);
	if (!match) return null;
	const count = Number.parseInt(match[1] as string, 10);
	if (count < 1) throw new ToolError("Tail selector -0 is invalid; use :-N with N >= 1 to read the last N lines.");
	return count;
}

/**
 * Parse the selector parts (after path/member splitting) into a TextSelector,
 * accepting OMP's grammar: `raw` (case-insensitive), range chunks alone or
 * comma-listed, and a whole-selector `:-N` tail. At most one range shape and
 * one tail per path; anything unrecognized throws OMP's invalid-selector error.
 */
function parseTextSelectors(selectors: string[]): TextSelector {
	const result: TextSelector = { ranges: [], raw: false, tail: null };
	let sawRange = false;
	let sawTail = false;
	for (const rawSel of selectors) {
		const sel = rawSel.trim();
		if (sel.length === 0) continue;
		if (sel.toLowerCase() === "raw") {
			result.raw = true;
			continue;
		}
		if (sel.includes(",")) {
			if (sawRange || sawTail) throw new ToolError(invalidSelectorMessage(sel));
			const ranges = parseLineRanges(sel);
			if (!ranges) throw new ToolError(invalidSelectorMessage(sel));
			result.ranges.push(...ranges);
			sawRange = true;
			continue;
		}
		const tail = parseTailCount(sel);
		if (tail !== null) {
			if (sawRange || sawTail) throw new ToolError(invalidSelectorMessage(sel));
			result.tail = tail;
			sawTail = true;
			continue;
		}
		const range = parseRangeChunk(sel, false);
		if (range) {
			if (sawRange || sawTail) throw new ToolError(invalidSelectorMessage(sel));
			result.ranges.push(range);
			sawRange = true;
			continue;
		}
		throw new ToolError(invalidSelectorMessage(sel));
	}
	return result;
}

interface ResolvedTarget {
	abs: string;
	selectors: string[];
	query: URLSearchParams;
}

async function resolveTarget(raw: string, cwd: string): Promise<ResolvedTarget> {
	let query = new URLSearchParams();
	let candidate = raw;

	const asIs = resolvePath(candidate, cwd);
	if (await pathExists(asIs)) return { abs: asIs, selectors: [], query };

	// `?limit=&where=&q=` query attached to the last selector (or the path).
	const questionIndex = candidate.lastIndexOf("?");
	if (questionIndex !== -1) {
		query = new URLSearchParams(candidate.slice(questionIndex + 1));
		candidate = candidate.slice(0, questionIndex);
		const absNoQuery = resolvePath(candidate, cwd);
		if (await pathExists(absNoQuery)) return { abs: absNoQuery, selectors: [], query };
	}

	const segments = candidate.split(":");
	for (let cut = 1; cut < Math.min(segments.length, 4); cut++) {
		const base = segments.slice(0, segments.length - cut).join(":");
		if (!base) break;
		const abs = resolvePath(base, cwd);
		if (await pathExists(abs)) return { abs, selectors: segments.slice(segments.length - cut), query };
	}
	return { abs: asIs, selectors: [], query };
}

export interface DisplayRow {
	n: number;
	text: string;
}

interface SelectionResult {
	text: string;
	rows: DisplayRow[];
	moreLines: number;
	totalLines: number;
}

const DETAIL_ROW_CAP = 400;

/** Resolve `:-N` tails against the line count; defaults to a whole-file range. */
function resolveRanges(selector: TextSelector | null, total: number): LineRange[] {
	if (selector && selector.tail !== null) {
		const start = Math.max(1, total - selector.tail + 1);
		return [{ start, end: total }];
	}
	if (selector && selector.ranges.length > 0) return selector.ranges;
	return [{ start: 1, end: Number.POSITIVE_INFINITY }];
}

/**
 * Select lines for a numbered/raw text read — OMP's windowing:
 *  - default read (no range) → first DEFAULT_READ_LINES lines
 *  - explicit single range → the range plus bracket context (1 line before,
 *    3 lines after when the range ends before EOF), capped at MAX_READ_LINES
 *  - multi-range → exactly the requested ranges (no context), each capped at
 *    MAX_READ_LINES, out-of-bounds ranges surfaced as inline notices
 * Footers mirror OMP: `[Showing lines X-Y of T. Use :Z to continue]` whenever
 * the window stops before EOF, and a graceful message when a requested start
 * is beyond the end of the file. `prefix` renders the continuation selector:
 * `:` for local files (the header names the path), `${path}:` for
 * URL/archive/PDF reads.
 */
function selectLines(
	lines: string[],
	selector: TextSelector | null,
	shownPath: string,
	tag: string | undefined,
	prefix = ":",
): SelectionResult {
	const total = lines.length;
	const raw = selector?.raw ?? false;
	const header = raw ? null : tag ? `[${shownPath}#${tag}]` : `[${shownPath}]`;
	const ranges = resolveRanges(selector, total);

	if (total === 0) {
		return { text: header ? `${header}\nThe file is empty.` : "The file is empty.", rows: [], moreLines: 0, totalLines: 0 };
	}

	// ── Single range (default, explicit, or resolved tail): context + budget.
	if (ranges.length === 1) {
		const range = ranges[0] as LineRange;
		const explicit = (selector?.ranges.length ?? 0) > 0 || (selector?.tail ?? null) !== null;
		if (explicit && range.start > total) {
			const text = `Line ${range.start} is beyond end of file (${total} lines total). Use ${prefix}1 to read from the start, or ${prefix}${total} to read the last line.`;
			return { text, rows: [], moreLines: 0, totalLines: total };
		}
		const openEnded = range.end === Number.POSITIVE_INFINITY;
		const startClamped = Math.max(1, range.start);
		const endClamped = Math.min(openEnded ? total : range.end, total);
		const leading = !raw && startClamped > 1 ? Math.min(RANGE_LEADING_CONTEXT_LINES, startClamped - 1) : 0;
		const trailing = !raw && !openEnded ? Math.min(RANGE_TRAILING_CONTEXT_LINES, Math.max(0, total - endClamped)) : 0;
		const requestedLength = openEnded ? DEFAULT_READ_LINES : endClamped - range.start + 1;
		const maxLines = Math.min(requestedLength + leading + trailing, MAX_READ_LINES);
		const rowStart = startClamped - 1 - leading;
		const stop = Math.min(endClamped + trailing, rowStart + maxLines);

		const out: string[] = [];
		const rows: DisplayRow[] = [];
		if (header) out.push(header);
		for (let i = rowStart; i < stop; i++) {
			const lineNo = i + 1;
			const lineText = lines[i] as string;
			out.push(raw ? lineText : formatNumberedLine(lineNo, lineText));
			if (rows.length < DETAIL_ROW_CAP) rows.push({ n: lineNo, text: lineText });
		}
		const lastShown = stop;
		if (stop < total) out.push(`[Showing lines ${rowStart + 1}-${lastShown} of ${total}. Use ${prefix}${lastShown + 1} to continue]`);
		return { text: out.join("\n"), rows, moreLines: total - lastShown, totalLines: total };
	}

	// ── Multi-range: exact ranges, no context, inline out-of-bounds notices.
	const out: string[] = [];
	const rows: DisplayRow[] = [];
	const blocks: string[] = [];
	const notices: string[] = [];
	let lastShown = 0;
	for (const range of ranges) {
		if (range.start > total) {
			const bound = range.end === Number.POSITIVE_INFINITY ? `${range.start}` : `${range.start}-${range.end}`;
			notices.push(`[Range ${bound} is beyond end of file (${total} lines total); skipped]`);
			continue;
		}
		const requestedLength = range.end === Number.POSITIVE_INFINITY ? DEFAULT_READ_LINES : Math.min(range.end, total) - range.start + 1;
		const maxLines = Math.min(Math.max(requestedLength, 1), MAX_READ_LINES);
		const start = Math.max(1, range.start);
		const end = Math.min(range.end === Number.POSITIVE_INFINITY ? total : range.end, total);
		const part: string[] = [];
		for (let line = start; line <= end && part.length < maxLines; line++) {
			const lineText = lines[line - 1] as string;
			part.push(raw ? lineText : formatNumberedLine(line, lineText));
			if (rows.length < DETAIL_ROW_CAP) rows.push({ n: line, text: lineText });
		}
		if (part.length > 0) {
			blocks.push(part.join("\n"));
			lastShown = Math.max(lastShown, start + part.length - 1);
		}
	}
	if (header) out.push(header);
	if (blocks.length > 0) out.push(blocks.join("\n\n…\n\n"));
	if (notices.length > 0) out.push(notices.join("\n"));
	const moreLines = blocks.length > 0 ? Math.max(0, total - lastShown) : 0;
	return { text: out.join("\n"), rows, moreLines, totalLines: total };
}

/** Structured directory entry passed to renderers via result details. */
interface DirEntryDetail {
	name: string;
	dir?: boolean;
	/** Pre-formatted size ("8.1KB") for plain files. */
	size?: string;
	/** Child count for readable subdirectories. */
	count?: number;
	/** Symlink target. */
	link?: string;
}

async function readDirectory(abs: string, shownPath: string, selector: TextSelector | null): Promise<ToolResult> {
	const entries = await fs.readdir(abs, { withFileTypes: true });
	entries.sort((a, b) => {
		if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	const lines: string[] = [`${shownPath}/ — ${entries.length} entries`];
	const detailEntries: DirEntryDetail[] = [];
	const cap = 400;
	for (const entry of entries.slice(0, cap)) {
		if (entry.isDirectory()) {
			let count = "";
			let childCount: number | undefined;
			try {
				childCount = (await fs.readdir(path.join(abs, entry.name))).length;
				count = ` (${childCount})`;
			} catch {
				/* permission */
			}
			lines.push(`  ${entry.name}/${count}`);
			detailEntries.push({ name: entry.name, dir: true, ...(childCount === undefined ? {} : { count: childCount }) });
		} else if (entry.isSymbolicLink()) {
			const link = await fs.readlink(path.join(abs, entry.name)).catch(() => "?");
			lines.push(`  ${entry.name} -> ${link}`);
			detailEntries.push({ name: entry.name, link });
		} else {
			const stat = await statOrNull(path.join(abs, entry.name));
			lines.push(`  ${entry.name}  ${stat ? formatBytes(stat.size) : ""}`);
			detailEntries.push({ name: entry.name, ...(stat ? { size: formatBytes(stat.size) } : {}) });
		}
	}
	if (entries.length > cap) lines.push(`  … ${entries.length - cap} more entries`);
	// OMP paging: `:N-M` and `:-N` slice the rendered listing line by line;
	// multi-range selectors are rejected for directories.
	if (selector && selector.ranges.length > 1) {
		throw new ToolError("Multi-range line selectors are not supported for directory listings.");
	}
	if (selector && (selector.ranges.length > 0 || selector.tail !== null)) {
		const range =
			selector.tail !== null
				? { start: Math.max(1, lines.length - selector.tail + 1), end: lines.length }
				: (selector.ranges[0] as LineRange);
		const start = Math.max(1, range.start);
		if (start > lines.length) {
			const suggestion =
				lines.length === 0
					? "The listing is empty."
					: `Use :1 to read from the start, or :${lines.length} to read the last line.`;
			const text = `Line ${start} is beyond end of listing (${lines.length} lines total). ${suggestion}`;
			return textResult(text, { kind: "dir", path: shownPath, body: text, entries: detailEntries, total: entries.length });
		}
		const end = Math.min(range.end === Number.POSITIVE_INFINITY ? lines.length : range.end, lines.length);
		const sliced = lines.slice(start - 1, end).join("\n");
		let text = sliced;
		if (end < lines.length) text += `\n\n[${lines.length - end} more lines in listing. Use :${end + 1} to continue]`;
		return textResult(text, { kind: "dir", path: shownPath, body: text, entries: detailEntries, total: entries.length });
	}
	return textResult(lines.join("\n"), {
		kind: "dir",
		path: shownPath,
		body: lines.join("\n"),
		entries: detailEntries,
		total: entries.length,
	});
}

function renderRows(rows: Row[], cap = 100): string[] {
	const lines: string[] = [];
	for (const row of rows.slice(0, cap)) {
		const cells = Object.fromEntries(
			Object.entries(row).map(([key, value]) => {
				if (value instanceof Uint8Array) return [key, `<blob ${value.length}B>`];
				if (typeof value === "string" && value.length > 200) return [key, `${value.slice(0, 200)}…`];
				return [key, value];
			}),
		);
		lines.push(JSON.stringify(cells));
	}
	if (rows.length > cap) lines.push(`… ${rows.length - cap} more rows`);
	return lines;
}

async function readSqlite(
	abs: string,
	shownPath: string,
	selectors: string[],
	query: URLSearchParams,
): Promise<ToolResult> {
	const driver = await sqliteDriver();
	if (!driver) {
		throw new ToolError("No SQLite driver available (needs node:sqlite, bun:sqlite, or the sqlite3 CLI).");
	}
	const customSql = query.get("q");
	if (customSql) {
		const rows = await driver.query(abs, assertReadonlySql(customSql));
		{
			const body = [`${shownPath} ?q= — ${rows.length} rows`, ...renderRows(rows)].join("\n");
			return textResult(body, { kind: "sqlite", body });
		}
	}
	if (selectors.length === 0) {
		const tables = await driver.query(
			abs,
			"SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
		);
		const lines = [`${shownPath} — ${tables.length} tables`];
		for (const table of tables) {
			const name = String(table.name);
			let count = "?";
			try {
				const countRows = await driver.query(abs, `SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`);
				count = String(countRows[0]?.n ?? "?");
			} catch {
				/* virtual tables etc. */
			}
			lines.push(`  ${name} (${table.type}, ${count} rows)`);
		}
		lines.push(`Next: ${shownPath}:<table> for schema+rows, :<table>:<key> by primary key, ?limit=/?where=/?q=SELECT…`);
		return textResult(lines.join("\n"), { kind: "sqlite", body: lines.join("\n") });
	}

	const table = assertSafeIdentifier(selectors[0] as string);
	const limit = Math.min(Number.parseInt(query.get("limit") ?? "20", 10) || 20, 500);
	const schema = await driver.query(abs, `PRAGMA table_info("${table}")`);
	if (schema.length === 0) throw new ToolError(`No such table in ${shownPath}: ${table}`);
	const columns = schema.map(col => `${col.name} ${col.type}${col.pk ? " PK" : ""}${col.notnull ? " NOT NULL" : ""}`);

	if (selectors.length >= 2) {
		const key = selectors.slice(1).join(":");
		const pkColumn = String(schema.find(col => col.pk)?.name ?? "rowid");
		const rows = await driver.query(abs, `SELECT * FROM "${table}" WHERE "${pkColumn}" = ? LIMIT 5`, [key]);
		if (rows.length === 0) {
			const body = `${shownPath}:${table}: no row with ${pkColumn}=${key}`;
			return textResult(body, { kind: "sqlite", body });
		}
		{
			const body = [`${shownPath}:${table} ${pkColumn}=${key}`, ...renderRows(rows)].join("\n");
			return textResult(body, { kind: "sqlite", body });
		}
	}

	const where = query.get("where");
	const whereSql = where ? ` WHERE ${assertReadonlySqlFragment(where)}` : "";
	const rows = await driver.query(abs, `SELECT * FROM "${table}"${whereSql} LIMIT ${limit}`);
	const lines = [
		`${shownPath}:${table} — columns: ${columns.join(", ")}`,
		`rows (limit ${limit}${where ? `, where ${where}` : ""}):`,
		...renderRows(rows),
	];
	return textResult(lines.join("\n"), { kind: "sqlite", body: lines.join("\n") });
}

function assertReadonlySqlFragment(fragment: string): string {
	if (/;|--|\/\*/.test(fragment)) throw new ToolError("Unsafe characters in ?where= fragment");
	return fragment;
}

async function readZipArchive(abs: string, shownPath: string, member: string | undefined, selector: TextSelector | null): Promise<ToolResult> {
	if (!(await hasBinary("unzip"))) throw new ToolError("`unzip` is required to read zip archives.");
	if (!member) {
		const listing = await run("unzip", ["-l", abs]);
		if (listing.code !== 0) throw new ToolError(`unzip -l failed: ${listing.stderr.trim()}`);
		{
			const body = capOutput(`${shownPath}:\n${listing.stdout.trim()}\nRead a member with ${shownPath}:<member/path>`).text;
			return textResult(body, { kind: "archive", body });
		}
	}
	const extraction = await run("unzip", ["-p", abs, member]);
	if (extraction.code !== 0) {
		throw new ToolError(`Cannot extract ${member} from ${shownPath}: ${extraction.stderr.trim() || "not found"}`);
	}
	return renderArchiveMember(shownPath, member, extraction.stdout, selector);
}

async function readTarArchive(abs: string, shownPath: string, member: string | undefined, selector: TextSelector | null): Promise<ToolResult> {
	if (!member) {
		const listing = await run("tar", ["-tvf", abs]);
		if (listing.code !== 0) throw new ToolError(`tar -tvf failed: ${listing.stderr.trim()}`);
		{
			const body = capOutput(`${shownPath}:\n${listing.stdout.trim()}\nRead a member with ${shownPath}:<member/path>`).text;
			return textResult(body, { kind: "archive", body });
		}
	}
	const extraction = await run("tar", ["-xOf", abs, member]);
	if (extraction.code !== 0) {
		throw new ToolError(`Cannot extract ${member} from ${shownPath}: ${extraction.stderr.trim() || "not found"}`);
	}
	return renderArchiveMember(shownPath, member, extraction.stdout, selector);
}

function renderArchiveMember(shownPath: string, member: string, content: string, selector: TextSelector | null): ToolResult {
	if (content.includes("\u0000")) {
		throw new ToolError(`${shownPath}:${member} is binary (${content.length} bytes).`);
	}
	const memberPath = `${shownPath}:${member}`;
	const normalized = normalizeText(content);
	const lines = normalized.text.length === 0 ? [""] : (selector?.raw ? normalized.text : normalized.text.replace(/\n$/, "")).split("\n");
	const selected = selectLines(lines, selector, memberPath, undefined, `${memberPath}:`);
	return textResult(capOutput(`${selected.text}\n(read-only archive member)`).text, {
		kind: selector?.raw ? "raw" : "text",
		path: memberPath,
		...(selector?.raw ? { body: selected.text } : {}),
		rows: selected.rows,
		moreLines: selected.moreLines,
		totalLines: selected.totalLines,
	});
}

async function readPdf(abs: string, shownPath: string, selector: TextSelector | null): Promise<ToolResult> {
	if (!(await hasBinary("pdftotext"))) {
		throw new ToolError("`pdftotext` (poppler) is required to read PDFs. Install it or read the file with :raw elsewhere.");
	}
	const conversion = await run("pdftotext", ["-layout", abs, "-"]);
	if (conversion.code !== 0) throw new ToolError(`pdftotext failed: ${conversion.stderr.trim()}`);
	const lines = conversion.stdout.replace(/\f/g, "\n— page break —\n").split("\n");
	const selected = selectLines(lines, selector, shownPath, undefined, `${shownPath}:`);
	return textResult(capOutput(`${selected.text}\n(read-only PDF extraction)`).text, {
		kind: "text",
		path: shownPath,
		rows: selected.rows,
		moreLines: selected.moreLines,
		totalLines: selected.totalLines,
	});
}

interface NotebookCell {
	cell_type: string;
	source: string[] | string;
	outputs?: Array<{ output_type: string; text?: string[] | string; data?: Record<string, unknown> }>;
}

function renderNotebook(shownPath: string, rawJson: string): ToolResult {
	let parsed: { cells?: NotebookCell[] };
	try {
		parsed = JSON.parse(rawJson) as { cells?: NotebookCell[] };
	} catch (error) {
		throw new ToolError(`Invalid notebook JSON in ${shownPath}: ${String(error)}`);
	}
	const cells = parsed.cells ?? [];
	const out: string[] = [`${shownPath} — ${cells.length} cells (read cells; edit via :raw JSON)`];
	let emitted = 0;
	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i] as NotebookCell;
		const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
		out.push(`── cell ${i + 1} [${cell.cell_type}] ──`);
		for (const line of source.split("\n")) {
			if (emitted >= DEFAULT_READ_LINES) break;
			out.push(line);
			emitted++;
		}
		const textOutputs = (cell.outputs ?? [])
			.map(output => {
				if (output.text) return Array.isArray(output.text) ? output.text.join("") : output.text;
				const data = output.data?.["text/plain"];
				if (data) return Array.isArray(data) ? data.join("") : String(data);
				return "";
			})
			.filter(Boolean);
		if (textOutputs.length > 0) {
			out.push(`  ▸ output: ${textOutputs.join("").split("\n").slice(0, 5).join("\n  ")}`);
		}
		if (emitted >= DEFAULT_READ_LINES) {
			out.push(`… truncated at cell ${i + 1} of ${cells.length} (default read limit ${DEFAULT_READ_LINES} lines; read via ${shownPath}:raw for the full JSON)`);
			break;
		}
	}
	return textResult(capOutput(out.join("\n")).text, { kind: "notebook", body: out.join("\n") });
}

function htmlToText(html: string): string {
	let text = html;
	text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
	text = text.replace(/<!--[\s\S]*?-->/g, "");
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
	text = text.replace(/<head[\s\S]*?<\/head>/gi, "");
	text = text.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n");
	text = text.replace(/<li[^>]*>/gi, "\n- ");
	text = text.replace(/<[^>]+>/g, "");
	text = text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&#x27;/gi, "'");
	text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	return titleMatch ? `# ${titleMatch[1]?.trim()}\n\n${text}` : text;
}

/**
 * Split a trailing `:raw` / `:ranges` selector off a URL. Handles bare
 * domains (`https://example.com:raw`), trailing slashes
 * (`https://example.com/:raw`), and paths (`https://x.com/p:10-20`).
 * A purely numeric tail on a path-less URL stays a port
 * (`https://host:8080`); add a trailing slash to disambiguate
 * (`https://host:8080/:50` selects lines).
 */
export function parseUrlTarget(rawUrl: string): { url: string; selector: TextSelector | null } {
	const selectorMatch = /^(.*):((?:raw)(?::[\d+,\-]+)?|[\d]+(?:[+\-,][\d,+\-]*)?(?::raw)?)$/.exec(rawUrl);
	if (!selectorMatch) return { url: rawUrl, selector: null };
	const prefix = selectorMatch[1] as string;
	const tail = selectorMatch[2] as string;
	let parsed: URL;
	try {
		parsed = new URL(prefix);
	} catch {
		return { url: rawUrl, selector: null };
	}
	// `https://host:8080` — a purely numeric tail with no path is a port.
	if (/^\d+$/.test(tail) && parsed.pathname === "/" && !prefix.endsWith("/")) {
		return { url: rawUrl, selector: null };
	}
	const selector = parseTextSelectors(tail.split(":"));
	return { url: prefix, selector };
}

async function readUrl(rawUrl: string, signal?: AbortSignal): Promise<ToolResult> {
	const target = parseUrlTarget(rawUrl);
	const url = target.url;
	const selector = target.selector;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30_000);
	signal?.addEventListener("abort", () => controller.abort());
	let response: Response;
	try {
		response = await fetch(url, {
			signal: controller.signal,
			redirect: "follow",
		headers: { "user-agent": "Mozilla/5.0 (compatible; omp-tools)", accept: "text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.8" },
		});
	} catch (error) {
		throw new ToolError(`Fetch failed for ${url}: ${String((error as Error).message ?? error)}`);
	} finally {
		clearTimeout(timeout);
	}
	if (!response.ok) throw new ToolError(`HTTP ${response.status} ${response.statusText} for ${url}`);
	const contentType = response.headers.get("content-type") ?? "";
	const body = await response.text();
	const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body.slice(0, 256));
	const raw = selector?.raw ?? false;
	const text = isHtml && !raw ? htmlToText(body) : body;
	const lines = text.split("\n");
	// Same OMP windowing as local text: default 300-line page, 3000-line cap,
	// continuation hint pointing back at the URL.
	const selected = selectLines(lines, selector, url, undefined, `${url}:`);
	const bodyText = selected.text;
	return textResult(capOutput(bodyText).text, {
		kind: raw ? "url" : "text",
		path: url,
		...(raw ? { body: bodyText } : {}),
		rows: selected.rows,
		moreLines: selected.moreLines,
		totalLines: selected.totalLines,
	});
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export async function executeRead(rawPath: string, ctx?: ToolCtx, signal?: AbortSignal): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	const trimmed = rawPath.trim().replace(/^@/, "");

	if (/^https?:\/\//i.test(trimmed)) return readUrl(trimmed, signal);

	const target = await resolveTarget(trimmed, cwd);
	const shownPath = displayPath(target.abs, cwd);
	const stat = await statOrNull(target.abs);
	if (!stat) {
		const parent = path.dirname(target.abs);
		let hint = "";
		const parentStat = await statOrNull(parent);
		if (parentStat?.isDirectory()) {
			const siblings = (await fs.readdir(parent).catch(() => [] as string[])).slice(0, 15);
			hint = `\nNearby in ${displayPath(parent, cwd)}/: ${siblings.join(", ")}`;
		}
		throw new ToolError(`Not found: ${shownPath}${hint}`);
	}

	if (stat.isDirectory()) {
		const selector = target.selectors.length > 0 ? parseTextSelectors(target.selectors) : null;
		return readDirectory(target.abs, shownPath, selector);
	}

	if (isSqliteFile(target.abs)) return readSqlite(target.abs, shownPath, target.selectors, target.query);

	const lowerPath = target.abs.toLowerCase();
	if (ZIP_EXTS.has(path.extname(lowerPath))) {
		const memberSelector = target.selectors.length > 1 ? parseTextSelectors(target.selectors.slice(1)) : null;
		return readZipArchive(target.abs, shownPath, target.selectors[0], memberSelector);
	}
	if (tarExtOf(lowerPath)) {
		const memberSelector = target.selectors.length > 1 ? parseTextSelectors(target.selectors.slice(1)) : null;
		return readTarArchive(target.abs, shownPath, target.selectors[0], memberSelector);
	}

	const selector = target.selectors.length > 0 ? parseTextSelectors(target.selectors) : null;

	if (lowerPath.endsWith(".pdf")) return readPdf(target.abs, shownPath, selector);

	const mime = imageMimeFor(target.abs);
	if (mime) {
		if (stat.size > MAX_IMAGE_BYTES) {
			throw new ToolError(`Image too large: ${shownPath} is ${formatBytes(stat.size)} (max ${formatBytes(MAX_IMAGE_BYTES)}).`);
		}
		const data = await fs.readFile(target.abs);
		return {
			content: [
				{ type: "text", text: `${shownPath} (${mime}, ${formatBytes(stat.size)})` },
				{ type: "image", data: data.toString("base64"), mimeType: mime },
			],
			details: {},
		};
	}

	if (stat.size > MAX_FILE_BYTES) {
		throw new ToolError(`File too large: ${shownPath} is ${formatBytes(stat.size)}. Use search, or read a :range.`);
	}

	const buffer = await fs.readFile(target.abs);
	if (isProbablyBinary(buffer)) {
		throw new ToolError(`Binary file: ${shownPath} (${formatBytes(stat.size)}). Not readable as text.`);
	}

	const raw = buffer.toString("utf8");
	if (lowerPath.endsWith(".ipynb") && !(selector?.raw ?? false)) {
		return renderNotebook(shownPath, raw);
	}

	const normalized = normalizeText(raw);
	if (selector?.raw) {
		// Raw reads keep the terminal-newline sentinel line, are never
		// numbered, and get no snapshot tag (OMP parity) — but the same
		// default window and continuation hints apply.
		const lines = normalized.text.split("\n");
		const selected = selectLines(lines, selector, shownPath, undefined, ":");
		return textResult(capOutput(selected.text).text, { kind: "raw", path: shownPath, body: selected.text });
	}

	const tag = snapshots.record(target.abs, normalized.text);
	const lines = normalized.text.length === 0 ? [""] : normalized.text.replace(/\n$/, "").split("\n");
	const selected = selectLines(lines, selector, shownPath, tag, ":");
	const out = capOutput(selected.text);
	// Record the lines this response displays so the edit tool's seen-lines
	// guard knows what the model has actually seen (OMP parity).
	const seen: number[] = [];
	for (const row of out.text.split("\n")) {
		const m = /^ *(\d+):/.exec(row);
		if (m !== null) seen.push(Number(m[1] as string));
	}
	if (seen.length > 0) snapshots.recordSeenLines(target.abs, tag, seen);
	return textResult(out.text, {
		kind: "text",
		path: shownPath,
		tag,
		rows: selected.rows,
		moreLines: selected.moreLines,
		totalLines: selected.totalLines,
	});
}
