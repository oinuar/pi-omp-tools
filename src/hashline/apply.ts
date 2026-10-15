/**
 * Edit application with boundary repair (port of OMP's
 * `modes/hashline/apply.rs`).
 */
import {
	REPLACEMENT_INDENT_AUTO_SHIFT_WARNING,
	UNRESOLVED_BLOCK_INTERNAL,
	UNRESOLVED_CLIPBOARD_INTERNAL,
	afterInsertLandingShiftWarning,
	afterInsertOpenerEscapeWarning,
	ambiguousBoundaryEchoMessage,
	ambiguousBoundaryPlacementMessage,
	blockInsertLandingShiftWarning,
	boundaryVariantRepairWarning,
	editBrokeParseWarning,
	textualBoundaryEchoWarning,
	type BoundarySide,
} from "./messages.ts";
import { Clipboard, resolveClipboardEdits } from "./clipboard.ts";
import { enclosingBoundaries, nodeChain, parsesCleanly } from "./syntax.ts";
import type {
	Anchor,
	ApplyResult,
	BlockResolution,
	Cursor,
	Edit,
} from "./types.ts";
import { HashlineError } from "./error.ts";

/** A line containing only closing delimiters and an optional trailing separator. */
export const STRUCTURAL_CLOSER_RE = /^\s*[)\]}]+[;,]?\s*$/;

/** Behavior when an anonymous paste has no available cut. */
export type EmptyPaste = "throw" | "drop";

/** Context supplied while applying parsed edits. */
export interface ApplyOptions {
	/** Transactional clipboard shared across sections. */
	clipboard?: Clipboard | null;
	/** Display path used to infer the syntax language. */
	path?: string | null;
	/** Behavior for an empty anonymous paste. */
	onEmptyPaste?: EmptyPaste;
}

function anchors(edit: Edit): Anchor[] {
	switch (edit.kind) {
		case "delete":
			return [edit.anchor];
		case "insert": {
			const cursor = edit.cursor;
			if (cursor.kind === "before" || cursor.kind === "after") return [{ line: cursor.line }];
			return [];
		}
		default:
			return [];
	}
}

function withIndex(edit: Edit, index: number): Edit {
	if (edit.kind === "insert" || edit.kind === "delete") {
		return { ...edit, index };
	}
	return { ...edit, index };
}

function phantomLine(lines: string[]): number | null {
	return lines.length > 1 && lines[lines.length - 1] === "" ? lines.length : null;
}

function validateBounds(edits: Edit[], lines: string[]): void {
	for (const edit of edits) {
		for (const anchor of anchors(edit)) {
			if (anchor.line < 1 || anchor.line > lines.length) {
				throw new HashlineError(`Line ${anchor.line} does not exist (file has ${lines.length} lines)`);
			}
		}
	}
}

interface ReplacementGroup {
	insertIndices: number[];
	deleteIndices: number[];
	payload: string[];
	start: number;
	end: number;
}

interface ReplacementInsert {
	kind: "insert";
	cursor: { kind: "before"; line: number };
	text: string;
	replacement: true;
	lineNum: number;
	index: number;
	blockStart?: number;
}

function isReplacementInsert(edit: Edit | undefined): edit is ReplacementInsert {
	return (
		edit !== undefined &&
		edit.kind === "insert" &&
		edit.cursor.kind === "before" &&
		edit.replacement === true
	);
}

function replacementGroup(edits: Edit[], start: number): ReplacementGroup | null {
	const first = edits[start];
	if (!isReplacementInsert(first)) return null;
	const anchorLine = first.cursor.line;
	const opLine = first.lineNum;
	const insertIndices: number[] = [];
	const payload: string[] = [];
	let i = start;
	for (;;) {
		const edit = edits[i];
		if (!isReplacementInsert(edit)) break;
		if (edit.cursor.line !== anchorLine || edit.lineNum !== opLine) break;
		insertIndices.push(i);
		payload.push(edit.text);
		i += 1;
	}
	const deleteIndices: number[] = [];
	let expected = anchorLine;
	for (;;) {
		const edit = edits[i];
		if (edit === undefined || edit.kind !== "delete") break;
		if (edit.anchor.line !== expected || edit.lineNum !== opLine) break;
		deleteIndices.push(i);
		expected += 1;
		i += 1;
	}
	if (deleteIndices.length === 0) return null;
	return { insertIndices, deleteIndices, payload, start: anchorLine, end: expected - 1 };
}

