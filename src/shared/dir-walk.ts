/**
 * JS directory/symlink walker for the `find` tool's ripgrep engine.
 *
 * `rg --files` lists regular files only, but OMP's native glob walker emits
 * directories and symlinks as well (`WalkFilter::all`, never followed). This
 * walker supplies the missing entry kinds with the same pruning semantics:
 *
 *  - `.git` is always skipped; `node_modules` is skipped unless the pattern
 *    mentions it (OMP `skip_git` / `skip_node_modules`).
 *  - Hidden entries are only visited when `hidden` is set.
 *  - Gitignore pruning reads per-directory `.ignore`, `.gitignore`, and
 *    `.git/info/exclude` — the same sources OMP's walker consumes through
 *    ripgrep's `ignore` crate. Last matching rule wins; a pruned directory's
 *    subtree is never visited, so negations cannot re-include entries under
 *    an excluded parent. Rules are loaded from the search root downward —
 *    ancestor ignore files above an explicit root still apply to the files
 *    the ripgrep stage lists (rg's git semantics), only this walker's
 *    directory list ignores them.
 *  - Symlinks are emitted as entries and never followed
 *    (OMP `FollowLinks::Never`); their own `lstat` mtime is reported.
 *  - Bounded patterns cap the descent at their segment count
 *    (OMP `walk_depth_bound`): `dir/*` never walks `dir/sub/…`.
 *
 * Regular files are intentionally not emitted — the ripgrep stage owns them
 * with exact gitignore semantics. Unreadable directories are skipped
 * silently (OMP `DirectoryErrorMode::SkipSkippable`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/* --------------------------- ignore-rule engine -------------------------- */

interface IgnoreRule {
	/** Directory (relative to the walk root, `""` = root) holding the rule file. */
	base: string;
	negated: boolean;
	/** Pattern applies to directories only (trailing `/` in the rule). */
	dirOnly: boolean;
	/** Matches the entry path relative to the rule's base directory. */
	regex: RegExp;
}

/**
 * Compile one gitignore line into a matcher over base-relative paths.
 * Supports the common subset: `!` negation, trailing `/` (dirs only),
 * leading or interior `/` anchoring, `*`, `?`, `[...]`, and `**` segments.
 * Returns `null` for comments and blank lines.
 */
function compileIgnorePattern(raw: string): { negated: boolean; dirOnly: boolean; regex: RegExp } | null {
	let line = raw.trim();
	if (line.length === 0 || line.startsWith("#")) return null;
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
	if (line.length === 0) return null;
	let anchored = line.startsWith("/");
	if (anchored) line = line.slice(1);
	if (!anchored && line.includes("/")) anchored = true;

	let re = "";
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "*") {
			if (line[i + 1] === "*") {
				const segmentStart = i === 0 || line[i - 1] === "/";
				const segmentEnd = i + 2 >= line.length || line[i + 2] === "/";
				if (segmentStart && segmentEnd) {
					// `**` as a whole segment: any number of path segments.
					if (i + 2 < line.length) {
						re += "(?:.*/)?";
						i += 3; // consume the trailing `/` as well
					} else {
						re += ".*";
						i += 2;
					}
					continue;
				}
				// `**` inside a segment behaves like `*`.
				re += "[^/]*";
				i += 2;
				continue;
			}
			re += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			re += "[^/]";
			i += 1;
			continue;
		}
		if (ch === "[") {
			const close = line.indexOf("]", i + 1);
			if (close === -1) {
				re += "\\[";
				i += 1;
				continue;
			}
			let cls = line.slice(i + 1, close);
			if (cls === "") {
				// `[]` is an unmatchable class in git and an invalid regex in JS —
				// treat it as a literal `[` rather than throwing mid-walk.
				re += "\\[";
				i = close + 1;
				continue;
			}
			if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
			re += `[${cls}]`;
			i = close + 1;
			continue;
		}
		re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
		i += 1;
	}
	const regex = new RegExp(`^(?:${anchored ? "" : "(?:.*/)?"})${re}$`);
	return { negated, dirOnly, regex };
}

/** Last matching rule wins; `dirOnly` rules never match files. */
function isIgnored(rel: string, rules: IgnoreRule[], isDir: boolean): boolean {
	for (let i = rules.length - 1; i >= 0; i--) {
		const rule = rules[i];
		if (rule.dirOnly && !isDir) continue;
		let candidate = rel;
		if (rule.base.length > 0) {
			if (!rel.startsWith(rule.base + "/")) continue;
			candidate = rel.slice(rule.base.length + 1);
		}
		if (rule.regex.test(candidate)) return !rule.negated;
	}
	return false;
}

