/**
 * `search` tool: OMP-aligned regex search over files, globs, and directories
 * via ripgrep (pure-JS walker fallback when rg is unavailable).
 *
 * Behavior mirrors oh-my-pi's `search` (coding-agent/src/tools/grep.ts):
 *  - schema is pattern, path?, case?, gitignore?, skip? — nothing else
 *  - case-sensitive by default; `case: false` searches case-insensitively
 *  - a literal `\n` (or the `\\n` escape) in the pattern enables cross-line matching
 *  - context defaults to 1 line before / 3 after (OMP_TOOLS_GREP_CONTEXT_*)
 *  - `skip` paginates matched files (20 per page); single-file scopes never paginate
 *  - per-file caps: 20 matches (multi-scope) / 200 (single file), trimmed silently
 *  - files over 4 MiB are searched only within their leading 4 MiB window
 *  - output: match rows `*N:text`, context rows ` N:text`, under a `# dir`
 *    prefix-folded tree (multi-scope) or one `[path#TAG]` header (single file);
 *    gap separator `...`; line numbers + tag are `edit` anchors
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolError, textResult, type ToolCtx, type ToolResult } from "../host.ts";
import { snapshots } from "../shared/snapshots.ts";
import {
	displayPath,
	hasBinary,
	hasGlobMagic,
	isProbablyBinary,
	normalizeText,
	pathExists,
	readPrefix,
	resolvePath,
	run,
	rgIgnoreFlags,
	splitGlobEntry,
	splitPathList,
	statOrNull,
	truncateToBytes,
} from "../shared/util.ts";

export interface SearchParams {
	pattern: string;
	path?: string;
	case?: boolean;
	gitignore?: boolean;
	skip?: number | null;
}

/** Maximum number of distinct files surfaced in a single response; the agent pages via `skip`. */
const FILE_LIMIT = 20;
/** Per-file match cap for multi-file searches — keeps a single hot file from crowding out diverse hits. */
const MULTI_FILE_PER_FILE_MATCHES = 20;
/** Per-file match cap for single-file searches — no diversity concern when the scope is one file. */
const SINGLE_FILE_MATCHES = 200;
/** Hard safety ceiling on how many matches we fetch before JS-side grouping. */
const INTERNAL_TOTAL_CAP = 2000;
/** Files larger than this are searched only within their leading window (OMP native grep). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Wall-clock budget for a single search invocation. */
const GREP_TIMEOUT_MS = 30_000;
/** Column cap in bytes (OMP DEFAULT_MAX_COLUMN). */
const MAX_COLUMN_BYTES = 512;
/** Files larger than this get no snapshot tag (OMP record_snapshot_file). */
const TAG_MAX_BYTES = MAX_FILE_BYTES;

