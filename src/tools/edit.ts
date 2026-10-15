/**
 * `edit` tool: hashline patching with content-hash anchors, block ops,
 * clipboard registers, and stale-anchor recovery — a port of OMP's
 * `pi-edit::modes::hashline` patcher layer (`patcher.rs`, `session.rs`) on top
 * of the pi host's fs + snapshot store.
 *
 * Per-section flow (mirrors `stage_patch`):
 *   parse (with invalid-range block enrichment) → tag check → path resolve +
 *   tag recovery → read (existence-only for REM) → canonical dedup + MV check
 *   → apply_with_recovery (block lowering, clipboard validation, seen-lines
 *   guard with shift rescue, live apply / head-tail drift / snapshot rebase
 *   recovery / mismatch) → stage. After every section stages, each staged
 *   file is written (atomic: nothing is written until all sections stage),
 *   its snapshot recorded, and its seen-line provenance (carried unshifted
 *   lines + response-body rows) merged into the minted tag.
 */
import * as fs from "node:fs/promises";
import { diffLines } from "diff";
import { ToolError, textResult, type ToolCtx, type ToolResult } from "../host.ts";
import { applyEdits } from "../hashline/apply.ts";
import { hasBlockEdit, nativeBlockResolver, resolveBlockEdits } from "../hashline/block.ts";
import { Clipboard, validateClipboardSequence } from "../hashline/clipboard.ts";
import { Patch, type PatchSection } from "../hashline/input.ts";
import {
	HEADTAIL_DRIFT_WARNING,
	invalidAbsoluteRangeMessage,
	missingSnapshotTagMessage,
	mismatchMessage,
	noChangeDiagnostic,
	noChangeLoopDiagnostic,
	pathRecoveredFromTagMessage,
	unseenLinesMessage,
	writeDriftWarning,
	type RevealedLine,
} from "../hashline/messages.ts";
import { ParseFailureError } from "../hashline/parser.ts";
import { buildPreview } from "../hashline/preview.ts";
import { tryRecover } from "../hashline/recovery.ts";
import type { ApplyResult, BlockOpKind, BlockResolution, BlockSpan, Edit } from "../hashline/types.ts";
import { firstChangedLineOf, numberedDiff } from "../shared/numdiff.ts";
import { computeFileTag, seenLinesFromBody, snapshots } from "../shared/snapshots.ts";
import { denormalizeText, displayPath, normalizeText, pathExists, resolvePath } from "../shared/util.ts";

/** Named registers persist across edit calls within the session and across
 * the extension via globalThis. */
const REGISTER_KEY = Symbol.for("omp-tools.registers.v1");
const globalRegistry = globalThis as Record<PropertyKey, unknown>;
const sessionNamed = (globalRegistry[REGISTER_KEY] ??= new Map<string, string[]>()) as Map<
	string,
	string[]
>;

/** OMP `edit.enforceSeenLines` setting — defaults to true in OMP production. */
const ENFORCE_SEEN_LINES = true;

const SEEN_LINE_REVEAL_CAP = 40;
const SEEN_LINE_REVEAL_MAX_COLUMNS = 512;
const SHIFT_RESCUE_EVIDENCE_MIN_CHARS = 8;

// -- helpers ------------------------------------------------------------------

/** OMP `canonical_key`: the symlink-resolved key of an absolute path. */
async function canonicalKey(absPath: string): Promise<string> {
	try {
		return await fs.realpath(absPath);
	} catch {
		return absPath;
	}
}

/** First invalid UTF-8 byte offset, or null when the buffer decodes cleanly. */
function invalidUtf8Byte(buffer: Buffer): number | null {
	let i = 0;
	const n = buffer.length;
	while (i < n) {
		const b = buffer[i] as number;
		let extra = 0;
		if (b < 0x80) {
			i += 1;
			continue;
		}
		if (b >= 0xc2 && b <= 0xdf) extra = 1;
		else if (b >= 0xe0 && b <= 0xef) extra = 2;
		else if (b >= 0xf0 && b <= 0xf4) extra = 3;
		else return i;
		for (let j = 1; j <= extra; j++) {
			if (i + j >= n || ((buffer[i + j] as number) & 0xc0) !== 0x80) return i;
		}
		i += extra + 1;
	}
	return null;
}

