/**
 * `find` tool: glob-based path lookup with OMP `glob` tool semantics
 * (oh-my-pi `packages/coding-agent/src/tools/glob.ts`).
 *
 * Engines: ripgrep's file walker (`rg --files`, exact gitignore semantics)
 * paired with a JS directory/symlink walker (rg lists regular files only;
 * OMP's native glob walker also emits directories and symlinks), then
 * tinyglobby as the last resort without rg. Both engines implement the same
 * contract as OMP's native walker: files + directories + symlinks, `.git`
 * always skipped, `node_modules` only when mentioned, hidden/gitignore
 * gates, depth-bounded walks for non-`**` patterns, mtime-desc ranking
 * (path-ascending tiebreak), and a 5s timeout that returns partial results
 * with an incomplete-scan notice instead of failing.
 *
 * Contract (mirrors OMP): `hidden`/`gitignore` default true; `limit` defaults
 * to 200 and clamps to 1..200 with a notice; bare top-level globs match at
 * any depth while `dir/*` stays one level; each path is
 * its own walk root; multi-path calls skip missing entries and name them;
 * single missing paths throw `Path not found: …`; a bare `/` means the
 * session cwd; scans time out at 5s and return partial matches with an
 * incomplete-scan notice instead of failing; output is a prefix-folded tree
 * (`#` per level, dirs end `/`) newest-first.
 */
import picomatch from "picomatch";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolError, textResult, type ToolCtx, type ToolResult, type ToolUpdate } from "../host.ts";
import { walkDepthBound, walkDirEntries } from "../shared/dir-walk.ts";
import {
	expandDelimitedPathEntries,
	isEnoent,
	normalizeGlobPattern,
	normalizePathLikeInput,
	partitionExistingPaths,
	parseFindPattern,
	mentionsNodeModules,
	formatPathRelativeToCwd,
	resolveSearchBase,
	toPathList,
	toScopeDisplay,
} from "../shared/find-glob.ts";
import { formatGroupedPaths } from "../shared/path-tree.ts";
import { hasBinary, rgIgnoreFlags, run, statOrNull } from "../shared/util.ts";

export interface FindParams {
	path?: string | string[];
	hidden?: boolean;
	gitignore?: boolean;
	limit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
const GLOB_TIMEOUT_MS = 5000;
const OUTPUT_MAX_BYTES = 50 * 1024;
/** Fallback scans stat-rank up to this many candidates before sorting by mtime. */
const FALLBACK_STAT_CAP = 20_000;
/** Stat concurrency for the ranking phase (parallel to keep large result sets under the timeout budget). */
const RANK_CONCURRENCY = 256;

interface FindTarget {
	searchPath: string;
	globPattern: string;
	hasGlob: boolean;
}

interface PreparedTarget {
	target: FindTarget;
	result?: Array<{ path: string; mtime: number }>;
}

/**
 * Keep whole lines from the head under a UTF-8 byte budget (OMP `truncateHead`
 * with its line cap disabled — bytes are the practical cap). A first line that
 * alone exceeds the budget yields empty output, as in OMP.
 */
function truncateHeadLines(content: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(content, "utf8") <= maxBytes) return { text: content, truncated: false };
	const kept: string[] = [];
	let used = 0;
	for (const line of content.split("\n")) {
		const cost = (kept.length > 0 ? 1 : 0) + Buffer.byteLength(line, "utf8");
		if (kept.length === 0 ? cost > maxBytes : used + cost > maxBytes) break;
		kept.push(line);
		used += cost;
	}
	return { text: kept.join("\n"), truncated: true };
}

type GlobMatcher = (relativePath: string) => boolean;

/** Compile the pattern filter for one target (OMP: globset with literal separators). */
function compileMatcher(patterns: string[], hidden: boolean): GlobMatcher {
	if (patterns.length === 0) return line => line.length > 0; // implicit `**/*`
	const matcher = picomatch(patterns, { dot: hidden });
	return line => matcher(line);
}

/**
 * rg walker: `rg --files` supplies the gitignore/hidden-aware file list
 * (regular files only), the target pattern filters the root-relative output.
 * Non-recursive scoped patterns are kept exact (`src/*.ts` never matches
 * `src/sub/nested.ts`), like the native walker with `recursive: false`. On
 * timeout the partial stdout is salvaged: rg prints paths as it walks, so
 * the complete lines up to the kill are real matches (OMP drains its
 * partial matches instead of failing the scan).
 */
