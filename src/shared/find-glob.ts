/**
 * OMP-aligned pattern/path utilities for the `find` tool.
 *
 * Ported from oh-my-pi `packages/coding-agent/src/tools/path-utils.ts`
 * (`parseFindPattern`, `expandDelimitedPathEntries`, `partitionExistingPaths`,
 * `resolveToCwd`, `formatPathRelativeToCwd`, `toPathList`) so `find` accepts
 * the same inputs and produces the same targets as OMP's `glob` tool.
 * Host paths only — OMP's internal-URL branches (`omp://`, `local://`, ...)
 * have no native-pi equivalent and are not ported.
 */
import * as fss from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

/* ------------------------------ error codes ------------------------------ */

function errorOf(err: unknown): (NodeJS.ErrnoException & { code?: unknown }) | null {
	return err instanceof Error ? (err as NodeJS.ErrnoException) : null;
}

function hasFsCode(err: unknown, code: string): boolean {
	return errorOf(err)?.code === code;
}

export function isEnoent(err: unknown): boolean {
	return hasFsCode(err, "ENOENT") || hasFsCode(err, "ENAMETOOLONG");
}

function isEnotdir(err: unknown): boolean {
	return hasFsCode(err, "ENOTDIR");
}

/* --------------------------- input normalization ------------------------- */

/** Strip matching surrounding double quotes (Windows copy-paste). Single quotes are valid POSIX filename characters. */
export function stripOuterDoubleQuotes(input: string): string {
	return input.startsWith('"') && input.endsWith('"') && input.length > 1 ? input.slice(1, -1) : input;
}

/** Trim + unquote a path-like input (OMP `normalizePathLikeInput`). */
export function normalizePathLikeInput(input: string): string {
	return stripOuterDoubleQuotes(input.trim());
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

/**
 * Treat a leading `@` as shorthand only before well-known path shapes
 * (OMP `normalizeAtPrefix`), so literal names like `@my-file.txt` survive.
 */
function normalizeAtPrefix(filePath: string): string {
	if (!filePath.startsWith("@")) return filePath;
	const withoutAt = filePath.slice(1);
	if (
		withoutAt.startsWith("/") ||
		withoutAt === "~" ||
		withoutAt.startsWith("~/") ||
		path.win32.isAbsolute(withoutAt)
	) {
		return withoutAt;
	}
	return filePath;
}

function stripFileUrl(filePath: string): string {
	if (!filePath.toLowerCase().startsWith("file://")) return filePath;
	try {
		return url.fileURLToPath(filePath);
	} catch {
		return filePath;
	}
}

/** Strip the `\\?\` extended-length prefix (OMP `stripWindowsExtendedLengthPathPrefix`). */
function stripWindowsExtendedLengthPathPrefix(filePath: string): string {
	return filePath.replace(/^\\\\\?\\([a-zA-Z]:|\/)/, "$1");
}

export function expandTilde(filePath: string, home?: string): string {
	const h = home ?? os.homedir();
	if (filePath === "~") return h;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return h + filePath.slice(1);
	}
	if (filePath.startsWith("~")) {
		return path.join(h, filePath.slice(1));
	}
	return filePath;
}

/** POSIX absolute, Windows drive, or UNC (`\\server\share` / `//server/share`). */
export function isFilesystemSourcePath(value: string): boolean {
	return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function isAsciiDriveLetter(value: string): boolean {
	if (value.length !== 1) return false;
	const code = value.charCodeAt(0);
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** `/c/...` or `/mnt/c/...` → `C:\...` on native Windows (OMP `windowsDriveAliasPath`). */
function windowsDriveAliasPath(filePath: string): string | undefined {
	if (!filePath.startsWith("/")) return undefined;
	const parts = filePath.split("/");
	if (parts[0] !== "") return undefined;

	let drive: string | undefined;
	let tailStart = 2;
	if (parts.length >= 2 && isAsciiDriveLetter(parts[1] ?? "")) {
		drive = (parts[1] as string).toUpperCase();
	} else if (parts.length >= 3 && (parts[1] ?? "").toLowerCase() === "mnt" && isAsciiDriveLetter(parts[2] ?? "")) {
		drive = (parts[2] as string).toUpperCase();
		tailStart = 3;
	}
	if (!drive) return undefined;

	const tail = parts.slice(tailStart).filter(Boolean).join("\\");
	return tail ? `${drive}:\\${tail}` : `${drive}:\\`;
}

function isWsl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
	if (platform !== "linux") return false;
	if (env.WSL_DISTRO_NAME || env.WSL_INTERACTIVE) return true;
	try {
		return fss.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
	} catch {
		return false;
	}
}

/** `C:\x\y` → `/mnt/c/x/y` under WSL (OMP `windowsPathToWslMount`). */
function windowsPathToWslMount(filePath: string): string | undefined {
	const match = /^([A-Za-z]):[\\/](.*)$/.exec(filePath);
	if (!match) return undefined;
	const drive = match[1].toLowerCase();
	const tail = match[2].replace(/\\/g, "/").replace(/^\/+/, "");
	return tail ? `/mnt/${drive}/${tail}` : `/mnt/${drive}`;
}

/** Reconcile drive-alias paths with the host (OMP `normalizeWindowsDriveAliasPath`). */
export function normalizeWindowsDriveAliasPath(
	filePath: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform === "win32") return windowsDriveAliasPath(filePath) ?? filePath;
	if (isWsl(platform, env)) return windowsPathToWslMount(filePath) ?? filePath;
	return filePath;
}