interface FileRead {
	/** Symlink-resolved snapshot key. */
	canonical: string;
	/** Resolved absolute path. */
	absolute: string;
	/** Path as authored (post tag-recovery), for headers. */
	display: string;
	/** LF-normalized, BOM-stripped text ("" for existence-only REM reads). */
	text: string;
	/** Original line-ending style for the write-back. */
	encoding: { hadBom: boolean; crlf: boolean };
}

/** OMP `FileSource::try_read` for a resolved path: null when absent. */
async function readTarget(absPath: string, display: string, rem: boolean): Promise<FileRead | null> {
	if (rem) {
		// Whole-file delete needs existence, not text — binary content is fine.
		if (await pathExists(absPath)) {
			return {
				canonical: await canonicalKey(absPath),
				absolute: absPath,
				display,
				text: "",
				encoding: { hadBom: false, crlf: false },
			};
		}
		return null;
	}
	const buffer = await fs.readFile(absPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw new ToolError(`Cannot read ${display}: ${error.message}`);
	});
	if (buffer === null) return null;
	const invalid = invalidUtf8Byte(buffer);
	if (invalid !== null) {
		throw new ToolError(`${display} is not valid UTF-8 at byte ${invalid}; refusing to edit`);
	}
	const normalized = normalizeText(buffer.toString("utf8"));
	return {
		canonical: await canonicalKey(absPath),
		absolute: absPath,
		display,
		text: normalized.text,
		encoding: { hadBom: normalized.hadBom, crlf: normalized.crlf },
	};
}

/** OMP `mismatch` (mismatch.rs): record the live text, then diagnose. */
function mismatchError(section: PatchSection, canonical: string, normalized: string, expected: string): ToolError {
	const actual = computeFileTag(normalized);
	snapshots.record(canonical, normalized);
	const tagOriginPaths: string[] = [];
	for (const origin of snapshots.findByHash(expected)) {
		if (origin.path !== canonical && !tagOriginPaths.includes(origin.path)) {
			tagOriginPaths.push(origin.path);
		}
	}
	let anchorLines: number[] = [];
	try {
		anchorLines = section.collectAnchorLines();
	} catch {
		anchorLines = [];
	}
	const hashRecognized = snapshots.byHash(canonical, expected) !== null;
	return new ToolError(
		mismatchMessage({
			sectionPath: section.path,
			expectedFileHash: expected.toUpperCase(),
			actualFileHash: actual,
			fileLines: normalized.split("\n"),
			anchorLines,
			hashRecognized,
			tagOriginPaths,
		}),
	);
}

// -- shift rescue (port of the patcher.rs helpers) ------------------------------

interface ReplaceGroup {
	anchors: number[];
	body: string[];
}

/** Group consecutive replacement inserts followed by deletes. */
function replaceGroups(section: PatchSection): ReplaceGroup[] {
	const edits = section.edits();
	const groups: ReplaceGroup[] = [];
	let cursor = 0;
	while (cursor < edits.length) {
		const body: string[] = [];
		while (cursor < edits.length) {
			const edit = edits[cursor] as Edit;
			if (edit.kind === "insert" && edit.replacement) {
				body.push(edit.text);
				cursor += 1;
				continue;
			}
			break;
		}
		const anchors: number[] = [];
		while (cursor < edits.length) {
			const edit = edits[cursor] as Edit;
			if (edit.kind === "delete") {
				anchors.push(edit.anchor.line);
				cursor += 1;
				continue;
			}
			break;
		}
		if (body.length > 0 && anchors.length > 0) {
			anchors.sort((a, b) => a - b);
			groups.push({ anchors, body });
		} else if (body.length === 0 && anchors.length === 0) {
			cursor += 1;
		}
	}
	return groups;
}

/** Map each current line to the old line it descended from (Myers walk). */
function shiftedImages(oldText: string, newText: string): Array<number | null> {
	const image: Array<number | null> = new Array<number | null>(newText.split("\n").length).fill(null);
	let oldLine = 1;
	let newLine = 1;
	for (const run of diffLines(oldText, newText)) {
		const count = run.count ?? 0;
		if (run.added) {
			newLine += count;
			continue;
		}
		if (run.removed) {
			oldLine += count;
			continue;
		}
		for (let i = 0; i < count; i++) {
			if (newLine - 1 < image.length) image[newLine - 1] = oldLine;
			newLine += 1;
			oldLine += 1;
		}
	}
	return image;
}