async function ripgrepScan(
	patterns: string[],
	base: string,
	hidden: boolean,
	gitignore: boolean,
	mentionsNm: boolean,
	deadlineMs: number,
	signal?: AbortSignal,
): Promise<{ paths: string[]; timedOut: boolean }> {
	const matcher = compileMatcher(patterns, hidden);
	const args = ["--files"];
	if (hidden) args.push("--hidden");
	if (gitignore) args.push(...(await rgIgnoreFlags(base)));
	else args.push("--no-ignore");
	args.push("-g", "!.git");
	if (!mentionsNm) args.push("-g", "!**/node_modules/**");
	const result = await run("rg", args, {
		cwd: base,
		signal,
		timeoutMs: Math.max(1, deadlineMs - Date.now()),
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.timedOut) {
		// Salvage the complete lines rg already printed. A trailing partial
		// line is dropped — the kill can land mid-path.
		let stdout = result.stdout;
		if (stdout.length > 0 && !stdout.endsWith("\n")) {
			const lastNewline = stdout.lastIndexOf("\n");
			stdout = lastNewline >= 0 ? stdout.slice(0, lastNewline) : "";
		}
		return { paths: parseRgLines(stdout, base, matcher), timedOut: true };
	}
	if (result.code === 2 && !result.stdout.trim()) {
		throw new ToolError(`rg --files error: ${result.stderr.trim().split("\n")[0] ?? "unknown"}`);
	}
	return { paths: parseRgLines(result.stdout, base, matcher), timedOut: false };
}

/** Filter root-relative `rg --files` output lines through the pattern matcher. */
function parseRgLines(stdout: string, base: string, matcher: GlobMatcher): string[] {
	const paths: string[] = [];
	for (const line of stdout.split("\n")) {
		const rel = line.replace(/\\/g, "/");
		if (rel && matcher(rel)) paths.push(path.resolve(base, rel));
	}
	return paths;
}

/**
 * Root-level gitignore approximations for the tinyglobby branch (the pinned
 * tinyglobby has no `gitignore` option): read `.gitignore` and
 * `.git/info/exclude` at the scan root and translate git patterns into
 * fast-glob-style `ignore` entries. Nested `.gitignore` files and negations
 * are not applied — this branch is the last resort, reached only when rg is
 * not on PATH.
 */
async function rootIgnorePatterns(base: string): Promise<string[]> {
	const patterns: string[] = [];
	const sources = [path.join(base, ".gitignore"), path.join(base, ".git", "info", "exclude")];
	for (const source of sources) {
		let content: string;
		try {
			content = await fs.readFile(source, "utf8");
		} catch {
			continue;
		}
		for (const raw of content.split("\n")) {
			const line = raw.replace(/\r$/, "").trim();
			if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
			// `!` negations are skipped above; git's `!pattern` cannot be
			// expressed as an exclusion-only `ignore` list.
			const anchored = line.startsWith("/");
			const pattern = line.replace(/^\/+/, "").replace(/\/+$/, "");
			if (pattern.length === 0) continue;
			const isDirectory = line.endsWith("/");
			if (anchored || pattern.includes("/")) {
				patterns.push(pattern);
				if (isDirectory) patterns.push(`${pattern}/**`);
			} else {
				patterns.push(`**/${pattern}`);
				if (isDirectory) patterns.push(`**/${pattern}/**`);
			}
		}
	}
	return patterns;
}

/** tinyglobby fallback (last resort when rg is not on PATH). */
async function tinyglobbyScan(
	patterns: string[],
	base: string,
	hidden: boolean,
	gitignore: boolean,
	mentionsNm: boolean,
): Promise<string[]> {
	const ignore = ["**/.git", "**/.git/**"];
	if (!mentionsNm) ignore.push("**/node_modules", "**/node_modules/**");
	if (gitignore) ignore.push(...(await rootIgnorePatterns(base)));
	const { glob } = await import("tinyglobby");
	const matches = await glob(patterns.length > 0 ? patterns : ["**/*"], {
		cwd: base,
		dot: hidden,
		onlyFiles: false,
		ignore,
		absolute: true,
	});
	return matches;
}

/** Stat the candidates for mtime + directory detection (newest-first ordering). */
async function rankCandidates(absolutePaths: string[]): Promise<Array<{ path: string; mtime: number; isDir: boolean }>> {
	const unique = [...new Set(absolutePaths.map(p => path.resolve(p)))];
	const capped = unique.length > FALLBACK_STAT_CAP ? unique.slice(0, FALLBACK_STAT_CAP) : unique;
	const ranked: Array<{ path: string; mtime: number; isDir: boolean }> = new Array(capped.length);
	for (let i = 0; i < capped.length; i += RANK_CONCURRENCY) {
		const chunk = capped.slice(i, i + RANK_CONCURRENCY);
		await Promise.all(
			chunk.map(async (abs, j) => {
				const stat = await statOrNull(abs);
				ranked[i + j] = { path: abs, isDir: stat?.isDirectory() ?? false, mtime: stat?.mtimeMs ?? 0 };
			}),
		);
	}
	ranked.sort(compareByMtimeDesc);
	return ranked;
}

/** OMP ranking: mtime descending, path ascending as the deterministic tiebreak. */
function compareByMtimeDesc(a: { path: string; mtime: number }, b: { path: string; mtime: number }): number {
	return b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function executeFind(
	params: FindParams,
	ctx?: ToolCtx,
	signal?: AbortSignal,
	onUpdate?: ToolUpdate,
): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	const { path: pathInput, limit, hidden, gitignore } = params;

	if (signal?.aborted) throw new ToolError("Aborted");

	// Input normalization (OMP): optional list input → per-entry delimited
	// expansion (literal paths containing delimiters stay intact) → unquote,
	// slash-normalize, and remap slash-only inputs (`/`) to the session cwd.
	const scopedPaths = toPathList(pathInput);
	const effectivePaths = scopedPaths.length > 0 ? scopedPaths : ["."];
	const rawPatternInputs = await expandDelimitedPathEntries(effectivePaths, cwd, { splitter: parseFindPattern });
	const rawPatterns = rawPatternInputs.map(input => normalizePathLikeInput(input).replace(/\\/g, "/"));
	const aliasResolvedPatterns = rawPatterns.map(pattern => (/^\/+$/.test(pattern) ? "." : pattern));
	if (aliasResolvedPatterns.some(pattern => /^\/+$/.test(pattern))) {
		throw new ToolError("Searching from root directory '/' is not allowed");
	}
	if (aliasResolvedPatterns.some(pattern => pattern.length === 0)) {
		throw new ToolError("`path` must contain non-empty globs or paths");
	}

	// Tolerate missing entries in a multi-path call: skip ones whose base
	// directory is gone, and only error if every entry is missing. A single
	// missing path keeps the hard ENOENT semantics.
	let missingPaths: string[] = [];
	let effectivePatterns = aliasResolvedPatterns;
	if (aliasResolvedPatterns.length > 1) {
		const partition = await partitionExistingPaths(aliasResolvedPatterns, cwd, parseFindPattern);
		if (partition.valid.length === 0) {
			throw new ToolError(`Path not found: ${partition.missing.join(", ")}`);
		}
		effectivePatterns = partition.valid;
		missingPaths = partition.missing;
	}

	const isSingle = effectivePatterns.length <= 1;
	// Walk each user path as its own root: collapsing to a shared base would
	// force the walker to traverse every unrelated sibling under the ancestor.
	const targets: FindTarget[] = effectivePatterns.map(pattern => {
		const parsed = parseFindPattern(pattern);
		return {
			searchPath: resolveSearchBase(parsed.basePath, cwd),
			globPattern: normalizeGlobPattern(parsed.globPattern),
			hasGlob: parsed.hasGlob,
		};
	});
	const scopePath = isSingle
		? formatPathRelativeToCwd(targets[0]?.searchPath ?? ".", cwd)
		: toScopeDisplay(effectivePatterns, cwd);

	for (const target of targets) {
		if (target.searchPath === "/") {
			throw new ToolError("Searching from root directory '/' is not allowed");
		}
	}

	const requestedLimit = limit ?? DEFAULT_LIMIT;
	if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
		throw new ToolError("Limit must be a positive number");
	}
	const effectiveLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(requestedLimit)));
	// A request above the hard cap is silently reduced by applyListLimit; say
	// so up front so `limit=1000` does not read as "200 is all there is".
	const clampNotice = requestedLimit > MAX_LIMIT ? `Requested limit ${requestedLimit} clamped to the max of ${MAX_LIMIT}` : undefined;
	const includeHidden = hidden ?? true;
	const useGitignore = gitignore ?? true;
	const timeoutMs = GLOB_TIMEOUT_MS;
	const deadlineMs = Date.now() + timeoutMs;

	const missingPathsNote = missingPaths.length > 0 ? `Skipped missing paths: ${missingPaths.join(", ")}` : undefined;

	const buildResult = (files: string[], opts?: { notice?: string; forceTruncated?: boolean; timedOut?: boolean }): ToolResult => {
		const notice = opts?.notice;
		const forceTruncated = opts?.forceTruncated ?? false;
		if (files.length === 0) {
			// A timed-out empty result is an incomplete scan, not a verified
			// absence — never emit "No files found" next to a timeout notice.
			const parts = opts?.timedOut ? [] : ["No files found matching pattern"];
			if (notice) parts.push(notice);
			if (missingPathsNote) parts.push(missingPathsNote);
			return textResult(parts.join("\n"), {
				scopePath,
				fileCount: 0,
				files: [],
				truncated: forceTruncated,
				cwd,
				missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
			});
		}
		// Re-cap at the limit (a global re-sort can exceed it across roots).
		const limited = files.length >= effectiveLimit ? files.slice(0, effectiveLimit) : files;
		const limitReached = files.length >= effectiveLimit;
		const baseOutput = formatGroupedPaths(limited);
		const trailingNotes: string[] = [];
		if (notice) trailingNotes.push(notice);
		if (clampNotice) trailingNotes.push(clampNotice);
		if (missingPathsNote) trailingNotes.push(missingPathsNote);
		const rawOutput = trailingNotes.length > 0 ? `${baseOutput}\n\n${trailingNotes.join("\n")}` : baseOutput;
		const capped = truncateHeadLines(rawOutput, OUTPUT_MAX_BYTES);
		// The limit notice is appended after the byte cap, the way OMP's
		// session layer appends the formatted output-meta notice. At the hard
		// cap there is no larger usable limit, so the advice is suppressed
		// rather than naming a value that clamps right back (OMP #13263).
		const limitNotice = limitReached
			? effectiveLimit >= MAX_LIMIT
				? `[${effectiveLimit} results limit reached]`
				: `[${effectiveLimit} results limit reached. Use limit=${Math.min(effectiveLimit * 2, MAX_LIMIT)} for more]`
			: undefined;
		const details: Record<string, unknown> = {
			scopePath,
			fileCount: limited.length,
			files: limited,
			truncated: Boolean(forceTruncated || limitReached || capped.truncated),
			cwd,
			resultLimitReached: limitReached ? effectiveLimit : undefined,
		};
		if (missingPaths.length > 0) details.missingPaths = missingPaths;
		return textResult(limitNotice ? `${capped.text}\n\n${limitNotice}` : capped.text, details);
	};

	// Prep targets concurrently: exact file inputs return immediately, missing
	// single inputs throw `Path not found`, non-directories are rejected.
	const preparedTargets: PreparedTarget[] = await Promise.all(
		targets.map(async target => {
			if (signal?.aborted) throw new ToolError("Aborted");
			let stat;
			try {
				stat = await fs.stat(target.searchPath);
			} catch (err) {
				if (isEnoent(err)) {
					if (isSingle) throw new ToolError(`Path not found: ${scopePath}`);
					return { target, result: [] };
				}
				throw err;
			}
			if (!target.hasGlob && stat.isFile()) {
				return { target, result: [{ path: formatPathRelativeToCwd(target.searchPath, cwd), mtime: stat.mtimeMs }] };
			}
			if (!stat.isDirectory()) {
				if (isSingle) throw new ToolError(`Path is not a directory: ${target.searchPath}`);
				return { target, result: [] };
			}
			return { target };
		}),
	);
	if (signal?.aborted) throw new ToolError("Aborted");


	const useRg = await hasBinary("rg");

	const runTarget = async (prepared: PreparedTarget): Promise<{ entries: Array<{ path: string; mtime: number }>; timedOut: boolean }> => {
		if (prepared.result) return { entries: prepared.result, timedOut: false };
		const { target } = prepared;
		if (signal?.aborted) throw new ToolError("Aborted");
		const patterns = target.hasGlob ? [target.globPattern] : [];
		const mentionsNm = mentionsNodeModules(target.globPattern);

		if (useRg) {
			// rg owns the regular files (exact gitignore/hidden semantics);
			// the JS walker supplies the directories and symlinks `rg --files`
			// never lists, with the same pruning as the native walker.
			const matcher = compileMatcher(patterns, includeHidden);
			const [files, dirs] = await Promise.all([
				// The 5s bound is the internal deadline kill in `run` (which
				// `ripgrepScan` salvages as a timeout); the caller signal is for
				// aborts only and must not carry a timeout of its own.
				ripgrepScan(patterns, target.searchPath, includeHidden, useGitignore, mentionsNm, deadlineMs, signal),
				walkDirEntries({
					root: target.searchPath,
					hidden: includeHidden,
					gitignore: useGitignore,
					includeNodeModules: mentionsNm,
					maxDepth: walkDepthBound(target.globPattern),
					deadlineMs,
					matcher,
				}),
			]);
			if (signal?.aborted) throw new ToolError("Aborted");
			const ranked = await rankCandidates(files.paths);
			const entries = [
				...ranked,
				...dirs.entries.map(entry => ({ path: entry.path, mtime: entry.mtime, isDir: entry.isDir })),
			];
			entries.sort(compareByMtimeDesc);
			return {
				entries: entries.map(entry => ({ path: formatPathRelativeToCwd(entry.path, cwd, { trailingSlash: entry.isDir }), mtime: entry.mtime })),
				timedOut: files.timedOut || dirs.timedOut,
			};
		}

		// Last resort: tinyglobby (files and directories via onlyFiles:false).
		// The scan cannot be cancelled mid-glob, so a deadline sentinel detaches
		// the tool from an over-budget scan (OMP: 5s bound + incomplete-scan
		// notice, never an error).
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const sentinel = new Promise<"timeout" | "aborted">(resolve => {
			const finish = (value: "timeout" | "aborted"): void => {
				clearTimeout(timer);
				if (onAbort && signal) signal.removeEventListener("abort", onAbort);
				resolve(value);
			};
			timer = setTimeout(() => finish("timeout"), Math.max(1, deadlineMs - Date.now()));
			if (signal) {
				if (signal.aborted) {
					finish("aborted");
					return;
				}
				onAbort = () => finish("aborted");
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
		const scanPromise = tinyglobbyScan(patterns, target.searchPath, includeHidden, useGitignore, mentionsNm);
		// The scan keeps running after the sentinel wins; swallow a late
		// rejection so it cannot crash the host process.
		scanPromise.catch(() => undefined);
		try {
			const won = await Promise.race([scanPromise, sentinel]);
			if (won === "aborted" || signal?.aborted) throw new ToolError("Aborted");
			if (won === "timeout") return { entries: [], timedOut: true };
			const ranked = await rankCandidates(won);
			return {
				entries: ranked.map(entry => ({ path: formatPathRelativeToCwd(entry.path, cwd, { trailingSlash: entry.isDir }), mtime: entry.mtime })),
				timedOut: false,
			};
		} finally {
			clearTimeout(timer);
		}
	};

	const settledTargets = await Promise.allSettled(preparedTargets.map(runTarget));
	const perTarget = settledTargets.map(result => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
	const timedOut = perTarget.some(result => result.timedOut);

	// Merge per-target results: each target's own matches are already
	// mtime-ranked, so dedup plus a global mtime re-sort yields the
	// correct top-N across all roots.
	const seen = new Set<string>();
	const merged: Array<{ path: string; mtime: number }> = [];
	for (const group of perTarget) {
		for (const entry of group.entries) {
			if (seen.has(entry.path)) continue;
			seen.add(entry.path);
			merged.push(entry);
		}
	}
	merged.sort(compareByMtimeDesc);

	if (timedOut) {
		// A timeout is an incomplete scan, not an error: return what settled
		// (salvaged partial matches from the killed walk, plus results from
		// completed targets) instead of throwing — empty results after a
		// multi-second wait force the caller to retry blind, which is the
		// worst possible outcome.
		const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
		// Walk cost tracks directory-tree size, not pattern specificity: an
		// mtime-ranked scan cannot early-exit, so a "narrow" pattern over a huge
		// tree still times out. Say so instead of implying the pattern was broad.
		const notice =
			merged.length > 0
				? `glob timed out after ${seconds}s; returning ${merged.length} partial matches — results are incomplete, scope to a deeper directory instead of retrying blindly`
				: `Glob timed out after ${seconds}s before finding any matches — the scan is incomplete, NOT proof of absence. The walk is bounded by directory size, not pattern width; scope the search to a deeper directory (e.g. \`sub/dir/*.ext\` instead of \`*.ext\` at a huge root).`;
		return buildResult(merged.map(entry => entry.path), { notice, forceTruncated: true, timedOut: true });
	}

	return buildResult(merged.map(entry => entry.path));
}