function leadingIndent(line: string): string {
	let end = 0;
	while (end < line.length && (line[end] === " " || line[end] === "\t")) end += 1;
	return line.slice(0, end);
}
function indentDeeper(deeper: string, shallower: string): boolean {
	return deeper.length > shallower.length && deeper.startsWith(shallower);
}
function hasContent(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 9 || code > 13 && code !== 32) return true;
	}
	return false;
}

function repairIndentation(edits: Edit[], lines: string[]): string[] {
	let repaired = false;
	let start = 0;
	while (start < edits.length) {
		const group = replacementGroup(edits, start);
		if (group === null) {
			start += 1;
			continue;
		}
		start = (group.deleteIndices[group.deleteIndices.length - 1] ?? start) + 1;
		if (group.payload.length !== group.deleteIndices.length) continue;
		const preceding = group.start - 2 >= 0 ? lines[group.start - 2] ?? "" : "";
		const sourceFirst = lines[group.start - 1] ?? "";
		const payloadFirst = group.payload[0] ?? "";
		if (
			!preceding.replace(/\s+$/, "").endsWith("{") ||
			!indentDeeper(leadingIndent(sourceFirst), leadingIndent(preceding)) ||
			indentDeeper(leadingIndent(payloadFirst), leadingIndent(preceding))
		) {
			continue;
		}
		let shift: string | null = null;
		let matches = 0;
		let consistent = true;
		for (let offset = 0; offset < group.payload.length; offset++) {
			const payload = group.payload[offset];
			const source = lines[group.start - 1 + offset] ?? "";
			if (source.trim().length === 0 || source.trimStart() !== payload.trimStart()) continue;
			const sourceIndent = leadingIndent(source);
			const payloadIndent = leadingIndent(payload);
			if (!sourceIndent.endsWith(payloadIndent)) {
				consistent = false;
				break;
			}
			const candidate = sourceIndent.slice(0, sourceIndent.length - payloadIndent.length);
			if (shift !== null && shift !== candidate) {
				consistent = false;
				break;
			}
			shift = candidate;
			matches += 1;
		}
		if (shift === null) continue;
		if (!consistent || shift.length === 0 || matches < 2 || matches * 2 <= group.payload.length) {
			continue;
		}
		for (const index of group.insertIndices) {
			const edit = edits[index] as Extract<Edit, { kind: "insert" }>;
			if (edit.text.trim().length > 0) edit.text = shift + edit.text;
		}
		repaired = true;
	}
	return repaired ? [REPLACEMENT_INDENT_AUTO_SHIFT_WARNING] : [];
}

function duplicateLeading(group: ReplacementGroup, lines: string[]): number {
	const max = Math.min(group.payload.length, Math.max(group.start - 1, 0));
	for (let count = max; count >= 1; count--) {
		const sourceStart = group.start - 1 - count;
		const candidate = group.payload.slice(0, count);
		const allEqual = candidate.every((line, i) => line === lines[sourceStart + i]);
		if (allEqual && candidate.some(line => hasContent(line))) return count;
	}
	return 0;
}
function duplicateTrailing(group: ReplacementGroup, lines: string[]): number {
	const max = Math.min(group.payload.length, Math.max(lines.length - group.end, 0));
	for (let count = max; count >= 1; count--) {
		const payload = group.payload.slice(group.payload.length - count);
		const source = lines.slice(group.end, group.end + count);
		const allEqual = payload.every((line, i) => line === source[i]);
		if (allEqual && payload.some(line => hasContent(line))) return count;
	}
	return 0;
}
function groupInserts(group: ReplacementGroup, edits: Edit[]): Edit[] {
	return group.insertIndices.map(i => edits[i]);
}
function groupDeletes(group: ReplacementGroup, edits: Edit[]): Edit[] {
	return group.deleteIndices.map(i => edits[i]);
}

async function annotationEcho(lines: string[], path: string | null, first: number, last: number): Promise<boolean> {
	if (path === null) return false;
	for (let line = first; line <= last; line++) {
		const chain = await nodeChain(lines, path, line);
		const any = chain.some(
			node =>
				node.startLine === line &&
				node.endLine === line &&
				[
					"attribute_item",
					"inner_attribute_item",
					"decorator",
					"annotation",
					"marker_annotation",
					"attribute_list",
				].includes(node.kind),
		);
		if (!any) return false;
	}
	return true;
}