function contextSetting(envName: string, fallback: number): number {
	const raw = process.env[envName];
	if (raw === undefined || raw === "") return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/* -------------------------- OMP line-range grammar -------------------------- */

/** Inclusive line range; `endLine` undefined means open-ended (through EOF). */
interface LineRange {
	startLine: number;
	endLine: number | undefined;
}

/** One chunk: `N`, `N-M`, `N-`, `N+K`, or `..`-aliased (`N..M`, `N..`), optional `L` prefix. */
const LINE_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

function parseLineRangeChunk(sel: string, pinBare: boolean): LineRange | null {
	const lineMatch = LINE_RANGE_CHUNK_RE.exec(sel);
	if (!lineMatch) return null;
	const rawStart = Number.parseInt(lineMatch[1]!, 10);
	if (rawStart < 1) {
		throw new ToolError("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
	}
	// `..` is a forgiving alias for `-` (e.g. `2724..2727` == `2724-2727`).
	const sep = lineMatch[2] === ".." ? "-" : lineMatch[2];
	const rhs = lineMatch[3] ? Number.parseInt(lineMatch[3]!, 10) : undefined;
	let rawEnd: number | undefined;
	if (sep === "+") {
		if (rhs === undefined || rhs < 1) {
			throw new ToolError(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
		}
		rawEnd = rawStart + rhs - 1;
	} else if (sep === "-") {
		// `301-` is shorthand for "from 301 onward" — equivalent to a lone bare `301`.
		if (rhs !== undefined) {
			if (rhs < rawStart) {
				throw new ToolError(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
			}
			rawEnd = rhs;
		}
	} else if (pinBare) {
		// Inside a comma list a bare number is that one line.
		rawEnd = rawStart;
	}
	return { startLine: rawStart, endLine: rawEnd };
}

/**
 * Parse a comma-separated list of line ranges (e.g. `5-16,960-973` or `19,59`).
 * A lone `:50` means "from line 50"; inside a comma list, a bare number is that
 * one line. Returns the ranges ascending with overlapping/adjacent ranges merged.
 */
function parseLineRanges(sel: string): [LineRange, ...LineRange[]] | null {
	const chunks = sel.split(",");
	const pinBare = chunks.length > 1;
	const parsed: LineRange[] = [];
	for (const chunk of chunks) {
		const range = parseLineRangeChunk(chunk, pinBare);
		if (!range) return null;
		parsed.push(range);
	}
	if (parsed.length === 0) return null;
	parsed.sort((a, b) => a.startLine - b.startLine);
	const merged: LineRange[] = [parsed[0]!];
	for (let i = 1; i < parsed.length; i++) {
		const current = parsed[i]!;
		const last = merged[merged.length - 1]!;
		// Open-ended (endLine undefined) means "to EOF" — any later range is absorbed.
		if (last.endLine === undefined) continue;
		// Merge when current starts within (or immediately after) the last range.
		if (current.startLine <= last.endLine + 1) {
			if (current.endLine === undefined || current.endLine > last.endLine) {
				merged[merged.length - 1] = { startLine: last.startLine, endLine: current.endLine };
			}
			continue;
		}
		merged.push(current);
	}
	return merged as [LineRange, ...LineRange[]];
}

function isLineInRanges(lineNumber: number, ranges: readonly LineRange[]): boolean {
	for (const range of ranges) {
		if (lineNumber < range.startLine) continue;
		if (range.endLine === undefined || lineNumber <= range.endLine) return true;
	}
	return false;
}

/** Peel a trailing `:N-M[,A+B]` line-range selector (OMP splitPathAndSel, search subset). */
function splitRangeSelector(entry: string): { base: string; sel: string } | null {
	const colon = entry.lastIndexOf(":");
	if (colon <= 0) return null;
	const sel = entry.slice(colon + 1);
	if (!sel || sel.split(",").some(chunk => !LINE_RANGE_CHUNK_RE.test(chunk))) return null;
	return { base: entry.slice(0, colon), sel };
}

/* --------------------------------- targets ---------------------------------- */

interface SearchTarget {
	/** The model's entry verbatim (for errors/notes). */
	original: string;
	kind: "root" | "glob" | "fileRange";
	/** Absolute file (kind root/fileRange) or scan directory (kind glob). */
	root: string;
	/** kind glob: pattern relative to `root`. */
	glob?: string;
	/** kind glob: OMP non-recursive — direct entries of `root` only (rg subdirectory prune). */
	toplevelOnly?: boolean;
	/** kind root: true when the root is a regular file. */
	isFile?: boolean;
	/** kind fileRange: parsed line-range match filter. */
	ranges?: [LineRange, ...LineRange[]];
}

/**
 * OMP `is_exact_brace_union`: `{a,b}` with plain names only. Such patterns are
 * matched as-is (no any-depth double-star prefix) even when the entry is bare.
 */
function isExactBraceUnion(pattern: string): boolean {
	if (!(pattern.startsWith("{") && pattern.endsWith("}"))) return false;
	const inner = pattern.slice(1, -1);
	return inner.length > 0 && !inner.split("").some(ch => "*?[]{}".includes(ch));
}

function parseTargets(rawPath: string | undefined, cwd: string): Promise<{ targets: SearchTarget[]; missing: string[] }> {
	return (async () => {
		const entries = splitPathList(rawPath ?? ".");
		if (entries.length === 0) {
			throw new ToolError("Search scope entries must be non-empty paths or globs");
		}
		const targets: SearchTarget[] = [];
		const missing: string[] = [];
		for (const entry of entries) {
			// A literal filesystem match outranks selector/glob interpretation
			// (a real file named `test:1-2` is that file, issue #4618 in OMP).
			const literal = resolvePath(entry, cwd);
			if (await pathExists(literal)) {
				const stat = await statOrNull(literal);
				targets.push({ original: entry, kind: "root", root: literal, isFile: stat?.isFile() ?? false });
				continue;
			}
			// File-only line-range selector: src/foo.ts:50-100
			const split = splitRangeSelector(entry);
			if (split) {
				if (hasGlobMagic(split.base)) {
					throw new ToolError(`Line-range selector requires a single file, not a glob: ${entry}`);
				}
				const baseAbs = resolvePath(split.base, cwd);
				if (!(await pathExists(baseAbs))) {
					throw new ToolError(`Path not found for line-range selector: ${entry}`);
				}
				const stat = await statOrNull(baseAbs);
				if (stat?.isDirectory()) {
					throw new ToolError(`Line-range selector requires a single file: ${entry} is a directory`);
				}
				const ranges = parseLineRanges(split.sel);
				if (!ranges) {
					throw new ToolError(`path entry "${entry}" — only line-range selectors like ":50-100" are supported`);
				}
				targets.push({ original: entry, kind: "fileRange", root: baseAbs, isFile: true, ranges });
				continue;
			}
			// Glob: anchor at the static base dir so rg's relative globs match like OMP's
			// (bare simple globs any-depth; slashed globs anchored to the base).
			const glob = splitGlobEntry(entry, cwd);
			if (glob) {
				const anchored = glob.glob.includes("/");
				const stars = glob.glob.startsWith("**");
				const toplevelOnly = !anchored && !stars && (!glob.bare || isExactBraceUnion(glob.glob));
				if ((await statOrNull(glob.base))?.isDirectory()) {
					targets.push({ original: entry, kind: "glob", root: glob.base, glob: glob.glob, toplevelOnly });
				} else {
					missing.push(entry);
				}
				continue;
			}
			missing.push(entry);
		}
		return { targets, missing };
	})();
}

/* ------------------------------ match collection ---------------------------- */

interface FileMatches {
	file: string;
	/** Line number → row; context and match rows merged (isMatch wins). */
	lines: Map<number, { text: string; isMatch: boolean }>;
	matchCount: number;
	/** Matches trimmed by the per-file cap (>= 1 when capped). */
	more: number;
}

interface Collection {
	files: Map<string, FileMatches>;
	limitReached: boolean;
}

function addLine(files: Map<string, FileMatches>, filePath: string, lineNumber: number, text: string, isMatch: boolean): void {
	let entry = files.get(filePath);
	if (!entry) {
		entry = { file: filePath, lines: new Map(), matchCount: 0, more: 0 };
		files.set(filePath, entry);
	}
	const existing = entry.lines.get(lineNumber);
	if (isMatch) {
		if (existing && existing.isMatch) return; // duplicate match across overlapping targets
		if (!existing) entry.matchCount += 1;
		entry.lines.set(lineNumber, { text, isMatch: true });
	} else if (!existing) {
		entry.lines.set(lineNumber, { text, isMatch: false });
	}
}

interface RgJsonEvent {
	type: string;
	data: {
		path?: { text?: string };
		line_number?: number;
		lines?: { text?: string };
	};
}

async function ripgrepSearch(
	pattern: string,
	params: SearchParams,
	targets: SearchTarget[],
	cwd: string,
	signal: AbortSignal | undefined,
	perFileFetch: number,
): Promise<Collection> {
	const baseArgs = ["--json", "--no-messages", "--regexp", pattern];
	if (params.case === false) baseArgs.push("-i");
	if (params.gitignore === false) baseArgs.push("--no-ignore");
	baseArgs.push("--hidden");
	// Multiline is enabled by the pattern itself (OMP), never a parameter.
	if (pattern.includes("\n") || pattern.includes("\\n")) baseArgs.push("--multiline", "--multiline-dotall");
	const before = contextSetting("OMP_TOOLS_GREP_CONTEXT_BEFORE", 1);
	const after = contextSetting("OMP_TOOLS_GREP_CONTEXT_AFTER", 3);
	if (before > 0) baseArgs.push("-B", String(before));
	if (after > 0) baseArgs.push("-A", String(after));
	baseArgs.push("--max-count", String(perFileFetch), "--max-columns", String(MAX_COLUMN_BYTES));

	const files = new Map<string, FileMatches>();
	let limitReached = false;
	let totalMatches = 0;
	for (const target of targets) {
		const extra: string[] = [];
		if (target.kind === "glob") {
			extra.push("-g", target.glob!);
			// OMP non-recursive globs only match direct children: prune every
			// subdirectory so rg's any-depth `*` cannot leak deeper.
			if (target.toplevelOnly) extra.push("-g", "!*/");
		}
		// `!.git` last: rg's last matching -g wins, so a user glob like `*`
		// cannot resurrect the .git tree.
		extra.push("-g", "!.git");
		const runCwd = target.kind === "glob" ? target.root : cwd;
		const positional = target.kind === "glob" ? ["."] : [target.root];
		const ignoreFlags = params.gitignore !== false ? await rgIgnoreFlags(runCwd) : [];
		const result = await run("rg", [...baseArgs, ...ignoreFlags, ...extra, ...positional], {
			cwd: runCwd,
			signal,
			timeoutMs: GREP_TIMEOUT_MS,
			maxBuffer: 64 * 1024 * 1024,
		});
		if (result.timedOut) {
			throw new ToolError(
				`Grep timed out after ${GREP_TIMEOUT_MS / 1000}s; narrow paths or pattern, or scope with \`glob\` first`,
			);
		}
		// rg exit codes: 0 = matches, 1 = no matches, 2 = error
		if (result.code === 2 && !result.stdout.trim()) {
			// rg: "regex parse error:\n <pattern>\n ^\nerror: unclosed group" — the
			// Rust-regex-style message is the final line (OMP surfaces it verbatim).
			const lines = result.stderr.split("\n").map(l => l.trim()).filter(Boolean);
			if (/^regex(?: parse)? error:/i.test(lines[0] ?? "")) {
				const message = lines[lines.length - 1]?.replace(/^error:\s*/i, "") || "invalid pattern";
				throw new ToolError(`Invalid regex: ${message}`);
			}
			throw new ToolError(`ripgrep error: ${lines[0] || "unknown"}`);
		}
		for (const line of result.stdout.split("\n")) {
			if (!line) continue;
			for (const event of parseRgLine(line, target.kind === "glob" ? target.root : "")) {
				if (totalMatches >= INTERNAL_TOTAL_CAP) {
					limitReached = true;
					continue;
				}
				if (event.isMatch) {
					const before_ = files.get(event.filePath)?.matchCount ?? 0;
					addLine(files, event.filePath, event.lineNumber, event.text, true);
					const after_ = files.get(event.filePath)?.matchCount ?? 0;
					if (after_ > before_) totalMatches += 1;
				} else if (totalMatches < INTERNAL_TOTAL_CAP) {
					addLine(files, event.filePath, event.lineNumber, event.text, false);
				}
			}
		}
		if (totalMatches >= INTERNAL_TOTAL_CAP) limitReached = true;
	}
	return { files, limitReached };
}

/** Parse one rg --json event line; returns the rows it carries (match/context). */
function parseRgLine(
	line: string,
	base: string,
): Array<{ filePath: string; lineNumber: number; text: string; isMatch: boolean }> {
	let event: RgJsonEvent;
	try {
		event = JSON.parse(line);
	} catch {
		return [];
	}
	if (event.type !== "match" && event.type !== "context") return [];
	const rawFilePath = event.data.path?.text;
	const lineNumber = event.data.line_number;
	if (!rawFilePath || typeof lineNumber !== "number") return [];
	const filePath = base ? path.resolve(base, rawFilePath) : rawFilePath;
	const text = (event.data.lines?.text ?? "").replace(/\n$/, "");
	return [{ filePath, lineNumber, text, isMatch: event.type === "match" }];
}

/* ------------------------------- JS fallback -------------------------------- */

/** Minimal gitignore matcher for the rg-less path (root + nested .gitignore). */
interface IgnoreRule {
	negated: boolean;
	dirOnly: boolean;
	re: RegExp;
}

function parseGitignoreText(text: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const rawLine of text.split("\n")) {
		let line = rawLine.trimEnd();
		if (!line || line.startsWith("#")) continue;
		let negated = false;
		if (line.startsWith("!")) {
			negated = true;
			line = line.slice(1);
		}
		let dirOnly = false;
		if (line.endsWith("/")) {
			dirOnly = true;
			line = line.slice(0, -1);
		}
		if (!line) continue;
		const anchored = line.includes("/");
		const body = globToReBody(line.replace(/^\//, ""));
		// No unescaped slash: matches the name at any depth; with slash: anchored
		// to the directory holding the .gitignore.
		const re = anchored ? new RegExp(`^${body}$`) : new RegExp(`^(?:.*/)?${body}$`);
		rules.push({ negated, dirOnly, re });
	}
	return rules;
}

/** Convert a git-style glob to a RegExp body (no anchors). */
function globToReBody(pattern: string): string {
	let out = "";
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i]!;
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					out += "(?:[^/]+/)*";
					i += 3;
				} else {
					out += ".*";
					i += 2;
				}
			} else {
				out += "[^/]*";
				i += 1;
			}
		} else if (c === "?") {
			out += "[^/]";
			i += 1;
		} else if (c === "[") {
			let j = i + 1;
			let cls = "";
			if (pattern[j] === "!" || pattern[j] === "^") {
				cls += "^";
				j += 1;
			}
			while (j < pattern.length && pattern[j] !== "]") {
				cls += pattern[j]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				j += 1;
			}
			out += cls ? `[${cls}]` : "[^/]";
			i = j < pattern.length ? j + 1 : pattern.length;
		} else if (c === "{") {
			let depth = 1;
			let j = i + 1;
			while (j < pattern.length && depth > 0) {
				if (pattern[j] === "{") depth += 1;
				else if (pattern[j] === "}") depth -= 1;
				j += 1;
			}
			if (depth === 0) {
				const inner = pattern.slice(i + 1, j - 1);
				const alts = inner.split(",").map(alternative => globToReBody(alternative));
				out += alts.length > 1 ? `(?:${alts.join("|")})` : globToReBody(inner);
				i = j;
			} else {
				out += "\\{";
				i += 1;
			}
		} else {
			out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			i += 1;
		}
	}
	return out;
}