/**
 * Full model-supplied-path expansion (OMP `expandPath`): stray leading `:`
 * before a path shape, `\\?\` prefix, unicode spaces, `@` shorthand,
 * `file://` URLs, and `~`.
 */
export function expandPath(filePath: string): string {
	const deColoned = /^:(?=[/\\~]|\.\.?[/\\]|[A-Za-z]:)/.test(filePath) ? filePath.slice(1) : filePath;
	const normalized = stripWindowsExtendedLengthPathPrefix(
		stripFileUrl(normalizeAtPrefix(deColoned.replace(UNICODE_SPACES, " "))),
	);
	return expandTilde(normalized);
}

/**
 * Resolve a path relative to `cwd` with the workspace-root alias: a bare `/`
 * (or `//`) means the session cwd, never the filesystem root
 * (OMP `resolveToCwd`).
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = normalizeWindowsDriveAliasPath(expandPath(filePath));
	if (/^\/+$/.test(expanded)) {
		return cwd;
	}
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

/** Search root for a parsed base path (OMP `resolveSearchBase`, host paths only). */
export function resolveSearchBase(basePath: string, cwd: string): string {
	return resolveToCwd(basePath, cwd);
}

function normalizePosixPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

/**
 * Display form of a path: cwd-relative when inside cwd (cwd itself → `.`),
 * absolute otherwise; optional trailing slash for directories.
 * OMP `formatPathRelativeToCwd`.
 */
export function formatPathRelativeToCwd(
	filePath: string,
	cwd: string,
	options: { trailingSlash?: boolean } = {},
): string {
	const resolvedCwd = path.resolve(cwd);
	const expanded = expandPath(filePath);
	const resolvedPath = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
	const relative = path.relative(resolvedCwd, resolvedPath);
	const isWithinCwd = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	let displayPath = normalizePosixPath(isWithinCwd ? relative || "." : resolvedPath);
	if (options.trailingSlash && displayPath !== "." && !displayPath.endsWith("/")) {
		displayPath += "/";
	}
	return displayPath;
}

/** Comma-joined display of a multi-path scope (OMP `toScopeDisplay`). */
export function toScopeDisplay(items: string[], cwd: string): string {
	return items
		.map(item =>
			formatPathRelativeToCwd(item, cwd, {
				trailingSlash: item.endsWith("/") || item.endsWith("\\"),
			}),
		)
		.join(", ");
}

/* ---------------------------- toPathList port ---------------------------- */

/**
 * Parse a JSON-encoded array of path strings (e.g. `'["a.ts","b.ts"]'`).
 * Returns `null` when the input is not a bracketed JSON string array, so the
 * caller falls back to treating the input as a single literal path.
 * OMP `parseStringEncodedPathArray`.
 */
function parseStringEncodedPathArray(input: string): string[] | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== "string")) {
		return null;
	}
	return parsed;
}

/**
 * Normalize a path argument that may arrive as a single string, a JSON-encoded
 * string array (`'["a.ts"]'`), or an actual array into a flat `string[]`.
 * Delimited single strings (`"a.ts b.ts"`) remain literal (delimited
 * expansion happens later, with existence checks). OMP `toPathList`.
 */
export function toPathList(input: string | string[] | undefined): string[] {
	if (typeof input === "string") return parseStringEncodedPathArray(input) ?? [input];
	return input ?? [];
}

