/**
 * Stale-tag anchor recovery (port of OMP's `modes/hashline/recovery.rs`).
 *
 * When a section's tag no longer matches the live file, the anchors are
 * rebased from the retained snapshot onto the current text: a line diff
 * maps the old lines to the new ones, the map must be uniform, the context
 * around every anchor must still be consistent, and the enclosing
 * constructs must be the same ones the edit was authored against.
 */
import { diffLines } from "diff";
import {
	RECOVERY_EXTERNAL_WARNING,
	RECOVERY_LINE_REMAP_WARNING,
	RECOVERY_SESSION_CHAIN_WARNING,
} from "./messages.ts";
import { nodeChain } from "./syntax.ts";
import type { Clipboard } from "./clipboard.ts";
import type { Anchor, Cursor, Edit, ParsedRange } from "./types.ts";
import { applyEdits } from "./apply.ts";
import type { Snapshot } from "../shared/snapshots.ts";

/** Inputs for stale-snapshot recovery. */
export interface RecoveryArgs {
	/** Canonical target path. */
	path: string;
	/** Current LF-normalized file text. */
	currentText: string;
	/** Requested stale snapshot tag. */
	fileHash: string;
	/** Parsed edits anchored against the stale snapshot. */
	edits: Edit[];
	/** Transactional clipboard, when the patch uses cut/paste. */
	clipboard?: Clipboard | null;
}

/** Successfully recovered application result. */
export interface RecoveryResult {
	/** Recovered post-edit text. */
	text: string;
	/** First changed line in the live file. */
	firstChangedLine?: number;
	/** Recovery banner followed by apply-time warnings. */
	warnings: string[];
}

interface StoreLike {
	byHash(path: string, hash: string): Snapshot | null;
	head(path: string): Snapshot | null;
}

function editAnchors(edit: Edit): Anchor[] {
	switch (edit.kind) {
		case "delete":
		case "block":
			return [edit.anchor];
		case "cut":
			return rangeAnchors(edit.range);
		case "paste":
			if (edit.at.kind === "span") return rangeAnchors(edit.at.range);
			return cursorAnchors(edit.at.cursor);
		case "insert":
			return cursorAnchors(edit.cursor);
	}
}

function rangeAnchors(range: ParsedRange): Anchor[] {
	const out: Anchor[] = [];
	for (let line = range.start.line; line <= range.end.line; line++) out.push({ line });
	return out;
}

function cursorAnchors(cursor: Cursor): Anchor[] {
	if (cursor.kind === "before" || cursor.kind === "after") return [{ line: cursor.line }];
	return [];
}

/**
 * Map old line numbers to new ones across the line diff: only unchanged
 * lines get a mapping, and equal runs advance both sides together.
 */
function buildLineMap(previous: string, current: string): Map<number, number> {
	const map = new Map<number, number>();
	let previousLine = 1;
	let currentLine = 1;
	for (const change of diffLines(previous, current)) {
		const count = change.count;
		if (change.added) {
			currentLine += count;
		} else if (change.removed) {
			previousLine += count;
		} else {
			for (let offset = 0; offset < count; offset++) {
				map.set(previousLine + offset, currentLine + offset);
			}
			previousLine += count;
			currentLine += count;
		}
	}
	return map;
}

function duplicatedValues(lines: string[]): Set<string> {
	const seen = new Set<string>();
	const duplicated = new Set<string>();
	for (const line of lines) {
		if (!seen.has(line)) seen.add(line);
		else duplicated.add(line);
	}
	return duplicated;
}

interface Neighbors {
	before: number | null;
	after: number | null;
}

function anchorNeighbors(anchorLines: Set<number>, lineCount: number): Map<number, Neighbors> {
	const sorted = [...anchorLines].sort((a, b) => a - b);
	const neighbors = new Map<number, Neighbors>();
	let i = 0;
	while (i < sorted.length) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
		const start = sorted[i];
		const end = sorted[j];
		const before = start > 1 ? start - 1 : null;
		const after = end < lineCount ? end + 1 : null;
		for (let k = i; k <= j; k++) {
			neighbors.set(sorted[k], { before, after });
		}
		i = j + 1;
	}
	return neighbors;
}