/** Compile an OMP search glob: bare simple globs match any depth (double-star prefix). */
function compileSearchGlob(glob: string, toplevelOnly: boolean): RegExp {
	let pattern = glob;
	if (!toplevelOnly && !pattern.includes("/") && !pattern.startsWith("**")) pattern = `**/${pattern}`;
	return new RegExp(`^${globToReBody(pattern)}$`);
}

interface IgnoreChainLevel {
	dir: string;
	rules: IgnoreRule[];
}

async function jsFallbackSearch(
	pattern: string,
	params: SearchParams,
	targets: SearchTarget[],
	cwd: string,
	signal: AbortSignal | undefined,
	perFileFetch: number,
): Promise<Collection> {
	let flags = params.case === false ? "gi" : "g";
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, flags);
	} catch (error) {
		throw new ToolError(`Invalid regex: ${String(error)}`);
	}
	// Multiline: `.` crosses newlines; a literal \n in the pattern already matches
	// newline characters in JS regexes.
	if (pattern.includes("\n") || pattern.includes("\\n")) {
		regex = new RegExp(regex.source, flags + "s");
	}
	const before = contextSetting("OMP_TOOLS_GREP_CONTEXT_BEFORE", 1);
	const after = contextSetting("OMP_TOOLS_GREP_CONTEXT_AFTER", 3);
	const useIgnore = params.gitignore !== false;
	const ignoreCache = new Map<string, IgnoreRule[]>();
	const files = new Map<string, FileMatches>();
	let limitReached = false;
	let totalMatches = 0;

	const rulesFor = async (dir: string): Promise<IgnoreRule[]> => {
		if (!useIgnore) return [];
		const cached = ignoreCache.get(dir);
		if (cached !== undefined) return cached;
		let rules: IgnoreRule[] = [];
		try {
			const stat = await statOrNull(path.join(dir, ".gitignore"));
			if (stat?.isFile()) rules = parseGitignoreText(await fs.readFile(path.join(dir, ".gitignore"), "utf8"));
		} catch {
			rules = [];
		}
		ignoreCache.set(dir, rules);
		return rules;
	};

	/** Last matching rule wins, evaluated top-down (git precedence). */
	const lastMatchWins = (chain: IgnoreChainLevel[], abs: string, isDir: boolean): boolean => {
		let ignored = false;
		for (const level of chain) {
			const rel = path.relative(level.dir, abs).split(path.sep).join("/");
			if (!rel) continue;
			for (const rule of level.rules) {
				if (rule.dirOnly && !isDir) continue;
				if (rule.re.test(rel)) ignored = !rule.negated;
			}
		}
		return ignored;
	};

	const visit = async (abs: string, chain: IgnoreChainLevel[], glob: RegExp | null, globRoot: string, toplevelOnly: boolean): Promise<void> => {
		if (signal?.aborted || totalMatches >= INTERNAL_TOTAL_CAP) {
			if (totalMatches >= INTERNAL_TOTAL_CAP) limitReached = true;
			return;
		}
		const stat = await statOrNull(abs);
		if (!stat) return;
		if (stat.isDirectory()) {
			if (path.basename(abs) === ".git") return;
			if (toplevelOnly && abs !== globRoot) return;
			if (chain.length > 0 && lastMatchWins(chain, abs, true)) return;
			const own = await rulesFor(abs);
			const nextChain = own.length > 0 ? [...chain, { dir: abs, rules: own }] : chain;
			for (const name of await fs.readdir(abs).catch(() => [] as string[])) {
				await visit(path.join(abs, name), nextChain, glob, globRoot, toplevelOnly);
			}
			return;
		}
		if (!stat.isFile()) return;
		if (glob) {
			const rel = path.relative(globRoot, abs).split(path.sep).join("/");
			if (!glob.test(rel)) return;
		}
		if (chain.length > 0 && lastMatchWins(chain, abs, false)) return;
		if (stat.size === 0) return;
		// 4 MiB window (OMP): large files are searched in their leading bytes only.
		const buffer = await readPrefix(abs, Math.min(stat.size, MAX_FILE_BYTES));
		if (!buffer || isProbablyBinary(buffer)) return;
		const lines = buffer.toString("utf8").split("\n");
		const entry: FileMatches = { file: abs, lines: new Map(), matchCount: 0, more: 0 };
		for (let i = 0; i < lines.length; i++) {
			regex.lastIndex = 0;
			if (!regex.test(lines[i]!)) continue;
			const start = Math.max(0, i - before);
			const end = Math.min(lines.length - 1, i + after);
			for (let j = start; j <= end; j++) {
				const text = truncateToBytes(lines[j]!, MAX_COLUMN_BYTES).text;
				const isMatch = j === i;
				const existing = entry.lines.get(j + 1);
				if (existing) {
					if (isMatch) existing.isMatch = true;
				} else {
					entry.lines.set(j + 1, { text, isMatch });
				}
			}
			entry.matchCount += 1;
			totalMatches += 1;
			if (entry.matchCount >= perFileFetch) break;
			if (totalMatches >= INTERNAL_TOTAL_CAP) {
				limitReached = true;
				break;
			}
		}
		if (entry.matchCount > 0) files.set(abs, entry);
	};

	for (const target of targets) {
		if (target.kind === "glob") {
			await visit(target.root, [], compileSearchGlob(target.glob!, target.toplevelOnly === true), target.root, target.toplevelOnly === true);
		} else {
			await visit(target.root, [], null, cwd, false);
		}
	}
	return { files, limitReached };
}