interface VersionMap {
	seen: Set<number>;
	sameText: boolean;
	image: Array<number | null>;
}

function versionMaps(versions: Array<{ text: string; seenLines?: Set<number> }>, currentText: string): VersionMap[] {
	const maps: VersionMap[] = [];
	for (const version of versions) {
		const seen = version.seenLines && version.seenLines.size > 0 ? version.seenLines : null;
		if (seen === null) continue;
		if (version.text === currentText) maps.push({ seen, sameText: true, image: [] });
		else maps.push({ seen, sameText: false, image: shiftedImages(version.text, currentText) });
	}
	return maps;
}

function imagesSeen(maps: VersionMap[], line: number): boolean {
	return maps.some(map => {
		if (map.sameText) return map.seen.has(line);
		const source = map.image[line - 1];
		return source !== null && map.seen.has(source);
	});
}

function uniqueEvidence(currentLines: string[], line: number): string | null {
	const content = (currentLines[line - 1] ?? "").trim();
	if ([...content].length < SHIFT_RESCUE_EVIDENCE_MIN_CHARS) return null;
	let occurrences = 0;
	for (const other of currentLines) {
		if (other.trim() === content) occurrences += 1;
	}
	return occurrences === 1 ? content : null;
}

const isIdentChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

function lineCarries(bodyLine: string, evidence: string): boolean {
	const startsIdent = isIdentChar(evidence[0]);
	const endsIdent = isIdentChar(evidence[evidence.length - 1]);
	let at = bodyLine.indexOf(evidence);
	while (at !== -1) {
		const before = at > 0 ? bodyLine[at - 1] : undefined;
		const after = at + evidence.length < bodyLine.length ? bodyLine[at + evidence.length] : undefined;
		if (!(startsIdent && isIdentChar(before)) && !(endsIdent && isIdentChar(after))) return true;
		at = bodyLine.indexOf(evidence, at + 1);
	}
	return false;
}

function bodyTargets(body: string[], currentLines: string[], first: number, last: number): boolean {
	const head = uniqueEvidence(currentLines, first);
	if (head === null) return false;
	const headAt = body.findIndex(line => lineCarries(line, head));
	if (headAt === -1) return false;
	if (first === last) return true;
	const tail = uniqueEvidence(currentLines, last);
	if (tail === null) return false;
	let tailAt = -1;
	for (let i = body.length - 1; i >= 0; i--) {
		if (lineCarries(body[i] as string, tail)) {
			tailAt = i;
			break;
		}
	}
	return tailAt !== -1 && tailAt >= headAt;
}

function rescueShiftedAnchors(
	section: PatchSection,
	canonical: string,
	currentText: string,
	unseen: number[],
): number[] {
	const pending = new Set(unseen);
	const currentLines = currentText.split("\n");
	const maps = versionMaps(
		snapshots.versions(canonical).map(version => ({ text: version.text, seenLines: version.seenLines })),
		currentText,
	);
	const rescued: number[] = [];
	for (const group of replaceGroups(section)) {
		const groupUnseen = group.anchors.filter(line => pending.has(line));
		if (groupUnseen.length === 0) continue;
		const first = groupUnseen[0] as number;
		const last = groupUnseen[groupUnseen.length - 1] as number;
		if (bodyTargets(group.body, currentLines, first, last) && groupUnseen.every(line => imagesSeen(maps, line))) {
			rescued.push(...groupUnseen);
		}
	}
	return rescued;
}