/* ---------------------------- find-pattern split ------------------------- */

const GLOB_PATH_CHARS = ["*", "?", "[", "{"] as const;

export function hasGlobPathChars(filePath: string): boolean {
	return GLOB_PATH_CHARS.some(char => filePath.includes(char));
}

/** Index of the first segment at or after `from` holding glob metacharacters; -1 when none does. */
function firstGlobSegment(segments: readonly string[], from = 0): number {
	for (let i = from; i < segments.length; i++) {
		if (hasGlobPathChars(segments[i] ?? "")) return i;
	}
	return -1;
}

export interface ParsedFindPattern {
	basePath: string;
	globPattern: string;
	hasGlob: boolean;
}

/**
 * Parse a find pattern into a base directory path and a glob pattern
 * (OMP `parseFindPattern`). No glob chars: base = path with the implicit
 * all-entries pattern. Glob in the first segment: base `.`, pattern made
 * recursive. Glob later: split at the first glob-bearing segment; the glob
 * tail keeps its scope (`dir/*` stays non-recursive).
 */
// Examples:
//   `src/app/**/*.tsx` -> { basePath: "src/app", globPattern: "**/*.tsx", hasGlob: true }
//   `src/app/*.tsx`    -> { basePath: "src/app", globPattern: "*.tsx", hasGlob: true }
//   `*.ts`             -> { basePath: ".", globPattern: "**/*.ts", hasGlob: true }
//   `src/app`          -> { basePath: "src/app", globPattern: "**/*", hasGlob: false }
export function parseFindPattern(pattern: string): ParsedFindPattern {
	const normalizedPattern = normalizePosixPath(pattern);
	const segments = normalizedPattern.split("/");
	const firstGlobIndex = firstGlobSegment(segments);

	if (firstGlobIndex === -1) {
		return { basePath: normalizedPattern, globPattern: "**/*", hasGlob: false };
	}

	if (firstGlobIndex === 0) {
		// A bare top-level glob is made recursive: `*.ts` becomes `**/*.ts`.
		const needsRecursive = !normalizedPattern.startsWith("**/");
		return {
			basePath: ".",
			globPattern: needsRecursive ? `**/${normalizedPattern}` : normalizedPattern,
			hasGlob: true,
		};
	}

	// A glob later in the path keeps its scope: `dir/*` stays non-recursive.
	return {
		basePath: segments.slice(0, firstGlobIndex).join("/"),
		globPattern: segments.slice(firstGlobIndex).join("/"),
		hasGlob: true,
	};
}

/* ----------------------- delimited-entry expansion ----------------------- */

type PathEntrySplitter = (item: string) => { basePath: string };

const TOP_LEVEL_WHITESPACE_RE = /\s/;

type DelimitedPathSplitMode = "comma" | "semicolon" | "whitespace" | "mixed";

function isDelimitedPathSeparator(ch: string, mode: DelimitedPathSplitMode): boolean {
	if (mode === "comma") return ch === ",";
	if (mode === "semicolon") return ch === ";";
	if (mode === "whitespace") return TOP_LEVEL_WHITESPACE_RE.test(ch);
	return ch === "," || ch === ";" || TOP_LEVEL_WHITESPACE_RE.test(ch);
}

function hasTopLevelPathDelimiter(entry: string): boolean {
	let braceDepth = 0;
	for (let i = 0; i < entry.length; i++) {
		const ch = entry[i];
		if (ch === "\\" && i + 1 < entry.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth === 0 && (ch === "," || ch === ";" || TOP_LEVEL_WHITESPACE_RE.test(ch))) {
			return true;
		}
	}
	return false;
}

function splitTopLevelDelimitedPath(entry: string, mode: DelimitedPathSplitMode): string[] {
	const parts: string[] = [];
	let braceDepth = 0;
	let start = 0;
	for (let i = 0; i < entry.length; i++) {
		const ch = entry[i];
		if (ch === "\\" && i + 1 < entry.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth !== 0 || !isDelimitedPathSeparator(ch, mode)) continue;
		parts.push(entry.slice(start, i));
		start = i + 1;
	}
	parts.push(entry.slice(start));
	return parts;
}

async function delimitedPathPartResolves(entry: string, cwd: string, splitter: PathEntrySplitter): Promise<boolean> {
	const peeled = splitPathAndSel(entry).path;
	const { basePath } = splitter(peeled);
	const absoluteBasePath = resolveToCwd(basePath, cwd);
	try {
		await fs.stat(absoluteBasePath);
		return true;
	} catch (err) {
		// ENOENT/ENAMETOOLONG: this string cannot name an existing path, so the
		// delimited split may proceed. Other errors (EACCES, transient I/O) stay fatal.
		if (isEnoent(err)) return false;
		throw err;
	}
}