interface Ambiguity {
	start: number;
	end: number;
	side: BoundarySide;
	count: number;
}

async function normalizeEchoes(edits: Edit[], lines: string[], path: string | null) {
	const out: Edit[] = [];
	const warnings: string[] = [];
	const ambiguities: Ambiguity[] = [];
	let i = 0;
	while (i < edits.length) {
		const group = replacementGroup(edits, i);
		if (group === null) {
			out.push(withIndex(edits[i], i));
			i += 1;
			continue;
		}
		const leading = duplicateLeading(group, lines);
		const trailing = duplicateTrailing(group, lines);
		const rangeLen = group.deleteIndices.length;
		let dropL = 0;
		let dropT = 0;
		if (leading > 0 && trailing > 0) {
			if (Math.max(group.payload.length - leading - trailing, 0) === rangeLen) {
				dropL = leading;
				dropT = trailing;
			}
		} else if (
			leading > 0 &&
			(rangeLen > 1 || (await annotationEcho(lines, path, group.start - leading, group.start - 1)))
		) {
			if (Math.max(group.payload.length - leading, 0) >= rangeLen) {
				dropL = leading;
			} else {
				ambiguities.push({ start: group.start, end: group.end, side: "leading", count: leading });
			}
		} else if (
			trailing > 0 &&
			(rangeLen > 1 || (await annotationEcho(lines, path, group.end + 1, group.end + trailing)))
		) {
			if (Math.max(group.payload.length - trailing, 0) >= rangeLen) {
				dropT = trailing;
			} else {
				ambiguities.push({ start: group.start, end: group.end, side: "trailing", count: trailing });
			}
		}
		if (dropL > 0 || dropT > 0) {
			const inserts = groupInserts(group, edits);
			out.push(...inserts.slice(dropL, inserts.length - dropT));
			out.push(...groupDeletes(group, edits));
			warnings.push(textualBoundaryEchoWarning(group.start, dropL, dropT));
		} else {
			out.push(...[...group.insertIndices, ...group.deleteIndices].map(idx => withIndex(edits[idx], idx)));
		}
		i = group.deleteIndices[group.deleteIndices.length - 1] + 1;
	}
	return { out, warnings, ambiguities };
}

function indentColumns(line: string): number {
	let column = 0;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === " ") column += 1;
		else if (ch === "\t") column += 4 - (column % 4);
		else break;
	}
	return column;
}
function nearestContent(lines: string[], start: number, step: number): string | null {
	let index = start;
	while (index >= 0 && index < lines.length) {
		if (hasContent(lines[index])) return lines[index];
		index += step;
	}
	return null;
}
function payloadEdge(payload: string[], leading: boolean): string | null {
	if (leading) {
		const line = payload.find(l => hasContent(l));
		return line === undefined ? null : line;
	}
	for (let i = payload.length - 1; i >= 0; i--) {
		if (hasContent(payload[i])) return payload[i];
	}
	return null;
}
function sourceDeleted(edits: Edit[], line: number): boolean {
	return edits.some(edit => edit.kind === "delete" && edit.anchor.line === line);
}
function effectiveTrailing(group: ReplacementGroup, edits: Edit[], lines: string[]): number {
	let line = group.end;
	let survivor = group.end + 1;
	while (
		line > group.start &&
		survivor <= lines.length &&
		!sourceDeleted(edits, survivor) &&
		lines[line - 1] === lines[survivor - 1]
	) {
		line -= 1;
		survivor += 1;
	}
	return line;
}
async function essential(lines: string[], path: string, line: number, baseline: boolean): Promise<boolean> {
	if (!baseline) return true;
	const without = [...lines.slice(0, line - 1), ...lines.slice(line)].join("\n");
	return !(await parsesCleanly(path, without));
}

interface Variant {
	edits: Edit[];
	kept: number;
	dropped: number;
}