/** OMP `assert_seen_lines`: reject anchors the cited tag never displayed. */
function assertSeenLines(section: PatchSection, tag: string, canonical: string, currentText: string): void {
	const snapshot = snapshots.byContent(canonical, currentText);
	if (snapshot === null) return;
	const seen = snapshot.seenLines;
	if (seen === undefined || seen.size === 0) return;
	let unseen = section.collectAnchorLines().filter(line => !seen.has(line));
	if (unseen.length === 0) return;
	const rescued = rescueShiftedAnchors(section, canonical, currentText, unseen);
	if (rescued.length > 0) {
		const rescuedSet = new Set(rescued);
		unseen = unseen.filter(line => !rescuedSet.has(line));
		if (unseen.length === 0) return;
	}
	const source = snapshot.text.split("\n");
	const revealed: RevealedLine[] = [];
	let columnTruncated = false;
	for (const line of unseen.slice(0, SEEN_LINE_REVEAL_CAP)) {
		const value = source[line - 1];
		if (value === undefined) continue;
		const chars = [...value];
		if (chars.length > SEEN_LINE_REVEAL_MAX_COLUMNS) {
			revealed.push({ line, text: chars.slice(0, SEEN_LINE_REVEAL_MAX_COLUMNS).join("") + "…" });
			columnTruncated = true;
		} else {
			revealed.push({ line, text: value });
		}
	}
	const truncated = unseen.length > revealed.length || columnTruncated;
	if (!truncated) {
		snapshots.recordSeenLines(canonical, tag, revealed.map(r => r.line));
	}
	throw new ToolError(unseenLinesMessage(section.path, unseen, tag, { lines: revealed, truncated }));
}

/** OMP `has_anchor_scoped_edit` over a resolved edit stream. */
function hasAnchorScopedEdit(edits: Edit[]): boolean {
	return edits.some(edit => {
		switch (edit.kind) {
			case "delete":
			case "cut":
			case "block":
				return true;
			case "paste":
				return edit.at.kind === "span" ? true : edit.at.cursor.kind === "before" || edit.at.cursor.kind === "after";
			case "insert":
				return edit.cursor.kind === "before" || edit.cursor.kind === "after";
		}
	});
}

// -- apply with recovery (port of apply_with_recovery) --------------------------

async function applyWithRecovery(
	section: PatchSection,
	canonical: string,
	normalized: string,
	edits: Edit[],
	clipboard: Clipboard,
): Promise<ApplyResult> {
	const expected = (section.fileHash ?? "").toUpperCase();
	const liveMatches = computeFileTag(normalized).toLowerCase() === expected.toLowerCase();
	const stored = snapshots.byHash(canonical, expected);
	const blockResolutions: BlockResolution[] = [];
	const resolveWarnings: string[] = [];
	let resolved: Edit[];
	if (hasBlockEdit(edits)) {
		let base: string;
		if (liveMatches) base = normalized;
		else if (stored !== null) base = stored.text;
		else throw mismatchError(section, canonical, normalized, expected);
		resolved = await resolveBlockEdits(
			edits,
			base,
			section.path,
			"throw",
			resolution => {
				blockResolutions.push(resolution);
			},
			warning => {
				resolveWarnings.push(warning);
			},
		);
	} else {
		resolved = edits.slice();
	}
	validateClipboardSequence(resolved, clipboard);
	if (liveMatches) {
		if (ENFORCE_SEEN_LINES) assertSeenLines(section, expected, canonical, normalized);
		const result = await applyEdits(normalized, resolved, {
			clipboard,
			path: canonical,
			onEmptyPaste: "throw",
		});
		result.blockResolutions = blockResolutions;
		result.warnings = [...resolveWarnings, ...result.warnings];
		return result;
	}
	if (!hasAnchorScopedEdit(resolved)) {
		// Only head/tail insertions: the mismatch cannot affect them.
		const result = await applyEdits(normalized, resolved, {
			clipboard,
			path: canonical,
			onEmptyPaste: "throw",
		});
		result.blockResolutions = blockResolutions;
		result.warnings = [...resolveWarnings, HEADTAIL_DRIFT_WARNING, ...result.warnings];
		return result;
	}
	const recovered = await tryRecover(snapshots, {
		path: canonical,
		currentText: normalized,
		fileHash: expected,
		edits: resolved,
		clipboard,
	});
	if (recovered !== null) {
		return {
			text: recovered.text,
			firstChangedLine: recovered.firstChangedLine,
			warnings: [...resolveWarnings, ...recovered.warnings],
			blockResolutions: [],
		};
	}
	throw mismatchError(section, canonical, normalized, expected);
}

// -- path recovery (port of recover_target) ------------------------------------

