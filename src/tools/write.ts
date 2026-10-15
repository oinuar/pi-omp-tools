/**
 * `write` tool: create or overwrite a file, an archive entry, or a SQLite
 * row. Port of OMP's `packages/coding-agent/src/tools/write.ts` — path
 * handling, guards (URI-like targets, read-selector misfires, truncated read
 * projections), archive whole-rewrite semantics, and SQLite row lookup are
 * aligned to OMP, including its result/error strings. OMP-only features
 * (LSP writethrough, ACP bridge, internal URLs, conflict://, plan mode,
 * device-only writes) have no native-pi equivalent and are intentionally
 * omitted.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { isReadTruncationNotice, stripHashlinePrefixes, unwrapHashlineHeaderPath } from "../hashline/prefixes.ts";
import { ToolError, textResult, type ToolCtx, type ToolResult, type ToolUpdate } from "../host.ts";
import { json5Parse } from "../shared/json5.ts";
import { type SqliteConn, sqliteDriver } from "../shared/sqlite.ts";
import { snapshots } from "../shared/snapshots.ts";
import {
	displayPath,
	hasBinary,
	normalizeText,
	readPrefix,
	resolvePath,
	run,
	statOrNull,
} from "../shared/util.ts";

// ── content normalization (OMP `write-content.ts`) ─────────────────────────

const LOOSE_HASHLINE_HEADER_RE = /^\s*\[[^#\r\n]+#[^ \t\r\n]*\]\s*$/;

/**
 * `stripHashlinePrefixes(lines).join("\n")`, or `undefined` when that equals
 * `text` (rows are compared first so unprefixed content is never re-joined).
 */
function joinStrippedLines(lines: string[], text?: string): string | undefined {
	const cleaned = stripHashlinePrefixes(lines);
	if (cleaned.length === lines.length) {
		let index = 0;
		while (index < lines.length && cleaned[index] === lines[index]) index++;
		if (index === lines.length) return undefined;
	}
	const cleanedText = cleaned.join("\n");
	return cleanedText === (text ?? lines.join("\n")) ? undefined : cleanedText;
}

/**
 * Strip hashline display prefixes from write content (port of OMP's
 * `stripWriteContent`). The model sees `[PATH#TAG]` headers plus `N:`
 * prefixes in read output and sometimes copies them into write content; pi is
 * always in hashline display mode, so no session gate applies. Includes OMP's
 * fallback for a loosely-formed first-line header.
 */
function stripWriteContent(content: string): { text: string; stripped: boolean } {
	const lines = content.split("\n");
	const cleanedText = joinStrippedLines(lines, content);
	if (cleanedText !== undefined) return { text: cleanedText, stripped: true };
	const headerIndex = lines.findIndex(line => line.trim().length > 0);
	if (headerIndex === -1 || !LOOSE_HASHLINE_HEADER_RE.test(lines[headerIndex])) return { text: content, stripped: false };
	const linesWithoutHeader = lines.slice(0, headerIndex).concat(lines.slice(headerIndex + 1));
	const cleanedWithoutHeader = joinStrippedLines(linesWithoutHeader);
	if (cleanedWithoutHeader === undefined) return { text: content, stripped: false };
	return { text: cleanedWithoutHeader, stripped: true };
}

// ── target guards (OMP `write.ts`) ──────────────────────────────────────────

const URI_LIKE_WRITE_PATH_RE = /^([a-z][a-z0-9+.-]*):\/{1,2}(.*)$/i;

/**
 * Fail closed on URI-like write targets. pi registers no writable URL
 * schemes, so any `scheme://...` is a mis-dispatch that must not silently
 * become a local file (OMP's `assertWriteTargetAddressable`, minus router
 * device schemes). Prefix the path with `./` to deliberately create a
 * URI-looking POSIX filename.
 */
function assertWriteTargetAddressable(target: string): void {
	const trimmed = target.trim();
	if (!URI_LIKE_WRITE_PATH_RE.test(trimmed)) return;
	throw new ToolError(
		`Unknown URI-like write target '${trimmed}'. Prefix the path with './' to write it as a filesystem path.`,
	);
}

// OMP's read-selector grammar (pi-tui read.ts) — a trailing `:SEL` that parses
// as a read selector makes the target a likely read/write mis-dispatch.
const LINE_RANGE_CHUNK_SOURCE = String.raw`L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?`;
const RANGE_SELECTOR_CHUNK = `${LINE_RANGE_CHUNK_SOURCE}(?<=[\\d.-])`;
const RANGE_LIST_SRC = `${RANGE_SELECTOR_CHUNK}(?:,${RANGE_SELECTOR_CHUNK})*`;
const TAIL_CHUNK_SRC = String.raw`-\d+`;
const FILE_LINE_RANGE_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|${TAIL_CHUNK_SRC}|raw|conflicts|img)$`, "i");
const FILE_LINE_RANGE_ONLY_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|${TAIL_CHUNK_SRC})$`, "i");
const FILE_RAW_ONLY_RE = /^raw$/i;