type DelimitedResolveRequirement = "all" | "some" | "none";

/**
 * How many split parts must resolve for the split to win: semicolon splits
 * unconditionally (the documented list delimiter — an all-missing list must
 * still fan out so multi-path missing semantics can name every entry), comma
 * needs at least one part, whitespace/mixed need every part.
 */
async function tryDelimitedPathSplit(
	entry: string,
	cwd: string,
	splitter: PathEntrySplitter,
	mode: DelimitedPathSplitMode,
	requirement: DelimitedResolveRequirement,
): Promise<string[] | null> {
	const rawParts = splitTopLevelDelimitedPath(entry, mode);
	if (rawParts.length < 2) return null;

	const parts = rawParts.map(normalizePathLikeInput).filter(part => part.length > 0);
	if (parts.length === 0) return null;
	if (parts.length < 2 && rawParts.length === parts.length) return null;

	if (requirement !== "none") {
		const resolved = await Promise.all(parts.map(part => delimitedPathPartResolves(part, cwd, splitter)));
		const valid = requirement === "all" ? resolved.every(Boolean) : resolved.some(Boolean);
		if (!valid) return null;
	}
	return parts;
}

/* ------------------- conservative read-selector peel --------------------- */

const LINE_RANGE_CHUNK_SOURCE = String.raw`L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?`;
const RANGE_SELECTOR_CHUNK = `${LINE_RANGE_CHUNK_SOURCE}(?<=[\\d.-])`;
const RANGE_LIST_SRC = `${RANGE_SELECTOR_CHUNK}(?:,${RANGE_SELECTOR_CHUNK})*`;
const TAIL_CHUNK_SRC = String.raw`-\d+`;
const FILE_LINE_RANGE_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|${TAIL_CHUNK_SRC}|raw|conflicts|img)$`, "i");
const FILE_LINE_RANGE_ONLY_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|${TAIL_CHUNK_SRC})$`, "i");
const FILE_RAW_ONLY_RE = /^raw$/i;

/**
 * Peel a strict read-selector tail (`:5-10`, `:raw`, ...) off a path-like
 * string; a colon that does not begin a selector-shaped chunk stays literal
 * (files named `a:1` are legal). OMP `splitPathAndSel`, host-path branch.
 */
export function splitPathAndSel(rawPath: string): { path: string; sel?: string } {
	const colon = rawPath.lastIndexOf(":");
	if (colon <= 0) return { path: rawPath };

	const candidate = rawPath.slice(colon + 1);
	if (!FILE_LINE_RANGE_RE.test(candidate)) return { path: rawPath };

	let basePath = rawPath.slice(0, colon);
	let sel = candidate;

	// Compound trailing selector: `path:1-50:raw` / `path:raw:1-50`.
	const innerColon = basePath.lastIndexOf(":");
	if (innerColon > 0) {
		const innerCandidate = basePath.slice(innerColon + 1);
		const innerIsRaw = FILE_RAW_ONLY_RE.test(innerCandidate);
		const outerIsRaw = FILE_RAW_ONLY_RE.test(candidate);
		const innerIsRange = FILE_LINE_RANGE_ONLY_RE.test(innerCandidate);
		const outerIsRange = FILE_LINE_RANGE_ONLY_RE.test(candidate);
		if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
			sel = `${innerCandidate}:${candidate}`;
			basePath = basePath.slice(0, innerColon);
		}
	}

	return { path: basePath, sel };
}

/**
 * Three-way probe for whether the exact entry named by `filePath` exists
 * (OMP `probeLiteralPathExists`): a confirmed `lstat` beats any delimiter
 * interpretation, ambiguous errors stay `"unknown"`.
 */
export async function probeLiteralPathExists(filePath: string, cwd: string): Promise<"exists" | "missing" | "unknown"> {
	const resolved = resolveToCwd(filePath, cwd);
	try {
		await fs.lstat(resolved);
		return "exists";
	} catch (err) {
		if (isEnoent(err) || isEnotdir(err)) return "missing";
		return "unknown";
	}
}

/**
 * Split one path-like entry whose multiple targets were flattened into one
 * string. Existing paths are kept intact, so real filenames containing
 * spaces, commas, or semicolons win over delimiter recovery.
 * OMP `splitDelimitedPathEntry` (host-path branch: no internal URLs).
 */