/** Ignore sources per directory, in precedence order (later = higher). */
const IGNORE_FILES = [".ignore", ".gitignore", path.join(".git", "info", "exclude")];

/** Parse one directory's ignore files into rules scoped to `relDir`. */
async function loadDirRules(absDir: string, relDir: string): Promise<IgnoreRule[]> {
	const rules: IgnoreRule[] = [];
	for (const file of IGNORE_FILES) {
		let content: string;
		try {
			content = await fs.readFile(path.join(absDir, file), "utf8");
		} catch {
			continue;
		}
		for (const raw of content.split("\n")) {
			const rule = compileIgnorePattern(raw.replace(/\r$/, ""));
			if (!rule) continue;
			rules.push({ base: relDir, ...rule });
		}
	}
	return rules;
}

/* -------------------------------- walking -------------------------------- */

/**
 * Maximum depth (path components below the search root) a pattern can match,
 * or Infinity when unbounded (port of OMP `walk_depth_bound`): `*`/`dir/*.ts`
 * cannot reach below their segment count, while `**` and `{...}` may contain
 * or span any number of segments.
 */
export function walkDepthBound(pattern: string): number {
	if (pattern.includes("**") || pattern.includes("{")) return Number.POSITIVE_INFINITY;
	return Math.max(1, pattern.split("/").filter(segment => segment.length > 0).length);
}

export interface DirWalkOptions {
	/** Absolute search root (must be an existing directory). */
	root: string;
	/** Visit dot entries (hidden files and directories). */
	hidden: boolean;
	/** Prune with gitignore-style rules. */
	gitignore: boolean;
	/** Include `node_modules` (otherwise always skipped). */
	includeNodeModules: boolean;
	/** Deepest entry depth to emit or descend into. */
	maxDepth: number;
	/** Stop the walk once this absolute time (ms, `Date.now`) passes. */
	deadlineMs?: number;
	/** Glob matcher over root-relative paths; unmatched entries are dropped. */
	matcher?: (relativePath: string) => boolean;
}

export interface DirWalkEntry {
	/** Absolute path of the entry. */
	path: string;
	/** True for directories; symlinks are always false (never followed). */
	isDir: boolean;
	mtime: number;
}

export interface DirWalkResult {
	entries: DirWalkEntry[];
	/** True when the walk stopped early because the deadline passed. */
	timedOut: boolean;
}

/**
 * Walk `root` emitting directory and symlink entries only (files are the
 * ripgrep stage's job). Pruning mirrors OMP's native walker; see the module
 * doc for the semantic table.
 */
export async function walkDirEntries(options: DirWalkOptions): Promise<DirWalkResult> {
	const entries: DirWalkEntry[] = [];
	let timedOut = false;
	const matcher = options.matcher ?? (() => true);
	const rules: IgnoreRule[] = [];
	if (options.gitignore) rules.push(...(await loadDirRules(options.root, "")));

	const visit = async (dirAbs: string, dirRel: string, depth: number): Promise<void> => {
		if (timedOut) return;
		if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
			timedOut = true;
			return;
		}
		let dirents;
		try {
			dirents = await fs.readdir(dirAbs, { withFileTypes: true });
		} catch {
			return; // SkipSkippable: unreadable directories are skipped silently
		}
		for (const entry of dirents) {
			if (timedOut) return;
			const name = entry.name;
			if (name === ".git") continue; // always skipped (OMP `skip_git`)
			if (name === "node_modules" && !options.includeNodeModules) continue;
			if (!options.hidden && name.startsWith(".")) continue;
			const rel = dirRel === "" ? name : `${dirRel}/${name}`;
			const abs = path.join(dirAbs, name);
			let stat;
			try {
				stat = await fs.lstat(abs);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) {
				if (depth > options.maxDepth) continue;
				if (options.gitignore && isIgnored(rel, rules, false)) continue;
				if (!matcher(rel)) continue;
				entries.push({ path: abs, isDir: false, mtime: stat.mtimeMs });
				continue; // never followed (OMP `FollowLinks::Never`)
			}
			if (!stat.isDirectory() || depth > options.maxDepth) continue;
			if (options.gitignore && isIgnored(rel, rules, true)) continue;
			if (!matcher(rel)) continue;
			entries.push({ path: abs, isDir: true, mtime: stat.mtimeMs });
			if (depth + 1 > options.maxDepth) continue;
			const before = rules.length;
			if (options.gitignore) rules.push(...(await loadDirRules(abs, rel)));
			await visit(abs, rel, depth + 1);
			rules.length = before; // a directory's rules scope only its subtree
		}
	};

	await visit(options.root, "", 1);
	return { entries, timedOut };
}