async function recoverTarget(
	section: PatchSection,
	absPath: string,
): Promise<{ section: PatchSection; absPath: string; recovered: boolean }> {
	if (await pathExists(absPath)) return { section, absPath, recovered: false };
	const tag = section.fileHash;
	if (tag === null) return { section, absPath, recovered: false };
	const authoredName = absPath.split("/").pop() ?? absPath;
	const candidates = snapshots
		.findByHash(tag)
		.filter(s => (s.path.split("/").pop() ?? s.path) === authoredName && s.path !== absPath)
		.map(s => s.path);
	const unique = [...new Set(candidates)].sort();
	if (unique.length !== 1) return { section, absPath, recovered: false };
	const candidate = unique[0] as string;
	if (!(await pathExists(candidate))) return { section, absPath, recovered: false };
	return { section: section.withPath(candidate), absPath: candidate, recovered: true };
}

// -- block resolution preview lines (port of format_block_resolution) -----------

function formatBlockResolution(resolution: BlockResolution): string {
	const templates: Record<BlockOpKind, [string, string]> = {
		replace: ["PUT N*:", ""],
		insertAfter: ["PUT >N*:", "; body lands after line "],
		cut: ["CUT N*", ""],
		pasteAfter: ["PUT >N*", "; clipboard lands after line "],
	};
	const [template, suffixTemplate] = templates[resolution.op];
	const op = template.replace("N", String(resolution.anchorLine));
	const lines = resolution.end - resolution.start + 1;
	const span =
		resolution.start === resolution.end ? `line ${resolution.start}` : `lines ${resolution.start}-${resolution.end}`;
	const suffix = suffixTemplate === "" ? "" : `${suffixTemplate}${resolution.end}`;
	return `${op} → resolved ${span} (${lines} line${lines === 1 ? "" : "s"})${suffix}`;
}

// -- carried provenance (port of session::carried_seen_lines) --------------------

function carriedSeenLines(before: string, after: string, prior: { seenLines?: Set<number> } | null): number[] {
	const seenSet = prior?.seenLines && prior.seenLines.size > 0 ? prior.seenLines : null;
	const carried: number[] = [];
	let oldLine = 1;
	let newLine = 1;
	for (const run of diffLines(before, after)) {
		const count = run.count ?? 0;
		if (run.added) {
			newLine += count;
			continue;
		}
		if (run.removed) {
			oldLine += count;
			continue;
		}
		if (oldLine === newLine) {
			for (let line = oldLine; line < oldLine + count; line++) {
				if (seenSet === null || seenSet.has(line)) carried.push(line);
			}
		}
		oldLine += count;
		newLine += count;
	}
	return carried;
}

// -- staged files ------------------------------------------------------------------

type EngineOp = "delete" | "noop" | "update";

interface StagedSection {
	section: PatchSection;
	originalPath: string;
	tag: string;
	read: FileRead;
	/** Absolute destination for an MV op. */
	dest: { absolute: string; display: string; canonical: string } | null;
	op: EngineOp;
	after: string;
	warnings: string[];
	blockResolutions: string[];
	textOverride: string | null;
}