/* ------------------------------ shared post-stages -------------------------- */

/** Last complete line number within the leading 4 MiB of `abs`. */
async function windowEndLine(abs: string): Promise<number> {
	const buffer = await readPrefix(abs, MAX_FILE_BYTES);
	if (!buffer) return Number.MAX_SAFE_INTEGER;
	const text = buffer.toString("latin1");
	let end = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x0a) end += 1;
	return end;
}

/**
 * Trim an entry to `perFileCap` matches (silent, OMP). The tail matches vanish;
 * matches that fall inside the last kept match's context-after window demote to
 * context rows (OMP only ever renders context of the kept matches).
 */
function capEntry(entry: FileMatches, perFileCap: number, after: number): void {
	const matchLines = [...entry.lines.keys()].filter(n => entry.lines.get(n)!.isMatch).sort((a, b) => a - b);
	if (matchLines.length <= perFileCap) return;
	entry.more = matchLines.length - perFileCap;
	const lastKept = matchLines[perFileCap - 1]!;
	const cutoff = lastKept + after;
	for (const n of [...entry.lines.keys()]) {
		const row = entry.lines.get(n)!;
		if (n > cutoff) {
			if (row.isMatch) entry.matchCount -= 1;
			entry.lines.delete(n);
		} else if (n > lastKept && row.isMatch) {
			entry.matchCount -= 1;
			entry.lines.set(n, { text: row.text, isMatch: false });
		}
	}
}