export async function splitDelimitedPathEntry(
	entry: string,
	cwd: string,
	options: { splitter?: PathEntrySplitter } = {},
): Promise<string[] | null> {
	const normalizedEntry = normalizePathLikeInput(entry);
	if (!hasTopLevelPathDelimiter(normalizedEntry)) return null;
	const splitter = options.splitter ?? parseFindPattern;
	// A real POSIX file may contain a delimiter and a selector-shaped tail
	// (`a;b:1-2`, `a b:1-2`). Preserve the raw entry whenever the full literal
	// resolves — or is only ambiguous.
	if ((await probeLiteralPathExists(normalizedEntry, cwd)) !== "missing") return null;
	const selectorSplit = splitPathAndSel(normalizedEntry);
	const peeledEntry = selectorSplit.path;
	// A range may instead target a literal file whose name combines delimiters
	// with glob syntax (`a;b[1].md:1-2`). Check the exact peeled path first.
	if (selectorSplit.sel !== undefined && (await probeLiteralPathExists(peeledEntry, cwd)) !== "missing") return null;
	if (!hasGlobPathChars(peeledEntry) && (await delimitedPathPartResolves(normalizedEntry, cwd, splitter))) {
		return null;
	}

	return (
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "semicolon", "none")) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "comma", "some")) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "whitespace", "all")) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "mixed", "all"))
	);
}

/** Expand delimited entries in-place while preserving unsplit entries (OMP `expandDelimitedPathEntries`). */
export async function expandDelimitedPathEntries(
	entries: readonly string[],
	cwd: string,
	options: { splitter?: PathEntrySplitter } = {},
): Promise<string[]> {
	const expanded: string[] = [];
	for (const entry of entries) {
		const normalizedEntry = normalizePathLikeInput(entry);
		const split = await splitDelimitedPathEntry(normalizedEntry, cwd, options);
		if (split) expanded.push(...split);
		else expanded.push(normalizedEntry);
	}
	return expanded;
}

/* ------------------------------ missing paths ---------------------------- */

export interface PartitionedPaths {
	/** Raw input strings whose resolved base path exists. */
	valid: string[];
	/** Raw input strings whose resolved base path is missing (ENOENT). */
	missing: string[];
}

/**
 * Stat each input's base path concurrently; return entries split by
 * existence (OMP `partitionExistingPaths`). ENOENT is the only swallowed
 * error — every other stat failure propagates so callers do not silently
 * skip paths that exist but are unreadable.
 */
export async function partitionExistingPaths(
	items: string[],
	cwd: string,
	splitter: (item: string) => { basePath: string },
): Promise<PartitionedPaths> {
	const settled = await Promise.all(
		items.map(async item => {
			const { basePath } = splitter(item);
			try {
				await fs.stat(resolveSearchBase(basePath, cwd));
				return { item, exists: true } as const;
			} catch (err) {
				if (isEnoent(err)) return { item, exists: false } as const;
				throw err;
			}
		}),
	);
	const valid: string[] = [];
	const missing: string[] = [];
	for (const entry of settled) {
		if (entry.exists) valid.push(entry.item);
		else missing.push(entry.item);
	}
	return { valid, missing };
}

/* ------------------------------ glob helpers ----------------------------- */

/**
 * Close unclosed `{` alternation groups (LLMs emit `*.{ts,js`); the native
 * walker does the same inside `build_glob_pattern`.
 */
export function fixUnclosedBraces(pattern: string): string {
	const opens = (pattern.match(/\{/g) ?? []).length;
	const closes = (pattern.match(/\}/g) ?? []).length;
	if (opens <= closes) return pattern;
	let fixed = pattern;
	for (let i = 0; i < opens - closes; i++) fixed += "}";
	return fixed;
}

/** Whether a pattern explicitly mentions `node_modules` (OMP `mentions_node_modules`). */
export function mentionsNodeModules(pattern: string): boolean {
	return pattern.includes("node_modules");
}

/**
 * Final pattern handed to the matcher (OMP `build_glob_pattern` with
 * `recursive: false`): separators normalized, empty → `*`, braces closed.
 */
export function normalizeGlobPattern(pattern: string): string {
	const normalized = pattern.trim().replace(/\\/g, "/");
	const base = normalized === "" ? "*" : normalized;
	return fixUnclosedBraces(base);
}