async function groupVariants(
	group: ReplacementGroup,
	edits: Edit[],
	lines: string[],
	path: string,
	baseline: boolean,
): Promise<{ variants: Variant[]; ambiguous: boolean }> {
	const inserts = groupInserts(group, edits);
	const deletes = groupDeletes(group, edits);
	const trailing = effectiveTrailing(group, edits, lines);
	const firstEssential = await essential(lines, path, group.start, baseline);
	const lastEssential =
		trailing === group.start ? firstEssential : await essential(lines, path, trailing, baseline);
	const innerStart = group.start + 1;
	const leadingStructure =
		baseline &&
		innerStart <= trailing &&
		(await enclosingBoundaries(lines, path, innerStart, trailing)).includes(group.start);
	const dropJ = duplicateLeading(group, lines);
	const dropK = duplicateTrailing(group, lines);
	const leadingDrops = dropJ > 0 ? [0, dropJ] : [0];
	const trailingDrops = dropK > 0 ? [0, dropK] : [0];
	const variants: Variant[] = [];
	let ambiguous = false;
	for (const dropL of leadingDrops) {
		for (const dropT of trailingDrops) {
			const dropped = dropL + dropT;
			if (dropped >= inserts.length) continue;
			const payload = group.payload.slice(dropL, group.payload.length - dropT);
			const lead = payloadEdge(payload, true);
			const trail = payloadEdge(payload, false);
			if (lead === null || trail === null) continue;
			const first = lines[group.start - 1] ?? "";
			const last = lines[trailing - 1] ?? "";
			const plans: Array<{ before: number | null; after: number | null; kept: number }> = [
				{ before: null, after: null, kept: 0 },
			];
			if (group.start === trailing) {
				const previous = nearestContent(lines, group.start - 2, -1);
				const fits = previous === null || indentColumns(previous) === indentColumns(trail);
				if (firstEssential && fits && indentColumns(trail) > indentColumns(first)) {
					plans.push({ before: null, after: group.start, kept: 1 });
				} else if (
					baseline &&
					firstEssential &&
					indentColumns(trail) === indentColumns(first) &&
					!(await parsesCleanly(path, materialize(lines, [...inserts, ...deletes]).text))
				) {
					// Only a replacement that breaks the file on its own leaves the
					// row's position in question (e.g. a closer swapped for a
					// statement). Swapping an `if` opener, `case` label, or signature
					// for another of the same shape parses fine alone, so a parse
					// failure elsewhere in the batch must not reject it.
					ambiguous = true;
				}
			} else {
				const next = nearestContent(lines, group.start, 1);
				const previous = nearestContent(lines, trailing - 2, -1);
				const beforeFirst = nearestContent(lines, group.start - 2, -1);
				const selectedBoundary = (
					await enclosingBoundaries(lines, path, group.start + 1, group.end)
				).includes(group.start);
				const structuralEdge =
					STRUCTURAL_CLOSER_RE.test(first.trim()) &&
					indentColumns(first) === indentColumns(lead) &&
					indentColumns(first) === indentColumns(lines[group.end - 1] ?? "");
				const underfilled =
					trailing < group.end && payload.length < group.end - group.start + 1;
				const keepsLeading =
					firstEssential &&
					(leadingStructure || selectedBoundary || structuralEdge || underfilled) &&
					(next === null ||
						(structuralEdge
							? indentColumns(lead) >= indentColumns(first)
							: indentColumns(next) === indentColumns(lead)));
				const keepsTrailing =
					(lastEssential || underfilled) &&
					!keepsLeading &&
					indentColumns(trail) > indentColumns(last) &&
					(previous === null || indentColumns(previous) === indentColumns(trail));
				if (keepsLeading) plans.push({ before: group.start, after: null, kept: 1 });
				if (keepsTrailing) plans.push({ before: null, after: trailing, kept: 1 });
				if (
					baseline &&
					firstEssential &&
					beforeFirst !== null &&
					indentColumns(first) < indentColumns(beforeFirst) &&
					indentColumns(lead) > indentColumns(first)
				) {
					ambiguous = true;
				}
			}
			for (const { before, after, kept } of plans) {
				if (kept === 0 && dropped === 0) continue;
				if (kept > 0 && group.deleteIndices.length > 1 && payload.length > group.deleteIndices.length) {
					continue;
				}
				let keptInserts: Edit[] = inserts.slice(dropL, inserts.length - dropT).map(e => ({ ...e }));
				if (before !== null) {
					const cursor: Cursor =
						before >= lines.length
							? { kind: "eof" }
							: { kind: "before", line: before + 1 };
					for (const edit of keptInserts) {
						if (edit.kind === "insert") edit.cursor = cursor;
					}
				}
				const result = [...keptInserts];
				for (const edit of deletes) {
					if (edit.kind === "delete" && (before !== null && edit.anchor.line === before || after !== null && edit.anchor.line === after)) {
						continue;
					}
					result.push(edit);
				}
				variants.push({ edits: result, kept, dropped });
			}
		}
	}
	variants.sort((a, b) => a.kept - b.kept || a.dropped - b.dropped);
	return { variants, ambiguous };
}