/** Render a file's rows: `*N:text` match rows, ` N:text` context rows, `...` gaps. */
function fileRowLines(entry: FileMatches): string[] {
	const rows: string[] = [];
	let last = 0;
	for (const n of [...entry.lines.keys()].sort((a, b) => a - b)) {
		const row = entry.lines.get(n)!;
		if (last > 0 && n > last + 1) rows.push("...");
		rows.push(`${row.isMatch ? "*" : " "}${n}:${row.text}`);
		last = n;
	}
	return rows;
}

/* ------------------------- grouped tree output (OMP) ------------------------ */

interface FileTreeNode {
	files: Array<{ name: string; key: string }>;
	fileNames: Set<string>;
	subdirs: Array<{ name: string; node: FileTreeNode }>;
	dirIndex: Map<string, FileTreeNode>;
}

function createTreeNode(): FileTreeNode {
	return { files: [], fileNames: new Set(), subdirs: [], dirIndex: new Map() };
}

/**
 * Multi-level path tree shared with OMP's grouped file output: single-child
 * directory chains fold so the shared prefix collapses into one `# dir/` header.
 */
function buildPathTree(paths: string[]): FileTreeNode {
	const root = createTreeNode();
	for (const filePath of paths) {
		const normalized = filePath.replace(/\\/g, "/");
		const segments = normalized.split("/");
		const dirCount = segments.length - 1;
		let node = root;
		for (let i = 0; i < dirCount; i++) {
			const segment = segments[i]!;
			let child = node.dirIndex.get(segment);
			if (!child) {
				child = createTreeNode();
				node.dirIndex.set(segment, child);
				node.subdirs.push({ name: segment, node: child });
			}
			node = child;
		}
		const name = segments[segments.length - 1]!;
		if (!node.fileNames.has(name)) {
			node.fileNames.add(name);
			node.files.push({ name, key: filePath });
		}
	}
	return root;
}