function validateContext(
	previous: string,
	current: string,
	lineMap: Map<number, number>,
	edits: Edit[],
): boolean {
	const previousLines = previous.split("\n");
	const currentLines = current.split("\n");
	const anchors = new Set<number>();
	for (const edit of edits) {
		for (const anchor of editAnchors(edit)) anchors.add(anchor.line);
	}
	const previousDuplicates = duplicatedValues(previousLines);
	const currentDuplicates = duplicatedValues(currentLines);
	const neighbors = anchorNeighbors(anchors, previousLines.length);
	for (const [line, neighbor] of neighbors) {
		const mapped = lineMap.get(line);
		if (mapped === undefined) return false;
		const previousValue = previousLines[line - 1] ?? "";
		const currentValue = currentLines[mapped - 1] ?? "";
		if (!previousDuplicates.has(previousValue) && !currentDuplicates.has(currentValue)) {
			const offset = mapped - line;
			let afterMatches = false;
			if (neighbor.after !== null) {
				const value = lineMap.get(neighbor.after);
				afterMatches = value !== undefined && value === neighbor.after + offset;
			}
			let beforeMatches = false;
			if (neighbor.before !== null) {
				const value = lineMap.get(neighbor.before);
				beforeMatches = value !== undefined && value === neighbor.before + offset;
			}
			if (!afterMatches && !beforeMatches) return false;
		} else {
			let checked = false;
			if (neighbor.before !== null) {
				checked = true;
				if (lineMap.get(neighbor.before) !== mapped - (line - neighbor.before)) return false;
			}
			if (neighbor.after !== null) {
				checked = true;
				if (lineMap.get(neighbor.after) !== mapped + (neighbor.after - line)) return false;
			}
			if (!checked) return false;
		}
	}
	return true;
}

function mapLine(
	lineMap: Map<number, number>,
	line: number,
	offsets: number[],
): number | undefined {
	const mapped = lineMap.get(line);
	if (mapped === undefined) return undefined;
	offsets.push(mapped - line);
	return mapped;
}

function remapEdits(
	previous: string,
	current: string,
	edits: Edit[],
): { remapped: Edit[]; offset: number } | null {
	const lineMap = buildLineMap(previous, current);
	if (!validateContext(previous, current, lineMap, edits)) return null;
	const offsets: number[] = [];
	const remapped: Edit[] = new Array(edits.length);
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		switch (edit.kind) {
			case "delete": {
				const line = mapLine(lineMap, edit.anchor.line, offsets);
				if (line === undefined) return null;
				remapped[i] = { ...edit, anchor: { line } };
				break;
			}
			case "block": {
				const line = mapLine(lineMap, edit.anchor.line, offsets);
				if (line === undefined) return null;
				remapped[i] = { ...edit, anchor: { line } };
				break;
			}
			case "cut": {
				const start = mapLine(lineMap, edit.range.start.line, offsets);
				if (start === undefined) return null;
				let end = start;
				for (let line = edit.range.start.line + 1; line <= edit.range.end.line; line++) {
					const mapped = mapLine(lineMap, line, offsets);
					if (mapped === undefined) return null;
					end = mapped;
				}
				remapped[i] = { ...edit, range: { start: { line: start }, end: { line: end } } };
				break;
			}
			case "paste": {
				let blockStart: number | undefined;
				if (edit.blockStart !== undefined) {
					const mapped = mapLine(lineMap, edit.blockStart, offsets);
					if (mapped === undefined) return null;
					blockStart = mapped;
				}
				let at = edit.at;
				if (at.kind === "span") {
					const start = mapLine(lineMap, at.range.start.line, offsets);
					if (start === undefined) return null;
					let end = start;
					for (let line = at.range.start.line + 1; line <= at.range.end.line; line++) {
						const mapped = mapLine(lineMap, line, offsets);
						if (mapped === undefined) return null;
						end = mapped;
					}
					at = { kind: "span", range: { start: { line: start }, end: { line: end } } };
				} else if (at.cursor.kind === "before" || at.cursor.kind === "after") {
					const line = mapLine(lineMap, at.cursor.line, offsets);
					if (line === undefined) return null;
					at = { kind: "gap", cursor: { ...at.cursor, line } };
				}
				remapped[i] = { ...edit, at, blockStart };
				break;
			}
			case "insert": {
				let blockStart: number | undefined;
				if (edit.blockStart !== undefined) {
					const mapped = mapLine(lineMap, edit.blockStart, offsets);
					if (mapped === undefined) return null;
					blockStart = mapped;
				}
				let cursor = edit.cursor;
				if (cursor.kind === "before" || cursor.kind === "after") {
					const line = mapLine(lineMap, cursor.line, offsets);
					if (line === undefined) return null;
					cursor = { ...cursor, line };
				}
				remapped[i] = { ...edit, cursor, blockStart };
				break;
			}
		}
	}
	const first = offsets[0];
	if (first === undefined) return null;
	for (const offset of offsets) {
		if (offset !== first) return null;
	}
	return { remapped, offset: first };
}