function spliceVariants(
	edits: Edit[],
	groups: Array<{ group: ReplacementGroup; variants: Variant[] }>,
	choices: Array<number | null>,
): Edit[] {
	const chosen = new Map<number, Variant>();
	for (let i = 0; i < groups.length; i++) {
		const choice = choices[i];
		if (choice !== null && choice !== undefined) {
			chosen.set(groups[i].group.insertIndices[0], groups[i].variants[choice]);
		}
	}
	const out: Edit[] = [];
	let i = 0;
	while (i < edits.length) {
		const group = replacementGroup(edits, i);
		if (group === null) {
			out.push(withIndex(edits[i], i));
			i += 1;
			continue;
		}
		const variant = chosen.get(group.insertIndices[0]);
		if (variant !== undefined) {
			out.push(...variant.edits);
		} else {
			out.push(...[...group.insertIndices, ...group.deleteIndices].map(idx => withIndex(edits[idx], idx)));
		}
		i = group.deleteIndices[group.deleteIndices.length - 1] + 1;
	}
	return out;
}

type RepairedEdits = { edits: Edit[]; warnings: string[] };

async function repairBoundaries(
	edits: Edit[],
	lines: string[],
	path: string | null,
	baseline: boolean,
): Promise<RepairedEdits | null> {
	if (path === null) return null;
	const groups: Array<{ group: ReplacementGroup; variants: Variant[] }> = [];
	let ambiguous: { start: number; end: number } | null = null;
	let i = 0;
	while (i < edits.length) {
		const group = replacementGroup(edits, i);
		if (group !== null) {
			const { variants, ambiguous: isAmbiguous } = await groupVariants(group, edits, lines, path, baseline);
			if (isAmbiguous && ambiguous === null) ambiguous = { start: group.start, end: group.end };
			if (variants.length > 0) groups.push({ group, variants });
			i = group.deleteIndices[group.deleteIndices.length - 1] + 1;
		} else {
			i += 1;
		}
	}
	if (groups.length === 0) {
		if (ambiguous !== null) {
			throw new HashlineError(ambiguousBoundaryPlacementMessage(ambiguous.start, ambiguous.end));
		}
		return null;
	}
	interface Combo {
		choices: Array<number | null>;
		touched: number;
		kept: number;
		dropped: number;
	}
	let combos: Combo[] = [{ choices: [], touched: 0, kept: 0, dropped: 0 }];
	for (const { variants } of groups) {
		const next: Combo[] = [];
		for (const combo of combos) {
			next.push({ ...combo, choices: [...combo.choices, null] });
			variants.forEach((variant, index) => {
				next.push({
					choices: [...combo.choices, index],
					touched: combo.touched + 1,
					kept: combo.kept + variant.kept,
					dropped: combo.dropped + variant.dropped,
				});
			});
		}
		next.sort((a, b) => a.touched - b.touched || a.kept - b.kept || a.dropped - b.dropped);
		combos = next.slice(0, 512);
	}
	const authored = materialize(lines, edits);
	combos = combos.filter(combo => combo.touched > 0);
	combos.sort((a, b) => a.touched - b.touched || a.kept - b.kept || a.dropped - b.dropped);
	let best: { combo: Combo; text: string } | null = null;
	for (const combo of combos) {
		if (best !== null) {
			const b = best.combo;
			if (
				combo.touched > b.touched ||
				(combo.touched === b.touched && combo.kept > b.kept) ||
				(combo.touched === b.touched && combo.kept === b.kept && combo.dropped > b.dropped)
			) {
				break;
			}
		}
		const candidate = spliceVariants(edits, groups, combo.choices);
		const text = materialize(lines, candidate).text;
		if (text === authored.text || !(await parsesCleanly(path, text))) continue;
		if (best !== null) {
			if (best.text !== text) {
				if (ambiguous !== null) {
					throw new HashlineError(ambiguousBoundaryPlacementMessage(ambiguous.start, ambiguous.end));
				}
				return null;
			}
		} else {
			best = { combo, text };
		}
	}
	if (best === null) {
		if (ambiguous !== null) {
			throw new HashlineError(ambiguousBoundaryPlacementMessage(ambiguous.start, ambiguous.end));
		}
		return null;
	}
	const warnings: string[] = [];
	const bestCombo = best.combo;
	groups.forEach(({ group, variants }, i) => {
		const choice = bestCombo.choices[i];
		if (choice !== null && choice !== undefined) {
			warnings.push(boundaryVariantRepairWarning(group.start, variants[choice].kept, variants[choice].dropped));
		}
	});
	return { edits: spliceVariants(edits, groups, best.combo.choices), warnings };
}