/** Stage one parsed section (port of the per-section body of stage_patch). */
async function prepareSection(
	original: PatchSection,
	clipboard: Clipboard,
	cwd: string,
	canonicalPaths: Map<string, string>,
	staged: StagedSection[],
	sectionCount: number,
	rawInput: string,
): Promise<void> {
	let parsed;
	try {
		parsed = original.parse();
	} catch (error) {
		if (error instanceof ParseFailureError && error.failure.kind === "invalidAbsoluteRange") {
			const d = error.failure.detail;
			// OMP `parse_with_range_diagnostics`: enrich with the block span of
			// the start line when the section's file reads.
			let block: BlockSpan | null = null;
			try {
				const abs = await resolvePath(original.path, cwd);
				const target = await readTarget(abs, original.path, false);
				if (target !== null) {
					const span = await nativeBlockResolver(original.path, target.text, d.startLine);
					if (span !== null && span.start === d.startLine && span.end > d.startLine) block = span;
				}
			} catch {
				block = null;
			}
			throw new ToolError(invalidAbsoluteRangeMessage(d.patchLine, d.startLine, d.endLine, d.op, block ?? undefined, d.register));
		}
		throw error instanceof Error ? new ToolError(error.message) : new ToolError(String(error));
	}
	const tag = original.fileHash;
	if (tag === null) throw new ToolError(missingSnapshotTagMessage(original.path));

	const initialAbs = await resolvePath(original.path, cwd);
	const { section, absPath, recovered } = await recoverTarget(original, initialAbs);
	const fileOp = parsed.fileOp;
	const read = await readTarget(absPath, section.path, fileOp !== null && fileOp.kind === "rem");

	if (read === null) {
		throw new ToolError(`File not found: ${section.path}. Use the write tool to create new files.`);
	}

	const warnings = [...parsed.warnings];
	if (recovered) {
		warnings.push(pathRecoveredFromTagMessage(original.path, section.path, tag));
	}
	if (canonicalPaths.has(read.canonical)) {
		const previous = canonicalPaths.get(read.canonical) as string;
		throw new ToolError(
			`Multiple hashline sections resolve to the same file (${previous} and ${original.path}). Merge their ops under one header before applying.`,
		);
	}
	canonicalPaths.set(read.canonical, original.path);

	let dest: StagedSection["dest"] = null;
	if (fileOp !== null && fileOp.kind === "move") {
		const destAbs = await resolvePath(fileOp.dest, cwd);
		const destCanonical = await canonicalKey(destAbs);
		if (destCanonical === read.canonical) {
			throw new ToolError(`MV destination is the same as ${section.path}.`);
		}
		dest = { absolute: destAbs, display: displayPath(destAbs, cwd), canonical: destCanonical };
	}

	const edits = fileOp !== null && fileOp.kind === "rem" ? [] : parsed.edits;
	const apply = await applyWithRecovery(section, read.canonical, read.text, edits, clipboard);
	warnings.push(...apply.warnings);

	const engineOp: EngineOp =
		fileOp !== null && fileOp.kind === "rem"
			? "delete"
			: apply.text === read.text && fileOp === null
				? "noop"
				: "update";

	const item: StagedSection = {
		section,
		originalPath: original.path,
		tag,
		read,
		dest,
		op: engineOp,
		after: apply.text,
		warnings,
		blockResolutions: apply.blockResolutions.map(formatBlockResolution),
		textOverride: null,
	};
	if (engineOp === "noop" && sectionCount === 1) {
		const [count, escalated] = snapshots.recordNoop(read.canonical, snapshots.payloadHash(rawInput));
		if (escalated) {
			throw new ToolError(noChangeLoopDiagnostic(original.path, count));
		}
		item.textOverride = noChangeDiagnostic(original.path);
	}
	staged.push(item);
}

// -- commit phase (port of the session apply loop) --------------------------------

function pathDir(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx > 0 ? p.slice(0, idx) : ".";
}