/**
 * Identity of the constructs enclosing `line`: each node's kind paired with
 * the trimmed text of the row it opens, innermost first.
 */
async function enclosingContext(lines: string[], path: string, line: number): Promise<string> {
	const chain = await nodeChain(lines, path, line);
	return chain
		.map(span => {
			const opener = lines[span.startLine - 1];
			return opener === undefined ? null : `${span.kind}:${opener.trim()}`;
		})
		.filter((pair): pair is string => pair !== null)
		.join("\u0000");
}

/**
 * Whether every remapped anchor still sits in the construct it was authored
 * against.
 *
 * The line map is built from a text diff, which only aligns equal rows: an
 * anchor whose row is repeated in the file can therefore map onto the
 * identical row of a sibling construct with a uniform offset and matching
 * neighbors, and the edit lands in the wrong block while every positional
 * check passes. Comparing the enclosing constructs by content rejects those
 * landings. Unparsed or non-source targets report no chain on either side and
 * stay allowed.
 */
async function contextPreserved(
	previous: string,
	current: string,
	path: string | null,
	authored: Edit[],
	remapped: Edit[],
): Promise<boolean> {
	if (path === null) return true;
	const previousLines = previous.split("\n");
	const currentLines = current.split("\n");
	const checked = new Set<string>();
	for (let i = 0; i < authored.length; i++) {
		// The offset is uniform across a remapped patch, so the endpoints of a
		// span pin the interior: parsing every line of a wide CUT would not.
		const authoredAnchors = editAnchors(authored[i]);
		const remappedAnchors = editAnchors(remapped[i]);
		const edges: Array<[Anchor | undefined, Anchor | undefined]> = [
			[authoredAnchors[0], remappedAnchors[0]],
			[authoredAnchors[authoredAnchors.length - 1], remappedAnchors[remappedAnchors.length - 1]],
		];
		for (const [a, r] of edges) {
			if (a === undefined || r === undefined) continue;
			const key = `${a.line}\u0000${r.line}`;
			if (!checked.add(key)) continue;
			const before = await enclosingContext(previousLines, path, a.line);
			const after = await enclosingContext(currentLines, path, r.line);
			if (before !== after) return false;
		}
	}
	return true;
}

/** Attempt to rebase stale anchors from a retained snapshot onto current text. */
export async function tryRecover(
	store: StoreLike,
	args: RecoveryArgs,
): Promise<RecoveryResult | null> {
	const snapshot = store.byHash(args.path, args.fileHash);
	if (snapshot === null) return null;
	const head = store.head(args.path);
	const warning = head !== null && head.text === snapshot.text ? RECOVERY_EXTERNAL_WARNING : RECOVERY_SESSION_CHAIN_WARNING;
	const remapped = remapEdits(snapshot.text, args.currentText, args.edits);
	if (remapped === null) return null;
	if (!(await contextPreserved(snapshot.text, args.currentText, args.path, args.edits, remapped.remapped))) {
		return null;
	}
	let applied;
	try {
		applied = await applyEdits(args.currentText, remapped.remapped, {
			clipboard: args.clipboard ?? null,
			path: args.path,
			onEmptyPaste: "throw",
		});
	} catch {
		return null;
	}
	if (applied.text === args.currentText) return null;
	const warnings: string[] = [remapped.offset === 0 ? warning : RECOVERY_LINE_REMAP_WARNING];
	warnings.push(...applied.warnings);
	return {
		text: applied.text,
		firstChangedLine: applied.firstChangedLine,
		warnings,
	};
}