interface InsertGroup {
	anchor: number;
	members: number[];
	blockStart: number | null;
}
function bodyIndent(rows: string[]): string | null {
	const nonBlank = rows.filter(row => hasContent(row));
	if (nonBlank.length === 0 || nonBlank.every(row => STRUCTURAL_CLOSER_RE.test(row))) return null;
	let target = leadingIndent(nonBlank[0]);
	for (const row of nonBlank) {
		const indent = leadingIndent(row);
		if (indent.startsWith(target)) continue;
		if (target.startsWith(indent)) target = indent;
		else return null;
	}
	return target;
}
async function bodyRelocatable(rows: string[], path: string): Promise<boolean> {
	let last = -1;
	for (let i = rows.length - 1; i >= 0; i--) {
		if (hasContent(rows[i])) {
			last = i + 1;
			break;
		}
	}
	if (last < 0) return false;
	const owned = rows.slice();
	let line = 1;
	while (line <= last) {
		if (!hasContent(rows[line - 1])) {
			line += 1;
			continue;
		}
		const chain = await nodeChain(owned, path, line);
		const end =
			chain
				.filter(span => span.startLine === line)
				.reduce((max, span) => Math.max(max, span.endLine), 0) || 0;
		if (end === 0) return false;
		if (end >= last) return end > line;
		line = end + 1;
	}
	return false;
}