async function commitSection(
	item: StagedSection,
): Promise<{ path: string; tag?: string; diff?: string; firstChangedLine?: number; text: string }> {
	const warnings = [...item.warnings];
	const sectionPath = item.section.path;
	if (item.op === "delete") {
		const read = item.read;
		await fs.unlink(read.absolute).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw new ToolError(`Cannot delete ${read.display}: ${error.message}`);
		});
		snapshots.invalidate(read.canonical);
		return { path: sectionPath, text: `Deleted ${read.display}` };
	}
	const read = item.read;
	if (item.op === "noop") {
		// OMP: record the same-content snapshot but write nothing; the noop
		// loop counter is NOT reset here (only successful updates reset it).
		snapshots.record(read.canonical, read.text);
		return { path: sectionPath, text: item.textOverride as string };
	}

	// Update (optionally moved).
	const writeAbs = item.dest !== null ? item.dest.absolute : read.absolute;
	const writeDisplay = item.dest !== null ? item.dest.display : read.display;
	await fs.mkdir(pathDir(writeAbs), { recursive: true });
	const written = denormalizeText(item.after, read.encoding);
	await fs.writeFile(writeAbs, written, "utf8").catch((error: NodeJS.ErrnoException) => {
		throw new ToolError(`Cannot write ${writeDisplay}: ${error.message}`);
	});
	if (item.dest !== null) {
		await fs.unlink(read.absolute).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw new ToolError(`Cannot delete ${read.display}: ${error.message}`);
		});
	}

	// Persisted-view drift check (write_drift_warning).
	let persistedText: string | null = null;
	try {
		const persistedRaw = await fs.readFile(writeAbs);
		if (invalidUtf8Byte(persistedRaw) === null) {
			persistedText = normalizeText(persistedRaw.toString("utf8")).text;
		}
	} catch {
		persistedText = null;
	}
	const drifted = persistedText !== item.after;
	if (item.dest === null && drifted) warnings.push(writeDriftWarning(writeDisplay));
	const recorded = persistedText ?? item.after;

	const prior = snapshots.byContent(read.canonical, read.text);
	const key = item.dest !== null ? item.dest.canonical : read.canonical;
	if (item.dest !== null) snapshots.relocate(read.canonical, item.dest.canonical);
	const tag = snapshots.record(key, recorded);
	snapshots.resetNoop(read.canonical);

	const headerPath = item.dest !== null ? item.dest.display : read.display;
	let text: string;
	if (item.textOverride !== null) {
		text = item.textOverride;
	} else {
		const lines: string[] = [`[${headerPath}#${tag}]`, ...item.blockResolutions];
		if (item.dest !== null) lines.push(`Moved to ${item.dest.display}`);
		const preview = buildPreview(read.text, item.after);
		if (preview.length > 0) lines.push(preview);
		const body = lines.filter(line => line.length > 0).join("\n");
		text = warnings.length > 0 ? `${body}\n\nWarnings:\n${warnings.join("\n")}` : body;
	}

	// Seen-line provenance against the minted tag. A drifted write shows rows
	// of the previewed text, not of the recorded version the tag names, so
	// only carried lines stay anchorable.
	const seenLines = new Set(carriedSeenLines(read.text, recorded, prior));
	if (!drifted) {
		for (const line of seenLinesFromBody(text)) seenLines.add(line);
	}
	if (seenLines.size > 0) snapshots.recordSeenLines(key, tag, [...seenLines]);

	const diff = numberedDiff(read.text, item.after, 2);
	const firstChanged = firstChangedLineOf(diff);
	return { path: sectionPath, tag, diff, firstChangedLine: firstChanged, text };
}

// -- tool entry point -----------------------------------------------------------------

export async function executeEdit(input: string, ctx?: ToolCtx): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	const patch = Patch.parse(input);
	if (patch.sections.length === 0) {
		throw new ToolError("No hashline sections found in input.");
	}

	// OMP `store.start_clipboard_batch`: named registers carried in, a fresh
	// anonymous pending slot.
	const batch = new Clipboard();
	batch.named = new Map(sessionNamed);
	batch.lines = null;

	const canonicalPaths = new Map<string, string>();
	const staged: StagedSection[] = [];
	for (const original of patch.sections) {
		await prepareSection(original, batch, cwd, canonicalPaths, staged, patch.sections.length, input);
	}

	// OMP: any Noop among several sections is a hard error (nothing is written).
	if (staged.length > 1) {
		const noopItem = staged.find(item => item.op === "noop");
		if (noopItem !== undefined) {
			const [count, escalated] = snapshots.recordNoop(noopItem.read.canonical, snapshots.payloadHash(input));
			throw new ToolError(
				escalated
					? noChangeLoopDiagnostic(noopItem.section.path, count)
					: noChangeDiagnostic(noopItem.section.path),
			);
		}
	}

	// Commit phase: write everything only after every section staged.
	const committed = [];
	for (const item of staged) {
		committed.push(await commitSection(item));
	}

	// Merge the transactional named registers back into the session.
	if (batch.named !== null) {
		for (const [name, lines] of batch.named) sessionNamed.set(name, lines);
	}

	const text = committed.map(c => c.text).filter(t => t.length > 0).join("\n\n");
	return textResult(text, {
		sections: committed.map(c => ({ path: c.path, tag: c.tag, diff: c.diff, firstChangedLine: c.firstChangedLine })),
		diff: committed.map(c => c.diff ?? "").filter(Boolean).join("\n\n"),
		firstChangedLine: committed.map(c => c.firstChangedLine).find(v => typeof v === "number"),
	});
}