function* walkPathTree(node: FileTreeNode, depth = 0): Generator<{ kind: "dir" | "file"; depth: number; name: string; key: string }> {
	for (const file of node.files) {
		yield { kind: "file", depth, name: file.name, key: file.key };
	}
	for (const subdir of node.subdirs) {
		let dirNode = subdir.node;
		const parts = [subdir.name];
		while (dirNode.files.length === 0 && dirNode.subdirs.length === 1) {
			const only = dirNode.subdirs[0]!;
			parts.push(only.name);
			dirNode = only.node;
		}
		yield { kind: "dir", depth, name: parts.join("/"), key: "" };
		yield* walkPathTree(dirNode, depth + 1);
	}
}

interface DisplayFile {
	display: string;
	tag?: string;
	rows: string[];
	more: number;
}

/**
 * OMP grouped layout: one `#` per level; a blank line precedes every
 * depth-0 event and every directory header. Flat mode (single file) emits a
 * bare `[path#TAG]` header when a tag was minted.
 */
function renderModelOutput(files: DisplayFile[], grouped: boolean): string[] {
	const out: string[] = [];
	if (!grouped) {
		const file = files[0];
		if (file && file.tag) out.push(`[${file.display}#${file.tag}]`);
		if (file) out.push(...file.rows);
		return out;
	}
	const tree = buildPathTree(files.map(file => file.display));
	const sections = new Map(files.map(file => [file.display, file] as const));
	let emitted = false;
	for (const event of walkPathTree(tree)) {
		const hashes = "#".repeat(event.depth + 1);
		const needsSeparator = emitted && (event.depth === 0 || event.kind === "dir");
		if (needsSeparator) out.push("");
		emitted = true;
		if (event.kind === "dir") {
			out.push(`${hashes} ${event.name}/`);
			continue;
		}
		const section = sections.get(event.key);
		if (!section) continue;
		out.push(`${hashes} ${event.name}${section.tag ? `#${section.tag}` : ""}`, ...section.rows);
	}
	return out;
}

/* --------------------------------- execute ---------------------------------- */

/** Accept JSON-array-shaped strings (`'["a","b"]'`) like OMP toPathList. */
function toPathListString(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed) && parsed.every(v => typeof v === "string")) return (parsed as string[]).join(";");
		} catch {
			// not a JSON array — treat as a literal path
		}
	}
	return raw;
}