async function repairLandings(edits: Edit[], lines: string[], path: string | null) {
	const groups: Array<{ key: { anchor: number; lineNum: number }; group: InsertGroup }> = [];
	for (let index = 0; index < edits.length; index++) {
		const edit = edits[index];
		if (
			edit.kind === "insert" &&
			edit.cursor.kind === "after" &&
			edit.replacement === false
		) {
			const key = { anchor: edit.cursor.line, lineNum: edit.lineNum };
			const existing = groups.find(g => g.key.anchor === key.anchor && g.key.lineNum === key.lineNum);
			if (existing !== undefined) {
				existing.group.members.push(index);
			} else {
				groups.push({
					key,
					group: {
						anchor: edit.cursor.line,
						members: [index],
						blockStart: edit.blockStart ?? null,
					},
				});
			}
		}
	}
	const targeted = new Set<number>();
	for (const edit of edits) for (const anchor of anchors(edit)) targeted.add(anchor.line);
	const out = edits.slice();
	const warnings: string[] = [];
	for (const { group } of groups) {
		const rows: string[] = [];
		for (const index of group.members) {
			const edit = edits[index];
			if (edit.kind === "insert") rows.push(edit.text);
		}
		const target = bodyIndent(rows);
		if (target === null) continue;
		const anchorText = lines[group.anchor - 1] ?? "";
		let outward: { landing: number; crossed: number } | null = null;
		if (hasContent(anchorText) && indentDeeper(leadingIndent(anchorText), target)) {
			let landing = group.anchor;
			let crossed = 0;
			let blocked = false;
			for (let line = group.anchor + 1; line <= lines.length; line++) {
				const text = lines[line - 1];
				if (!hasContent(text)) continue;
				if (!STRUCTURAL_CLOSER_RE.test(text) || !leadingIndent(text).startsWith(target)) break;
				if (targeted.has(line)) {
					blocked = true;
					break;
				}
				landing = line;
				crossed += 1;
				if (leadingIndent(text).length === target.length) break;
			}
			if (!blocked && landing !== group.anchor) outward = { landing, crossed };
		}
		// The shift is an indentation guess. Veto it only when the shift itself
		// breaks the parse: the batch as written parses, the shifted one does
		// not (a shallower `case`, `} else {`, or member belongs before the
		// closer). Unrelated broken edits in the batch leave the shift alone.
		if (outward !== null && path !== null) {
			const trial = out.slice();
			for (const index of group.members) {
				const edit = trial[index];
				if (edit.kind === "insert") edit.cursor = { kind: "after", line: outward.landing };
			}
			if (
				(await parsesCleanly(path, materialize(lines, out).text)) &&
				!(await parsesCleanly(path, materialize(lines, trial).text))
			) {
				outward = null;
			}
		}
		if (outward !== null) {
			for (const index of group.members) {
				const edit = out[index];
				if (edit.kind === "insert") edit.cursor = { kind: "after", line: outward.landing };
			}
			warnings.push(afterInsertLandingShiftWarning(group.anchor, outward.landing, outward.crossed));
			continue;
		}
		if (group.blockStart !== null) {
			if (STRUCTURAL_CLOSER_RE.test(anchorText) && indentDeeper(target, leadingIndent(anchorText))) {
				let landing = group.anchor;
				let blocked = false;
				for (let line = group.anchor; line >= group.blockStart + 1; line--) {
					const text = lines[line - 1];
					if (!hasContent(text)) {
						landing = line - 1;
						continue;
					}
					if (!STRUCTURAL_CLOSER_RE.test(text) || !indentDeeper(target, leadingIndent(text))) break;
					if (line !== group.anchor && targeted.has(line)) {
						blocked = true;
						break;
					}
					landing = line - 1;
				}
				if (!blocked && landing !== group.anchor) {
					for (const index of group.members) {
						const edit = out[index];
						if (edit.kind === "insert") edit.cursor = { kind: "after", line: landing };
					}
					warnings.push(blockInsertLandingShiftWarning(group.blockStart, group.anchor, landing));
				}
			}
		} else if (path !== null) {
			const targetCols = indentColumns(target);
			if (targetCols < indentColumns(anchorText)) {
				const chain = await nodeChain(lines, path, group.anchor);
				if (
					chain.some(node => node.startLine === group.anchor && node.endLine > group.anchor) &&
					(await bodyRelocatable(rows, path))
				) {
					const candidates = new Set<number>();
					for (const node of chain) {
						if (
							node.endLine > group.anchor &&
							indentColumns(lines[node.startLine - 1] ?? "") <= targetCols
						) {
							candidates.add(node.endLine);
						}
					}
					for (const landing of [...candidates].sort((a, b) => a - b)) {
						if ([...targeted].some(line => line > group.anchor && line <= landing)) break;
						const trial = out.slice();
						for (const index of group.members) {
							const edit = trial[index];
							if (edit.kind === "insert") edit.cursor = { kind: "after", line: landing };
						}
						if (await parsesCleanly(path, materialize(lines, trial).text)) {
							for (const index of group.members) {
								const edit = out[index];
								if (edit.kind === "insert") edit.cursor = { kind: "after", line: landing };
							}
							warnings.push(afterInsertOpenerEscapeWarning(group.anchor, landing));
							break;
						}
					}
				}
			}
		}
	}
	return { out, warnings };
}

function materialize(original: string[], edits: Edit[]): { text: string; first?: number } {
	const lines = original.slice();
	let first: number | null = null;
	const bof: string[] = [];
	const eof: string[] = [];
	const buckets = new Map<number, Array<{ index: number; edit: Edit }>>();
	for (let index = 0; index < edits.length; index++) {
		const edit = edits[index];
		if (edit.kind === "insert") {
			if (edit.cursor.kind === "bof") bof.push(edit.text);
			else if (edit.cursor.kind === "eof") eof.push(edit.text);
			else {
				const line = edit.cursor.line;
				const bucket = buckets.get(line) ?? [];
				bucket.push({ index, edit });
				buckets.set(line, bucket);
			}
		} else if (edit.kind === "delete") {
			const bucket = buckets.get(edit.anchor.line) ?? [];
			bucket.push({ index, edit });
			buckets.set(edit.anchor.line, bucket);
		}
	}
	for (const line of [...buckets.keys()].sort((a, b) => b - a)) {
		const bucket = (buckets.get(line) ?? []).sort((a, b) => a.index - b.index);
		const index = line - 1;
		const current = lines[index] ?? "";
		const before: string[] = [];
		const replacements: string[] = [];
		const after: string[] = [];
		let delete_ = false;
		for (const { edit } of bucket) {
			if (edit.kind === "insert") {
				if (edit.cursor.kind === "after") after.push(edit.text);
				else if (edit.replacement) replacements.push(edit.text);
				else before.push(edit.text);
			} else if (edit.kind === "delete") {
				delete_ = true;
			}
		}
		if (before.length === 0 && replacements.length === 0 && after.length === 0 && !delete_) continue;
		const replacement = [...before, ...replacements];
		if (!delete_) replacement.push(current);
		replacement.push(...after);
		lines.splice(index, 1, ...replacement);
		first = first === null ? line : Math.min(first, line);
	}
	if (bof.length > 0) {
		if (lines.length === 1 && lines[0] === "") {
			lines.length = 0;
			lines.push(...bof);
		} else {
			lines.splice(0, 0, ...bof);
		}
		first = 1;
	}
	if (eof.length > 0) {
		let at: number;
		if (lines.length === 1 && lines[0] === "") {
			lines.length = 0;
			lines.push(...eof);
			at = 1;
		} else {
			const index = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
			lines.splice(index, 0, ...eof);
			at = index + 1;
		}
		first = first === null ? at : Math.min(first, at);
	}
	return { text: lines.join("\n"), first: first === null ? undefined : first };
}