/** Port of OMP's `splitPathAndSel`: peel one trailing read selector, if any. */
function splitPathAndSel(rawPath: string): { path: string; sel?: string } {
	const colon = rawPath.lastIndexOf(":");
	if (colon <= 0) return { path: rawPath };
	const candidate = rawPath.slice(colon + 1);
	if (!FILE_LINE_RANGE_RE.test(candidate)) return { path: rawPath };
	let basePath = rawPath.slice(0, colon);
	let sel = candidate;
	// Compound trailing selector: `path:1-50:raw`, `path:raw:1-50`, `path:raw:-60`.
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

function readSelectorForEmptyWrite(target: string, content: string): string | undefined {
	if (content.length > 0) return undefined;
	return splitPathAndSel(target).sel;
}

function throwReadSelectorMisfire(target: string, sel: string): never {
	throw new ToolError(
		`write target '${target}' ends with a read-tool selector ':${sel}' and no such file exists — refusing to create a literal file by that name. ` +
			`If you meant to read it, use read({ path: "${target}" }). ` +
			`If you truly intend to create this file, pass its contents in \`content\` (a non-empty write is never blocked).`,
	);
}

function readSelectorListMisfire(target: string): number | undefined {
	if (!target.includes(";")) return undefined;
	const segments = target.split(";");
	if (segments.length < 2) return undefined;
	for (const segment of segments) {
		const trimmed = segment.trim();
		if (trimmed.length === 0 || splitPathAndSel(trimmed).sel === undefined) return undefined;
	}
	return segments.length;
}

function throwReadSelectorListMisfire(target: string, count: number): never {
	throw new ToolError(
		`write target '${target}' is a semicolon-joined list of ${count} read-tool selectors, not a filesystem path — refusing to create it. ` +
			`write creates a single file; issue one read() per path to read these ranges (e.g. read({ path: "<one path>:<range>" })).`,
	);
}

async function probeLiteralPathExists(target: string, cwd: string): Promise<"exists" | "missing" | "unknown"> {
	try {
		await fs.stat(resolvePath(target, cwd));
		return "exists";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return "missing";
		return "unknown";
	}
}

async function assertNotReadSelectorMisfire(target: string, content: string, cwd: string): Promise<void> {
	const listCount = readSelectorListMisfire(target);
	if (listCount !== undefined && (await probeLiteralPathExists(target, cwd)) === "missing") {
		throwReadSelectorListMisfire(target, listCount);
	}
	const sel = readSelectorForEmptyWrite(target, content);
	if (sel === undefined) return;
	if ((await probeLiteralPathExists(target, cwd)) !== "missing") return;
	throwReadSelectorMisfire(target, sel);
}

// ── truncated read-projection guard (OMP `write.ts`) ───────────────────────

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

/**
 * Offset of the last non-blank line of LF-only `text` when that line is a
 * `read` truncation notice, else -1. Walks lines backward from the end.
 */
function readTruncationNoticeStart(text: string): number {
	let end = text.length;
	while (end > 0) {
		const start = text.lastIndexOf("\n", end - 1) + 1;
		const line = text.slice(start, end);
		if (line.trim().length > 0) return isReadTruncationNotice(line) ? start : -1;
		end = start - 1;
	}
	return -1;
}

/** `normalizeToLF(text).length` without the copy: each CRLF collapses to one LF. */
function lfNormalizedLength(text: string): number {
	let length = text.length;
	for (let at = text.indexOf("\r\n"); at !== -1; at = text.indexOf("\r\n", at + 2)) length--;
	return length;
}

function endsWithReadTruncationNotice(content: string): boolean {
	return readTruncationNoticeStart(normalizeToLF(content)) !== -1;
}

/**
 * Length of a read projection's shown payload — everything up to (excluding)
 * its trailing truncation notice and the blank separator before it.
 * `undefined` when the content does not end in such a notice.
 */
function readProjectionPayloadLength(content: string): number | undefined {
	const text = normalizeToLF(content);
	let payloadEnd = readTruncationNoticeStart(text);
	if (payloadEnd === -1) return undefined;
	// Back over the blank lines separating the payload from the notice.
	while (payloadEnd > 0) {
		const previousStart = payloadEnd > 1 ? text.lastIndexOf("\n", payloadEnd - 2) + 1 : 0;
		if (text.slice(previousStart, payloadEnd - 1).trim().length > 0) break;
		payloadEnd = previousStart;
	}
	// `payloadEnd` starts the first dropped line; the payload excludes the LF before it.
	return Math.max(0, payloadEnd - 1);
}

function assertNotShorterReadProjection(
	displayPath: string,
	rawContent: string,
	currentContent: string | undefined,
	writeContent: string = rawContent,
): void {
	const rawPayloadLength = readProjectionPayloadLength(rawContent);
	if (rawPayloadLength === undefined || currentContent === undefined) return;
	const payloadLength = writeContent === rawContent ? rawPayloadLength : lfNormalizedLength(writeContent);
	if (payloadLength >= lfNormalizedLength(currentContent)) return;
	throw new ToolError(
		`Refusing to overwrite '${displayPath}' with an incomplete read projection: the content ends with a read truncation notice and covers less than the current source, so it would discard unseen content. Re-read the omitted ranges and write the complete file, or use edit for a partial change.`,
	);
}

async function readCurrentSource(absolutePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(absolutePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function assertNotTruncatedFileReadProjection(
	absolutePath: string,
	displayPath: string,
	rawContent: string,
	writeContent: string,
): Promise<void> {
	if (!endsWithReadTruncationNotice(rawContent)) return;
	const currentContent = await readCurrentSource(absolutePath);
	assertNotShorterReadProjection(displayPath, rawContent, currentContent, writeContent);
}

// ── archive writes (OMP `#resolveArchiveWritePath` / `#writeArchiveEntry`) ──

/**
 * Archive extensions recognized for write-path splitting, longest first.
 * Mirrors OMP's registry minus the container formats pi's read tool does not
 * index (asar, iso, cab, cpio, rpm, ar, deb, lzh, arj); read-only formats stay
 * candidates so `foo.7z:member` fails with OMP's read-only error instead of
 * creating a stray literal file.
 */
const ARCHIVE_FORMAT_TABLE: Array<readonly [string, string]> = [
	["tar.gz", "tar.gz"],
	["tar.bz2", "tar.bz2"],
	["tar.xz", "tar.xz"],
	["tar.zst", "tar.zst"],
	["tgz", "tar.gz"],
	["tbz2", "tar.bz2"],
	["txz", "tar.xz"],
	["tzst", "tar.zst"],
	["zip", "zip"],
	["jar", "zip"],
	["war", "zip"],
	["ear", "zip"],
	["apk", "zip"],
	["whl", "zip"],
	["ipa", "zip"],
	["xpi", "zip"],
	["vsix", "zip"],
	["tar", "tar"],
	["gz", "gz"],
	["bz2", "bz2"],
	["xz", "xz"],
	["zst", "zst"],
	["lzma", "lzma"],
	["7z", "7z"],
	["rar", "rar"],
];

const ARCHIVE_EXTENSION_ALTERNATION = ARCHIVE_FORMAT_TABLE.map(([ext]) => ext.replace(/\./g, "\\.")).join("|");
const WRITABLE_ARCHIVE_FORMATS = new Set(["zip", "tar", "tar.gz", "tar.zst"]);

/** Infer an archive format from a filesystem path's extension. */
function archiveFormatFromPath(filePath: string): string | undefined {
	const normalized = filePath.toLowerCase();
	for (const [ext, format] of ARCHIVE_FORMAT_TABLE) {
		if (normalized.endsWith(`.${ext}`)) return format;
	}
	return undefined;
}

/**
 * Split an `archive.ext:inner/path` reference into every plausible
 * `{ archivePath, subPath }` pair, longest archive prefix first (port of
 * OMP's `parseArchivePathCandidates`).
 */
function parseArchivePathCandidates(filePath: string): Array<{ archivePath: string; subPath: string }> {
	const normalized = filePath.replace(/\\/g, "/");
	const pattern = new RegExp(`\\.(?:${ARCHIVE_EXTENSION_ALTERNATION})(?=(?::|$))`, "gi");
	const seen = new Set<string>();
	const candidates: Array<{ archivePath: string; subPath: string }> = [];
	for (let match = pattern.exec(normalized); match !== null; match = pattern.exec(normalized)) {
		const end = match.index + match[0].length;
		const archivePath = filePath.slice(0, end);
		const subPath = normalized.slice(end).replace(/^:+/, "");
		const key = `${archivePath}\0${subPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ archivePath, subPath });
	}
	return candidates.sort((left, right) => right.archivePath.length - left.archivePath.length);
}

/** Port of OMP's `normalizeArchiveWriteSubPath` (same error strings). */
function normalizeArchiveWriteSubPath(rawPath: string): string {
	const normalized = rawPath.replace(/\\/g, "/");
	if (normalized.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}
	if (normalized.endsWith("/")) {
		throw new ToolError("Archive write path must target a file, not a directory");
	}
	const parts = normalized.split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") {
			throw new ToolError("Archive path cannot contain '..'");
		}
		normalizedParts.push(part);
	}
	if (normalizedParts.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}
	return normalizedParts.join("/");
}

interface ResolvedArchiveWritePath {
	absolutePath: string;
	archivePath: string;
	archiveSubPath: string;
	exists: boolean;
}

function isPathNotFound(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

async function resolveArchiveWritePath(writePath: string, cwd: string): Promise<ResolvedArchiveWritePath | null> {
	const candidates = parseArchivePathCandidates(writePath).filter(candidate => candidate.archivePath !== writePath);
	if (candidates.length === 0) return null;

	// When no candidate archive exists, the shortest candidate is used for
	// creating a new container (OMP parity).
	const fallbackCandidate = candidates[candidates.length - 1]!;
	const fallback: ResolvedArchiveWritePath = {
		absolutePath: resolvePath(fallbackCandidate.archivePath, cwd),
		archivePath: fallbackCandidate.archivePath,
		archiveSubPath: normalizeArchiveWriteSubPath(fallbackCandidate.subPath),
		exists: false,
	};

	for (const candidate of candidates) {
		const absolutePath = resolvePath(candidate.archivePath, cwd);
		let stat;
		try {
			stat = await fs.stat(absolutePath);
		} catch (error) {
			if (!isPathNotFound(error)) throw error;
			continue;
		}
		if (stat.isDirectory()) continue;
		return {
			absolutePath,
			archivePath: candidate.archivePath,
			archiveSubPath: normalizeArchiveWriteSubPath(candidate.subPath),
			exists: true,
		};
	}
	return fallback;
}
/** Read one existing member (as text) for the guards; `undefined` when absent. */
async function archiveMemberText(format: string, archiveAbs: string, member: string): Promise<string | undefined> {
	if (format === "zip") {
		const result = await run("unzip", ["-p", archiveAbs, member], { maxBuffer: 256 * 1024 * 1024 });
		if (result.code !== 0) return undefined;
		return result.stdout;
	}
	if (format === "tar.zst") {
		// Some system tars lack zstd; decompress to a temp tar first.
		const innerTmp = `${archiveAbs}.member-${process.pid}.tar`;
		try {
			if (ZLIB_HAS_ZSTD) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				await fs.writeFile(innerTmp, (zlib as any).zstdDecompressSync(await fs.readFile(archiveAbs)));
			} else {
				const dec = await run("zstd", ["-q", "-f", archiveAbs, "-o", innerTmp]);
				if (dec.code !== 0) return undefined;
			}
			const result = await run("tar", ["-xOf", innerTmp, member], { maxBuffer: 256 * 1024 * 1024 });
			if (result.code !== 0) return undefined;
			return result.stdout;
		} catch {
			return undefined;
		} finally {
			await fs.rm(innerTmp, { force: true }).catch(() => {});
		}
	}
	const result = await run("tar", ["-xOf", archiveAbs, member], { maxBuffer: 256 * 1024 * 1024 });
	if (result.code !== 0) return undefined;
	return result.stdout;
}

// Node's zlib gained zstd in recent releases; otherwise the `zstd` CLI is used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ZLIB_HAS_ZSTD = typeof (zlib as any).zstdCompressSync === "function";

async function zstdAvailable(): Promise<boolean> {
	return ZLIB_HAS_ZSTD || (await hasBinary("zstd"));
}

async function writeArchiveEntry(
	content: string,
	rawContent: string,
	resolved: ResolvedArchiveWritePath,
	cwd: string,
	stripped: boolean,
): Promise<ToolResult> {
	// Resolve symlinks before the tmp+rename swap: renaming over a symlink
	// replaces the link itself with a regular file instead of writing through
	// to its target.
	const finalPath = resolved.exists
		? await fs.realpath(resolved.absolutePath).catch(() => resolved.absolutePath)
		: resolved.absolutePath;
	// A realpath swap can land on a name without an archive extension; a
	// whole-archive rewrite then defaults to an uncompressed tar.
	const format = archiveFormatFromPath(finalPath) ?? "tar";
	if (!WRITABLE_ARCHIVE_FORMATS.has(format)) {
		throw new ToolError(`Writing entries inside ${format} archives is not supported (read-only format).`);
	}

	if (format === "zip" && !(await hasBinary("zip"))) {
		throw new ToolError("`zip` CLI is required to write zip archive entries.");
	}
	if (format !== "zip" && !(await hasBinary("tar"))) {
		throw new ToolError("`tar` CLI is required to write tar archive entries.");
	}
	if (format === "tar.zst" && !(await zstdAvailable())) {
		throw new ToolError("`zstd` (node:zlib zstd or the zstd CLI) is required to write .tar.zst archive entries.");
	}

	// Rewrites are whole-archive: write to a sibling temp file and rename so a
	// crash/disk-full mid-write can't destroy the original archive.
	const tmpPath = `${finalPath}.tmp-${process.pid}`;
	const parentDir = path.dirname(resolved.absolutePath);
	if (parentDir && parentDir !== ".") {
		await fs.mkdir(parentDir, { recursive: true });
	}

	const writeTarget = `${resolved.archivePath}:${resolved.archiveSubPath}`;
	// Guards need the existing member only when they can fire.
	const existingMember =
		resolved.exists && (content.length === 0 || endsWithReadTruncationNotice(rawContent))
			? await archiveMemberText(format, finalPath, resolved.archiveSubPath)
			: undefined;
	const sel = readSelectorForEmptyWrite(writeTarget, content);
	if (sel !== undefined && existingMember === undefined) {
		throwReadSelectorMisfire(writeTarget, sel);
	}
	if (existingMember !== undefined && endsWithReadTruncationNotice(rawContent)) {
		assertNotShorterReadProjection(writeTarget, rawContent, existingMember, content);
	}

	const staging = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-write-"));
	try {
		if (format === "zip") {
			const memberAbs = path.join(staging, resolved.archiveSubPath);
			await fs.mkdir(path.dirname(memberAbs), { recursive: true });
			await fs.writeFile(memberAbs, content, "utf8");
			if (resolved.exists) await fs.copyFile(finalPath, tmpPath);
			const result = await run("zip", ["-q", "-X", tmpPath, resolved.archiveSubPath], { cwd: staging });
			if (result.code !== 0) {
				await fs.rm(tmpPath, { force: true }).catch(() => {});
				throw new ToolError(result.stderr.trim() || result.stdout.trim() || `zip failed`);
			}
		} else {
			const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-tar-"));
			// Some system tars lack zstd support: decompress an existing
			// .tar.zst to a temp uncompressed tar and list/extract that.
			let innerTar: string | null = null;
			try {
				if (format === "tar.zst" && resolved.exists) {
					innerTar = `${finalPath}.inner-${process.pid}.tar`;
					if (ZLIB_HAS_ZSTD) {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						await fs.writeFile(innerTar, (zlib as any).zstdDecompressSync(await fs.readFile(finalPath)));
					} else {
						const dec = await run("zstd", ["-q", "-f", finalPath, "-o", innerTar]);
						if (dec.code !== 0) throw new ToolError(dec.stderr.trim() || "zstd decompression failed");
					}
				}
				let topEntries: string[] = [];
				if (resolved.exists) {
					const list = await run("tar", ["-tf", innerTar ?? finalPath]);
					if (list.code !== 0) throw new ToolError(list.stderr.trim() || "failed to list tar archive");
					topEntries = [
						...new Set(
							list.stdout
								.split("\n")
								.map(line => line.replace(/^\.\//, "").split("/")[0])
								.filter(name => name && name !== "."),
						),
					];
					const extract = await run("tar", ["-xf", innerTar ?? finalPath, "-C", extractDir]);
					if (extract.code !== 0) throw new ToolError(extract.stderr.trim() || "failed to extract tar archive");
				}
				const memberAbs = path.join(extractDir, resolved.archiveSubPath);
				await fs.mkdir(path.dirname(memberAbs), { recursive: true });
				await fs.writeFile(memberAbs, content, "utf8");
				const memberTop = resolved.archiveSubPath.split("/")[0]!;
				if (!topEntries.includes(memberTop)) topEntries.push(memberTop);
				const build = await run("tar", ["-cf", tmpPath, "-C", extractDir, ...topEntries]);
				if (build.code !== 0) throw new ToolError(build.stderr.trim() || "failed to rebuild tar archive");
				if (format === "tar.gz") {
					const gzPath = `${finalPath}.tmp-${process.pid}.gz`;
					await fs.writeFile(gzPath, zlib.gzipSync(await fs.readFile(tmpPath)));
					await fs.rm(tmpPath, { force: true });
					await fs.rename(gzPath, finalPath);
				} else if (format === "tar.zst") {
					const zstPath = `${finalPath}.tmp-${process.pid}.zst`;
					if (ZLIB_HAS_ZSTD) {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						await fs.writeFile(zstPath, (zlib as any).zstdCompressSync(await fs.readFile(tmpPath)));
					} else {
						const compressed = await run("zstd", ["-q", "-f", tmpPath, "-o", zstPath]);
						if (compressed.code !== 0) throw new ToolError(compressed.stderr.trim() || "zstd compression failed");
					}
					await fs.rm(tmpPath, { force: true });
					await fs.rename(zstPath, finalPath);
				} else {
					await fs.rename(tmpPath, finalPath);
				}
			} finally {
				if (innerTar) await fs.rm(innerTar, { force: true });
				await fs.rm(extractDir, { recursive: true, force: true });
			}
		}
		await fs.rename(tmpPath, finalPath).catch(error => {
			// The gz/zst branches already renamed; ENOENT here means the write
			// already succeeded, so only surface other failures.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	} catch (error) {
		await fs.rm(tmpPath, { force: true }).catch(() => {});
		if (error instanceof ToolError) throw error;
		throw new ToolError(error instanceof Error ? error.message : String(error));
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}

	const shownPath = displayPath(resolved.absolutePath, cwd);
	let resultText = `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${shownPath}:${resolved.archiveSubPath}`;
	if (stripped) {
		resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
	}
	return textResult(resultText, { resolvedPath: resolved.absolutePath });
}

// ── SQLite writes (OMP `#resolveSqliteWritePath` / `#writeSqliteRow`) ──────

const SQLITE_PATH_PATTERN = /\.(?:sqlite3?|db3?)(?=(?::|\?|$))/gi;

interface SqlitePathCandidate {
	sqlitePath: string;
	subPath: string;
	queryString: string;
}

function splitSqliteRemainder(remainder: string): { subPath: string; queryString: string } {
	const queryIndex = remainder.indexOf("?");
	if (queryIndex === -1) {
		return { subPath: remainder.replace(/^:+/, ""), queryString: "" };
	}
	return { subPath: remainder.slice(0, queryIndex).replace(/^:+/, ""), queryString: remainder.slice(queryIndex + 1) };
}

/** Port of OMP's `parseSqlitePathCandidates`. */
function parseSqlitePathCandidates(filePath: string): SqlitePathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const seen = new Set<string>();
	const candidates: SqlitePathCandidate[] = [];
	for (let match = SQLITE_PATH_PATTERN.exec(normalized); match !== null; match = SQLITE_PATH_PATTERN.exec(normalized)) {
		const end = match.index + match[0].length;
		const sqlitePath = filePath.slice(0, end);
		const remainder = normalized.slice(end);
		const { subPath, queryString } = splitSqliteRemainder(remainder);
		const key = `${sqlitePath}\0${subPath}\0${queryString}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ sqlitePath, subPath, queryString });
	}
	return candidates.sort((left, right) => right.sqlitePath.length - left.sqlitePath.length);
}

/** Port of OMP's `parseSqliteWriteTarget` (same error strings). */
function parseSqliteWriteTarget(subPath: string, queryString: string): { table: string; key?: string } {
	if (queryString.trim().length > 0) {
		throw new ToolError("SQLite write paths do not support query parameters");
	}
	const normalized = subPath.replace(/^:+/, "").trim();
	if (!normalized) {
		throw new ToolError("SQLite write path must target a table");
	}
	const separatorIndex = normalized.indexOf(":");
	const table = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
	const key = separatorIndex === -1 ? undefined : normalized.slice(separatorIndex + 1);
	if (!table) {
		throw new ToolError("SQLite write path must target a table");
	}
	if (key !== undefined && key.length === 0) {
		throw new ToolError("SQLite row writes require a non-empty row key");
	}
	return { table, key };
}

/** True when the file starts with the SQLite magic (OMP checks bytes, not extension). */
async function hasSqliteMagic(absolutePath: string): Promise<boolean> {
	const head = await readPrefix(absolutePath, 16);
	if (!head || head.length < 16) return false;
	return head.toString("latin1") === "SQLite format 3\0";
}

interface ResolvedSqliteWritePath {
	absolutePath: string;
	sqlitePath: string;
	table: string;
	key?: string;
	exists: boolean;
}

async function resolveSqliteWritePath(writePath: string, cwd: string): Promise<ResolvedSqliteWritePath | null> {
	const candidates = parseSqlitePathCandidates(writePath).filter(candidate => candidate.sqlitePath !== writePath);
	if (candidates.length === 0) return null;

	const fallbackCandidate = candidates[candidates.length - 1]!;
	const fallbackTarget = parseSqliteWriteTarget(fallbackCandidate.subPath, fallbackCandidate.queryString);
	const fallback: ResolvedSqliteWritePath = {
		absolutePath: resolvePath(fallbackCandidate.sqlitePath, cwd),
		sqlitePath: fallbackCandidate.sqlitePath,
		table: fallbackTarget.table,
		key: fallbackTarget.key,
		exists: false,
	};

	let sawExistingNonSqlite = false;
	for (const candidate of candidates) {
		const target = parseSqliteWriteTarget(candidate.subPath, candidate.queryString);
		const absolutePath = resolvePath(candidate.sqlitePath, cwd);
		let stat;
		try {
			stat = await fs.stat(absolutePath);
		} catch (error) {
			if (!isPathNotFound(error)) throw error;
			continue;
		}
		if (stat.isDirectory()) continue;
		if (!(await hasSqliteMagic(absolutePath))) {
			sawExistingNonSqlite = true;
			continue;
		}
		return {
			absolutePath,
			sqlitePath: candidate.sqlitePath,
			table: target.table,
			key: target.key,
			exists: true,
		};
	}

	// An existing non-SQLite file suppresses SQLite interpretation: the path
	// falls back to a plain file write.
	if (sawExistingNonSqlite) return null;
	return fallback;
}

// OMP sqlite-reader.ts write helpers (ports; identifiers are quoted, not
// identifier-validated, matching OMP).
function quoteSqliteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

async function getTableMasterRow(db: SqliteConn, table: string): Promise<void> {
	const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name = ?", [table]);
	if (rows.length === 0) {
		throw new ToolError(`SQLite table '${table}' not found`);
	}
}

async function getTableInfoRows(db: SqliteConn, table: string): Promise<Record<string, unknown>[]> {
	await getTableMasterRow(db, table);
	return db.all(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`);
}

async function getTableColumns(db: SqliteConn, table: string): Promise<string[]> {
	return (await getTableInfoRows(db, table)).map(column => String(column.name));
}

async function getPrimaryKeyColumns(db: SqliteConn, table: string): Promise<Array<{ name: string; type: string; pk: number }>> {
	const rows = await getTableInfoRows(db, table);
	return rows
		.filter(column => Number(column.pk) > 0)
		.map(column => ({ name: String(column.name), type: String(column.type ?? ""), pk: Number(column.pk) }))
		.sort((left, right) => left.pk - right.pk);
}

async function getTableSchema(db: SqliteConn, table: string): Promise<string> {
	const rows = await db.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
	const sql = rows[0]?.sql;
	if (sql === null || sql === undefined) {
		throw new ToolError(`SQLite schema for table '${table}' is unavailable`);
	}
	return String(sql);
}

type SqliteRowLookup = { kind: "pk"; column: string; type: string } | { kind: "rowid" };

async function resolveTableRowLookup(db: SqliteConn, table: string): Promise<SqliteRowLookup> {
	const primaryKeyColumns = await getPrimaryKeyColumns(db, table);
	if (primaryKeyColumns.length === 1) {
		const column = primaryKeyColumns[0]!;
		return { kind: "pk", column: column.name, type: column.type };
	}
	if (primaryKeyColumns.length > 1) {
		throw new ToolError(`SQLite table '${table}' has a composite primary key; use '?where=' instead`);
	}
	const schema = await getTableSchema(db, table);
	if (/\bWITHOUT\s+ROWID\b/i.test(schema)) {
		throw new ToolError(`SQLite table '${table}' does not expose ROWID; use '?where=' instead`);
	}
	return { kind: "rowid" };
}

function coerceIntegerKey(key: string, label: string): number | bigint {
	const trimmed = key.trim();
	if (!/^-?\d+$/.test(trimmed)) {
		throw new ToolError(`${label} must be an integer; got '${key}'`);
	}
	const asNumber = Number.parseInt(trimmed, 10);
	if (Number.isSafeInteger(asNumber)) {
		return asNumber;
	}
	return BigInt(trimmed);
}

function coerceLookupValue(key: string, type: string): unknown {
	const normalizedType = type.trim().toUpperCase();
	if (normalizedType.includes("INT")) {
		return coerceIntegerKey(key, `Primary key '${key}'`);
	}
	if (normalizedType.includes("REAL") || normalizedType.includes("FLOA") || normalizedType.includes("DOUB")) {
		const parsed = Number(key);
		if (Number.isFinite(parsed)) return parsed;
	}
	return key;
}

function normalizeWriteValue(value: unknown, column: string): unknown {
	if (value === null) return null;
	if (typeof value === "boolean") return value ? 1 : 0; // SQLite has no boolean type; bun:sqlite stores 1/0
	if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
	throw new ToolError(`SQLite column '${column}' only accepts JSON scalar values or null`);
}

async function validateWriteColumns(db: SqliteConn, table: string, data: Record<string, unknown>): Promise<Array<[string, unknown]>> {
	const columns = new Set(await getTableColumns(db, table));
	return Object.entries(data).map(([column, value]) => {
		if (!columns.has(column)) {
			throw new ToolError(`SQLite table '${table}' has no column named '${column}'`);
		}
		return [column, normalizeWriteValue(value, column)];
	});
}

async function insertRow(db: SqliteConn, table: string, data: Record<string, unknown>): Promise<void> {
	await getTableMasterRow(db, table);
	const entries = await validateWriteColumns(db, table, data);
	if (entries.length === 0) {
		await db.run(`INSERT INTO ${quoteSqliteIdentifier(table)} DEFAULT VALUES`);
		return;
	}
	const columns = entries.map(([column]) => quoteSqliteIdentifier(column)).join(", ");
	const placeholders = entries.map(() => "?").join(", ");
	await db.run(`INSERT INTO ${quoteSqliteIdentifier(table)} (${columns}) VALUES (${placeholders})`, entries.map(([, value]) => value));
}

async function updateRow(
	db: SqliteConn,
	table: string,
	lookup: SqliteRowLookup,
	key: string,
	data: Record<string, unknown>,
): Promise<number> {
	await getTableMasterRow(db, table);
	const entries = await validateWriteColumns(db, table, data);
	if (entries.length === 0) {
		throw new ToolError("SQLite updates require at least one column value");
	}
	const assignments = entries.map(([column]) => `${quoteSqliteIdentifier(column)} = ?`).join(", ");
	const bindings = entries.map(([, value]) => value);
	if (lookup.kind === "pk") {
		bindings.push(coerceLookupValue(key, lookup.type));
		const result = await db.run(
			`UPDATE ${quoteSqliteIdentifier(table)} SET ${assignments} WHERE ${quoteSqliteIdentifier(lookup.column)} = ?`,
			bindings,
		);
		return result.changes;
	}
	bindings.push(coerceIntegerKey(key, "SQLite ROWID"));
	const result = await db.run(`UPDATE ${quoteSqliteIdentifier(table)} SET ${assignments} WHERE rowid = ?`, bindings);
	return result.changes;
}

async function deleteRow(db: SqliteConn, table: string, lookup: SqliteRowLookup, key: string): Promise<number> {
	await getTableMasterRow(db, table);
	if (lookup.kind === "pk") {
		const result = await db.run(
			`DELETE FROM ${quoteSqliteIdentifier(table)} WHERE ${quoteSqliteIdentifier(lookup.column)} = ?`,
			[coerceLookupValue(key, lookup.type)],
		);
		return result.changes;
	}
	const result = await db.run(`DELETE FROM ${quoteSqliteIdentifier(table)} WHERE rowid = ?`, [
		coerceIntegerKey(key, "SQLite ROWID"),
	]);
	return result.changes;
}

async function writeSqliteRow(
	displayPath: string,
	content: string,
	resolved: ResolvedSqliteWritePath,
	stripped: boolean,
): Promise<ToolResult> {
	if (!resolved.exists) {
		throw new ToolError(`SQLite database '${displayPath}' not found`);
	}
	const driver = await sqliteDriver();
	if (!driver) throw new ToolError("No SQLite driver available (needs node:sqlite, bun:sqlite, or the sqlite3 CLI).");
	const db = await driver.open(resolved.absolutePath);
	let resultText: string;
	try {
		const trimmedContent = content.trim();
		if (trimmedContent.length === 0) {
			if (!resolved.key) {
				throw new ToolError("SQLite deletes require a row key in the path");
			}
			const lookup = await resolveTableRowLookup(db, resolved.table);
			const deleted = await deleteRow(db, resolved.table, lookup, resolved.key);
			resultText =
				deleted > 0
					? `Deleted row '${resolved.key}' from ${resolved.table}`
					: `No row deleted from ${resolved.table} for key '${resolved.key}'`;
		} else {
			let parsedContent: unknown;
			try {
				parsedContent = json5Parse(content);
			} catch (error) {
				throw new ToolError(
					`SQLite write content must be valid JSON5: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (typeof parsedContent !== "object" || parsedContent === null || Array.isArray(parsedContent)) {
				throw new ToolError("SQLite write content must be a JSON object");
			}
			if (resolved.key) {
				const lookup = await resolveTableRowLookup(db, resolved.table);
				const updated = await updateRow(db, resolved.table, lookup, resolved.key, parsedContent as Record<string, unknown>);
				resultText =
					updated > 0
						? `Updated row '${resolved.key}' in ${resolved.table}`
						: `No row updated in ${resolved.table} for key '${resolved.key}'`;
			} else {
				await insertRow(db, resolved.table, parsedContent as Record<string, unknown>);
				resultText = `Inserted row into ${resolved.table}`;
			}
		}
	} finally {
		db.close();
	}
	let text = resultText;
	if (stripped) {
		text += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
	}
	return textResult(text, { resolvedPath: resolved.absolutePath });
}

// ── plain file writes ───────────────────────────────────────────────────────

const EXECUTABLE_NOTICE = "[Notice: Made executable via chmod +x]";
const PREVIEW_ROW_CAP = 400;

/**
 * If `content` begins with a `#!` shebang, ensure the file is executable
 * (port of OMP's `maybeMarkExecutableForShebang`). Mirrors `chmod a+x`;
 * errors are swallowed — a chmod failure must not fail a successful write.
 */
async function maybeMarkExecutableForShebang(absolutePath: string, content: string): Promise<boolean> {
	if (!content.startsWith("#!")) return false;
	try {
		const stat = await fs.stat(absolutePath);
		const currentMode = stat.mode & 0o7777;
		const newMode = currentMode | 0o111;
		if (newMode === currentMode) return false;
		await fs.chmod(absolutePath, newMode);
		return ((await fs.stat(absolutePath)).mode & 0o111) === 0o111;
	} catch {
		return false;
	}
}

function emitWriteProgress(onUpdate: ToolUpdate | undefined, content: string, displayPath: string, resolvedPath?: string): void {
	onUpdate?.({
		content: [{ type: "text", text: `Writing ${Buffer.byteLength(content, "utf8")} bytes to ${displayPath}...` }],
		details: resolvedPath ? { resolvedPath } : {},
	});
}

// ── tool entrypoint ─────────────────────────────────────────────────────────

export async function executeWrite(
	rawPath: string,
	rawContent: string | undefined,
	ctx?: ToolCtx,
	onUpdate?: ToolUpdate,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	// Unwrap a copied `[path#TAG]` wrapper up front so every downstream
	// decision (candidate routing, guards, resolution) sees the same target.
	const writePath = unwrapHashlineHeaderPath(rawPath);
	if (rawContent === undefined) {
		throw new ToolError(`content is required for ${writePath}.`);
	}
	// Text payloads get hashline display prefixes stripped if the model copied
	// them from read output.
	const { text: cleanContent, stripped } = stripWriteContent(rawContent);
	assertWriteTargetAddressable(writePath);

	signal?.throwIfAborted();

	// Archive path detection runs before SQLite detection: a path that matches
	// an archive selector is never treated as SQLite.
	const resolvedArchivePath = await resolveArchiveWritePath(writePath, cwd);
	if (resolvedArchivePath) {
		emitWriteProgress(
			onUpdate,
			cleanContent,
			`${displayPath(resolvedArchivePath.absolutePath, cwd)}:${resolvedArchivePath.archiveSubPath}`,
			resolvedArchivePath.absolutePath,
		);
		signal?.throwIfAborted();
		return writeArchiveEntry(cleanContent, rawContent, resolvedArchivePath, cwd, stripped);
	}

	const resolvedSqlitePath = await resolveSqliteWritePath(writePath, cwd);
	if (resolvedSqlitePath) {
		emitWriteProgress(onUpdate, cleanContent, writePath, resolvedSqlitePath.absolutePath);
		signal?.throwIfAborted();
		return writeSqliteRow(writePath, cleanContent, resolvedSqlitePath, stripped);
	}

	// Plain filesystem file.
	await assertNotReadSelectorMisfire(writePath, cleanContent, cwd);
	const absolutePath = resolvePath(writePath, cwd);
	const shownPath = displayPath(absolutePath, cwd);
	await assertNotTruncatedFileReadProjection(absolutePath, shownPath, rawContent, cleanContent);

	emitWriteProgress(onUpdate, cleanContent, shownPath, absolutePath);
	signal?.throwIfAborted();

	const existed = (await statOrNull(absolutePath)) !== null;
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, cleanContent, "utf8");
	const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, cleanContent);

	const normalized = normalizeText(cleanContent);
	const tag = snapshots.record(absolutePath, normalized.text);
	const contentLines = normalized.text.length === 0 ? [] : normalized.text.replace(/\n$/, "").split("\n");
	let resultText = `[${shownPath}#${tag}]\nSuccessfully wrote ${Buffer.byteLength(cleanContent, "utf8")} bytes to ${shownPath}`;
	if (stripped) {
		resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
	}
	if (madeExecutable) {
		resultText += `\n${EXECUTABLE_NOTICE}`;
	}
	return textResult(resultText, {
		path: shownPath,
		tag,
		existed,
		lineCount: contentLines.length,
		rows: contentLines.slice(0, PREVIEW_ROW_CAP).map((text, index) => ({ n: index + 1, text })),
		resolvedPath: absolutePath,
		madeExecutable: madeExecutable || undefined,
	});
}