export async function executeSearch(params: SearchParams, ctx?: ToolCtx, signal?: AbortSignal): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	// Preserve the pattern verbatim — leading/trailing whitespace is meaningful in regexes.
	if (!params.pattern.trim()) {
		throw new ToolError("Pattern must not be empty");
	}
	const pattern = params.pattern;
	const normalizedSkip =
		params.skip === undefined || params.skip === null ? 0 : Number.isFinite(params.skip) ? Math.floor(params.skip) : Number.NaN;
	if (normalizedSkip < 0 || !Number.isFinite(normalizedSkip)) {
		throw new ToolError("Skip must be a non-negative number");
	}
	const after = contextSetting("OMP_TOOLS_GREP_CONTEXT_AFTER", 3);

	const { targets, missing } = await parseTargets(toPathListString(params.path ?? "."), cwd);
	if (targets.length === 0) {
		throw new ToolError(`Path not found: ${missing.join(", ")}; list each target in the semicolon-delimited \`path\``);
	}
	// Single-file scopes can't paginate — there is one file by definition.
	const singleScope = targets.length === 1 && (targets[0]!.kind === "fileRange" || targets[0]!.isFile === true);
	const isMultiScope = !singleScope;
	const perFileCap = isMultiScope ? MULTI_FILE_PER_FILE_MATCHES : SINGLE_FILE_MATCHES;
	const perFileFetch = perFileCap + 1;

	const { files, limitReached } = (await hasBinary("rg"))
		? await ripgrepSearch(pattern, params, targets, cwd, signal, perFileFetch)
		: await jsFallbackSearch(pattern, params, targets, cwd, signal, perFileFetch);

	// Line-range filters from single-file selectors (context trimmed to the ranges).
	for (const target of targets) {
		if (target.kind !== "fileRange" || !target.ranges) continue;
		const entry = files.get(target.root);
		if (!entry) continue;
		for (const n of [...entry.lines.keys()]) {
			if (!isLineInRanges(n, target.ranges)) {
				if (entry.lines.get(n)!.isMatch) entry.matchCount -= 1;
				entry.lines.delete(n);
			}
		}
		if (entry.matchCount <= 0) files.delete(target.root);
	}

	// 4 MiB window: files past the size cap keep only matches within the window;
	// explicit file targets get OMP's partial-coverage note.
	const oversized: string[] = [];
	for (const target of targets) {
		if (target.kind === "glob") continue;
		const st = await statOrNull(target.root);
		if (st?.isFile() && st.size > MAX_FILE_BYTES) oversized.push(displayPath(target.root, cwd));
	}
	for (const [abs, entry] of files) {
		const st = await statOrNull(abs);
		if (!st?.isFile() || st.size <= MAX_FILE_BYTES) continue;
		const windowEnd = await windowEndLine(abs);
		for (const n of [...entry.lines.keys()]) {
			if (n <= windowEnd) continue;
			if (entry.lines.get(n)!.isMatch) entry.matchCount -= 1;
			entry.lines.delete(n);
		}
		if (entry.matchCount <= 0) files.delete(abs);
	}

	// Per-file cap (silent trim) + encounter-ordered file list.
	let perFileLimitReached = false;
	for (const entry of files.values()) {
		const beforeCap = entry.matchCount;
		capEntry(entry, perFileCap, after);
		if (entry.matchCount < beforeCap) perFileLimitReached = true;
	}
	const fileOrder = [...files.keys()];
	const totalFiles = fileOrder.length;
	// When the fetch cap stopped the walk, files past it were never surfaced —
	// the file total is only a lower bound.
	const totalFilesLabel = limitReached ? `${totalFiles}+` : `${totalFiles}`;
	const canPaginate = isMultiScope;
	const skipFiles = canPaginate ? Math.min(normalizedSkip, totalFiles) : 0;
	const windowFiles = canPaginate ? fileOrder.slice(skipFiles, skipFiles + FILE_LIMIT) : fileOrder;
	const fileLimitReached = canPaginate && totalFiles > skipFiles + FILE_LIMIT;
	const nextSkip = skipFiles + windowFiles.length;
	const limitMessage = fileLimitReached
		? `Showing files ${skipFiles + 1}-${nextSkip} of ${totalFilesLabel}. Use skip=${nextSkip} for the next page, or narrow paths/pattern.`
		: "";

	const missingPathsNote = missing.length > 0 ? `Skipped missing paths: ${missing.join(", ")}` : "";
	const limitMb = Math.floor(MAX_FILE_BYTES / (1024 * 1024));
	const oversizedNote =
		oversized.length > 0
			? `Searched only the first ${limitMb}MB of large files (matches past the ${limitMb}MB window are not shown; use \`read\` for the rest): ${oversized.join(", ")}`
			: "";
	const warningNote = [missingPathsNote, oversizedNote].filter(Boolean).join("\n") || undefined;

	if (windowFiles.length === 0 || files.size === 0) {
		const skipPastEnd = canPaginate && normalizedSkip > 0 && totalFiles > 0 && skipFiles >= totalFiles;
		const noMatchText = skipPastEnd
			? `No more results (${totalFilesLabel} files total; skip=${normalizedSkip} is past the end)`
			: "No matches found";
		const text = warningNote ? `${noMatchText}\n${warningNote}` : noMatchText;
		return textResult(text, {
			pattern,
			caseSensitive: params.case !== false,
			files: [],
			matchCount: 0,
			fileCount: 0,
			missingPaths: missing.length > 0 ? missing : undefined,
		});
	}

	// Mint whole-file snapshot tags (≤ 4 MiB, readable, non-binary) and render.
	const displayed: DisplayFile[] = [];
	let linesTruncated = false;
	for (const abs of windowFiles) {
		const entry = files.get(abs)!;
		let tag: string | undefined;
		const st = await statOrNull(abs);
		if (st?.isFile() && st.size <= TAG_MAX_BYTES) {
			const buffer = await fs.readFile(abs).catch(() => null);
			if (buffer && !isProbablyBinary(buffer)) {
				tag = snapshots.record(abs, normalizeText(buffer.toString("utf8")).text);
			}
		}
		const rows = fileRowLines(entry);
		// Record the rendered N: rows as seen lines (OMP grep parity).
		if (tag !== undefined) {
			const seen: number[] = [];
			for (const row of rows) {
				const m = /^[* ]?(\d+):/.exec(row);
				if (m !== null) seen.push(Number(m[1] as string));
			}
			if (seen.length > 0) snapshots.recordSeenLines(abs, tag, seen);
		}
		for (const row of rows) {
			if (Buffer.byteLength(row, "utf8") >= MAX_COLUMN_BYTES) linesTruncated = true;
		}
		displayed.push({ display: displayPath(abs, cwd), tag, rows, more: entry.more });
	}

	const outputLines = renderModelOutput(displayed, isMultiScope);
	if (limitMessage) outputLines.push("", limitMessage);
	if (warningNote) outputLines.push("", warningNote);
	const matchCount = displayed.reduce(
		(sum, file) => sum + file.rows.reduce((n, row) => (row.startsWith("*") ? n + 1 : n), 0),
		0,
	);
	return textResult(outputLines.join("\n"), {
		pattern,
		caseSensitive: params.case !== false,
		files: displayed.map(file => ({
			path: file.display,
			...(file.tag !== undefined ? { tag: file.tag } : {}),
			rows: rowsForDetails(file),
			...(file.more > 0 ? { more: file.more } : {}),
		})),
		matchCount,
		fileCount: displayed.length,
		truncated: Boolean(fileLimitReached || perFileLimitReached || limitReached || linesTruncated),
		summary: limitMessage || undefined,
		missingPaths: missing.length > 0 ? missing : undefined,
	});
}

/** Re-derive `{n, text, isMatch}` rows for the TUI renderer from `*N:`/` N:` rows. */
function rowsForDetails(file: DisplayFile): Array<{ n: number; text: string; isMatch: boolean }> {
	const rows: Array<{ n: number; text: string; isMatch: boolean }> = [];
	for (const row of file.rows) {
		const match = /^([* ])(\d+):(.*)$/s.exec(row);
		if (!match) continue;
		rows.push({ n: Number.parseInt(match[2]!, 10), text: match[3]!, isMatch: match[1] === "*" });
	}
	return rows;
}