/** Apply parsed edits to LF-normalized text. */
export async function applyEdits(
	text: string,
	edits: Edit[],
	options: ApplyOptions = {},
): Promise<ApplyResult> {
	if (edits.length === 0) {
		return { text, warnings: [], blockResolutions: [] };
	}
	const lines = text.split("\n");
	const localClipboard = new Clipboard();
	const clipboard = options.clipboard ?? localClipboard;
	const onEmptyPaste = options.onEmptyPaste ?? "throw";
	const path = options.path ?? null;
	const clipboardWarnings: string[] = [];
	const concrete = await resolveClipboardEdits(
		edits,
		lines,
		clipboard,
		onEmptyPaste,
		warning => {
			clipboardWarnings.push(warning);
		},
	);
	const target: Edit[] = [];
	for (const edit of concrete) {
		switch (edit.kind) {
			case "block":
				throw new HashlineError(UNRESOLVED_BLOCK_INTERNAL);
			case "cut":
			case "paste":
				throw new HashlineError(UNRESOLVED_CLIPBOARD_INTERNAL);
			default:
				target.push(edit);
		}
	}
	const phantom = phantomLine(lines);
	if (phantom !== null) {
		for (let i = target.length - 1; i >= 0; i--) {
			const edit = target[i];
			if (edit.kind === "delete" && edit.anchor.line === phantom) target.splice(i, 1);
		}
	}
	for (let index = 0; index < target.length; index++) {
		target[index] = withIndex(target[index], index);
	}
	validateBounds(target, lines);
	const indentationWarnings = repairIndentation(target, lines);
	const { out: landed, warnings: landingWarnings } = await repairLandings(target, lines, path);
	const { out: normalized, warnings: echoWarnings, ambiguities } = await normalizeEchoes(landed, lines, path);
	const leading: string[] = [
		...clipboardWarnings,
		...indentationWarnings,
		...landingWarnings,
		...echoWarnings,
	];
	const authored = materialize(lines, normalized);
	const baseline = await parsesCleanly(path, text);
	const authoredParses = await parsesCleanly(path, authored.text);
	const finish = async (
		result: { text: string; first?: number },
		warnings: string[],
	): Promise<ApplyResult> => {
		// The result text has already been parsed above, so this is a cache hit.
		if (!(await parsesCleanly(path, result.text)) && baseline) {
			warnings.push(editBrokeParseWarning(result.first));
		}
		return {
			text: result.text,
			firstChangedLine: result.first,
			warnings,
			blockResolutions: [] as BlockResolution[],
		};
	};
	if (authoredParses) {
		if (ambiguities.length > 0) {
			const ambiguity = ambiguities[0];
			throw new HashlineError(
				ambiguousBoundaryEchoMessage(ambiguity.start, ambiguity.end, ambiguity.side, ambiguity.count),
			);
		}
		return await finish(authored, leading);
	}
	const repaired = await repairBoundaries(normalized, lines, path, baseline);
	if (repaired !== null) {
		const result = materialize(lines, repaired.edits);
		if (await parsesCleanly(path, result.text)) {
			leading.push(...repaired.warnings);
			return await finish(result, leading);
		}
	}
	if (ambiguities.length > 0) {
		const ambiguity = ambiguities[0];
		throw new HashlineError(
			ambiguousBoundaryEchoMessage(ambiguity.start, ambiguity.end, ambiguity.side, ambiguity.count),
		);
	}
	return await finish(authored, leading);
}

