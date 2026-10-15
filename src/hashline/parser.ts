/**
 * Token-driven parser for hashline section bodies (port of OMP's
 * `modes/hashline/parser.rs`).
 */
import {
	BARE_BODY_AUTO_PIPED_WARNING,
	BARE_RANGE_AUTO_PUT_WARNING,
	COLONLESS_PUT_TAKES_NO_BODY,
	COLONLESS_SPAN_PUT,
	COLON_ON_REGISTER_PUT,
	CUT_COLON_IGNORED_WARNING,
	CUT_TAKES_NO_BODY,
	DIFF_OLD_ROWS_IGNORED_WARNING,
	EMPTY_INSERT,
	EMPTY_PUT_AUTO_CUT_WARNING,
	type AbsoluteRangeOp,
	invalidAbsoluteRangeMessage,
	jsonQuote,
	MINUS_BULLET_AUTO_PIPED_WARNING,
	MINUS_ROW_REJECTED,
	MOVE_TAKES_NO_BODY,
	REGISTER_PUT_TAKES_NO_BODY,
	READ_METADATA_IGNORED_WARNING,
	REM_TAKES_NO_BODY,
	REPLACE_PAIR_COALESCED_WARNING,
	SNAPSHOT_ROWS_AUTO_PUT_WARNING,
	literalOpRowWarning,
	repeatedSnapshotRowMessage,
} from "./messages.ts";
import { isReadMetadataLine, stripOneLeadingHashlinePrefix } from "./prefixes.ts";
import {
	Tokenizer,
	isHunkHeaderText,
	type BlockTarget,
	type Token,
	targetRegister,
} from "./tokenizer.ts";
import type {
	Anchor,
	BlockMode,
	BlockSpan,
	Cursor,
	Edit,
	FileOp,
	ParsedRange,
	PasteTarget,
} from "./types.ts";

const MAX_EXPANDED_RANGE_LINES = 100_000;
const UNIFIED_HUNK_RE = /^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/;

/** Inverted concrete range with metadata for source-aware enrichment. */
export interface InvalidAbsoluteRange {
	patchLine: number;
	startLine: number;
	endLine: number;
	op: AbsoluteRangeOp;
	register?: string;
	block?: BlockSpan;
}

/** Failure raised while lowering hashline tokens. */
export type ParseFailure =
	| { kind: "invalidAbsoluteRange"; detail: InvalidAbsoluteRange }
	| { kind: "other"; message: string };

/** Render a parse failure into its model-facing message. */
export function parseFailureMessage(failure: ParseFailure): string {
	if (failure.kind === "invalidAbsoluteRange") {
		const d = failure.detail;
		return invalidAbsoluteRangeMessage(
			d.patchLine,
			d.startLine,
			d.endLine,
			d.op,
			d.block,
			d.register,
		);
	}
	return failure.message;
}

/** Thrown for parse failures; carries the structured failure for the runner. */
export class ParseFailureError extends Error {
	failure: ParseFailure;

	constructor(failure: ParseFailure) {
		super(parseFailureMessage(failure));
		this.name = "ParseFailureError";
		this.failure = failure;
	}
}

interface PayloadRow {
	text: string;
	lineNum: number;
	bare: boolean;
	minus: boolean;
}

interface Pending {
	target: BlockTarget;
	lineNum: number;
	payloads: PayloadRow[];
	hadColon: boolean;
	deferredBlanks: PayloadRow[];
}

/** Result of parsing one section body. */
export interface Parsed {
	edits: Edit[];
	fileOp: FileOp | null;
	warnings: string[];
}

/** Incremental token-to-edit executor. */
class Executor {
	private edits: Edit[] = [];
	private warnings: string[] = [];
	private editIndex = 0;
	private pending: Pending | null = null;
	private fileOp: FileOp | null = null;
	private terminated = false;
	private skippableComments: { lineNum: number; text: string }[] = [];
	private recoveredSnapshotLines = new Set<number>();

	/** Consume one classified token. */
	feed(token: Token): void {
		if (this.terminated) return;
		switch (token.kind) {
			case "envelopeBegin":
				this.consumeComments();
				return;
			case "envelopeEnd":
				this.consumeComments();
				this.terminated = true;
				return;
			case "abort":
				this.terminated = true;
				return;
			case "header":
				this.consumeComments();
				this.flushPending();
				return;
			case "blank":
				this.consumeComments();
				this.handleBlank("", token.lineNum);
				return;
			case "payloadLiteral":
				this.consumeComments();
				this.handleLiteral(token.text, token.lineNum);
				return;
			case "raw":
				if (this.pending === null && token.text.trimStart().startsWith("#")) {
					this.skippableComments.push({ lineNum: token.lineNum, text: token.text });
					return;
				}
				this.consumeComments();
				this.handleRaw(token.text, token.lineNum);
				return;
			case "opBlock": {
				this.skippableComments.length = 0;
				if (token.target.kind === "replace") {
					validateRange(token.target.range, token.lineNum, "replace", token.target.register);
				}
				if (token.target.kind === "cut") {
					validateRange(token.target.range, token.lineNum, "cut", token.target.register);
				}
				if (token.hadColon && (token.target.kind === "cut" || token.target.kind === "cutBlock")) {
					this.warnOnce(CUT_COLON_IGNORED_WARNING);
				}
				if (
					token.hadColon &&
					token.target.kind !== "rem" &&
					token.target.kind !== "move" &&
					targetRegister(token.target) !== undefined
				) {
					throw failAt(token.lineNum, COLON_ON_REGISTER_PUT);
				}
				switch (token.target.kind) {
					case "rem":
						this.flushPending();
						this.setFileOp({ kind: "rem" }, token.lineNum);
						return;
					case "move":
						this.flushPending();
						this.setFileOp({ kind: "move", dest: token.target.dest }, token.lineNum);
						return;
					default:
						this.flushPending();
						this.pending = {
							target: token.target,
							lineNum: token.lineNum,
							payloads: [],
							hadColon: token.hadColon,
							deferredBlanks: [],
						};
						return;
				}
			}
		}
	}

	/** Finish a parse and reset the executor. */
	finish(streaming: boolean): Parsed {
		this.consumeComments();
		if (streaming) {
			const flush =
				this.pending !== null &&
				(this.pending.payloads.length > 0 || completeBodyless(this.pending));
			if (flush) {
				this.flushPending();
			} else {
				this.pending = null;
			}
		} else {
			this.flushPending();
		}
		if (this.fileOp !== null && this.fileOp.kind === "rem" && this.edits.length > 0) {
			throw failAt(0, "`REM` deletes the whole file and cannot be combined with line ops.");
		}
		this.normalizeOverlaps();
		return { edits: this.edits, fileOp: this.fileOp, warnings: this.warnings };
	}

	private warnOnce(warning: string): void {
		if (!this.warnings.includes(warning)) this.warnings.push(warning);
	}

	private consumeComments(): void {
		const comments = this.skippableComments;
		this.skippableComments = [];
		for (const { lineNum, text } of comments) {
			this.handleRaw(text, lineNum);
		}
	}

	private setFileOp(op: FileOp, lineNum: number): void {
		if (this.fileOp !== null) {
			throw failAt(
				lineNum,
				"only one file-level op (`REM` or `MV`) per section. Merge them under one header.",
			);
		}
		if (op.kind === "rem" && this.edits.length > 0) {
			throw failAt(lineNum, REM_TAKES_NO_BODY);
		}
		this.fileOp = op;
	}

	private handleLiteral(text: string, lineNum: number): void {
		const pending = this.pending;
		if (pending === null) {
			if (this.fileOp !== null) {
				throw failAt(lineNum, MOVE_TAKES_NO_BODY);
			}
			throw failAt(lineNum, `payload line has no preceding hunk header. Got ${jsonQuote(`+${text}`)}.`);
		}
		const message = bodylessMessage(pending.target, pending.hadColon);
		if (message !== null) throw failAt(lineNum, message);
		pending.payloads.push(...pending.deferredBlanks);
		pending.deferredBlanks.length = 0;
		if (isHunkHeaderText(text)) {
			this.warnings.push(literalOpRowWarning(lineNum, text));
		}
		pending.payloads.push({ text, lineNum, bare: false, minus: false });
	}

	private handleRaw(text: string, lineNum: number): void {
		if (this.pending === null && isReadMetadataLine(text)) {
			this.warnOnce(READ_METADATA_IGNORED_WARNING);
			return;
		}
		const contamination = contaminationMessage(text);
		if (contamination !== null) throw failAt(lineNum, contamination);
		if (this.fileOp !== null) throw failAt(lineNum, MOVE_TAKES_NO_BODY);
		if (this.pending !== null) {
			const pending = this.pending;
			if (text.trim().length === 0) {
				this.handleBlank(text, lineNum);
				return;
			}
			const message = bodylessMessage(pending.target, pending.hadColon);
			if (message !== null) throw failAt(lineNum, message);
			const minus = text.trimStart().startsWith("-");
			if (!minus) this.warnOnce(BARE_BODY_AUTO_PIPED_WARNING);
			pending.payloads.push(...pending.deferredBlanks);
			pending.deferredBlanks.length = 0;
			pending.payloads.push({ text, lineNum, bare: true, minus });
			return;
		}
		if (text.trim().length === 0) return;
		const bareRange = parseBareRange(text);
		if (bareRange !== null) {
			validateRange(bareRange, lineNum, "replace", undefined);
			this.pending = {
				target: { kind: "replace", range: bareRange },
				lineNum,
				payloads: [],
				hadColon: true,
				deferredBlanks: [],
			};
			this.warnOnce(BARE_RANGE_AUTO_PUT_WARNING);
			return;
		}
		const snapshotRow = parseSnapshotRow(text);
		if (snapshotRow !== null) {
			const [line, value] = snapshotRow;
			if (!this.recoveredSnapshotLines.add(line)) {
				throw failAt(lineNum, repeatedSnapshotRowMessage(line));
			}
			const range: ParsedRange = { start: { line }, end: { line } };
			this.pushInsert({ kind: "before", line }, value, lineNum, true);
			this.pushDeleteRange(range, lineNum);
			this.warnOnce(SNAPSHOT_ROWS_AUTO_PUT_WARNING);
			return;
		}
		throw failAt(
			lineNum,
			`payload line has no preceding hunk header. Use \`PUT N.=M:\`, \`CUT N.=M\`, or \`PUT <N:\`/\`PUT >N:\` above the body. Got ${jsonQuote(text)}.`,
		);
	}

	private handleBlank(text: string, lineNum: number): void {
		const pending = this.pending;
		if (pending === null) return;
		if (
			bodylessMessage(pending.target, pending.hadColon) !== null ||
			pending.payloads.length === 0
		) {
			return;
		}
		pending.deferredBlanks.push({ text, lineNum, bare: true, minus: false });
	}

	private flushPending(): void {
		const pending = this.pending;
		if (pending === null) return;
		this.pending = null;
		this.resolveMinusRows(pending.payloads);
		stripUniformBarePrefixes(pending.payloads);
		const line = pending.lineNum;
		const target = pending.target;
		switch (target.kind) {
			case "rem":
			case "move":
				return;
			case "cut":
				this.pushCut(target.range, target.register, line);
				return;
			case "cutBlock":
				this.pushBlock(target.anchor, [], "cut", target.register, line);
				return;
			case "replace":
				if (target.register !== undefined) {
					this.pushPaste({ kind: "span", range: target.range }, target.register, line);
				} else if (pending.payloads.length === 0) {
					if (!pending.hadColon) throw failAt(line, COLONLESS_SPAN_PUT);
					this.pushDeleteRange(target.range, line);
					this.warnOnce(EMPTY_PUT_AUTO_CUT_WARNING);
				} else {
					for (const row of pending.payloads) {
						this.pushInsert(
							{ kind: "before", line: target.range.start.line },
							row.text,
							line,
							true,
						);
					}
					this.pushDeleteRange(target.range, line);
				}
				return;
			case "block":
				if (target.register !== undefined) {
					this.pushBlock(target.anchor, [], undefined, target.register, line);
				} else if (pending.payloads.length === 0) {
					if (!pending.hadColon) throw failAt(line, COLONLESS_SPAN_PUT);
					this.pushBlock(target.anchor, [], undefined, undefined, line);
					this.warnOnce(EMPTY_PUT_AUTO_CUT_WARNING);
				} else {
					this.pushBlock(
						target.anchor,
						pending.payloads.map(row => row.text),
						undefined,
						undefined,
						line,
					);
				}
				return;
			case "insertAfterBlock":
				if (target.register !== undefined || (!pending.hadColon && pending.payloads.length === 0)) {
					this.pushBlock(target.anchor, [], "pasteAfter", target.register, line);
				} else if (pending.payloads.length === 0) {
					throw failAt(line, EMPTY_INSERT);
				} else {
					this.pushBlock(
						target.anchor,
						pending.payloads.map(row => row.text),
						"insertAfter",
						undefined,
						line,
					);
				}
				return;
			default: {
				const cursor: Cursor =
					target.kind === "insertBefore"
						? { kind: "before", line: target.anchor.line }
						: target.kind === "insertAfter"
							? { kind: "after", line: target.anchor.line }
							: target.kind === "bof"
								? { kind: "bof" }
								: { kind: "eof" };
				const register = target.register;
				if (register !== undefined || (!pending.hadColon && pending.payloads.length === 0)) {
					this.pushPaste({ kind: "gap", cursor }, register, line);
				} else if (pending.payloads.length === 0) {
					throw failAt(line, EMPTY_INSERT);
				} else {
					for (const row of pending.payloads) {
						this.pushInsert(cursor, row.text, line, false);
					}
				}
				return;
			}
		}
	}

	private resolveMinusRows(rows: PayloadRow[]): void {
		const minus = rows.filter(row => row.minus);
		if (minus.length === 0) return;
		const allBullets = minus.every(row => markdownBullet(row.text));
		const explicit = rows.filter(row => !row.bare);
		if (allBullets && (explicit.length === 0 || explicit.some(row => markdownBullet(row.text)))) {
			this.warnOnce(MINUS_BULLET_AUTO_PIPED_WARNING);
			return;
		}
		if (explicit.length > 0 && !allBullets) {
			rows.splice(0, rows.length, ...rows.filter(row => !row.minus));
			this.warnOnce(DIFF_OLD_ROWS_IGNORED_WARNING);
			return;
		}
		throw failAt(minus[0].lineNum, MINUS_ROW_REJECTED);
	}

	private nextIndex(): number {
		const index = this.editIndex;
		this.editIndex += 1;
		return index;
	}

	private pushInsert(cursor: Cursor, text: string, lineNum: number, replacement: boolean): void {
		this.edits.push({
			kind: "insert",
			lineNum,
			index: this.nextIndex(),
			cursor,
			text,
			replacement,
		});
	}

	private pushDelete(anchor: Anchor, lineNum: number): void {
		this.edits.push({ kind: "delete", lineNum, index: this.nextIndex(), anchor, oldAssertion: null });
	}

	private pushDeleteRange(range: ParsedRange, lineNum: number): void {
		for (let line = range.start.line; line <= range.end.line; line++) {
			this.pushDelete({ line }, lineNum);
		}
	}

	private pushCut(range: ParsedRange, register: string | undefined, lineNum: number): void {
		this.edits.push({ kind: "cut", lineNum, index: this.nextIndex(), range, register });
		this.pushDeleteRange(range, lineNum);
	}

	private pushPaste(at: PasteTarget, register: string | undefined, lineNum: number): void {
		this.edits.push({ kind: "paste", lineNum, index: this.nextIndex(), at, register });
	}

	private pushBlock(
		anchor: Anchor,
		payloads: string[],
		mode: BlockMode | undefined,
		register: string | undefined,
		lineNum: number,
	): void {
		this.edits.push({
			kind: "block",
			lineNum,
			index: this.nextIndex(),
			anchor,
			payloads,
			mode,
			register,
		});
	}

	private normalizeOverlaps(): void {
		interface Hunk {
			lines: Set<number>;
			clipboard: boolean;
		}
		const hunks = new Map<number, Hunk>();
		const getHunk = (lineNum: number): Hunk => {
			let hunk = hunks.get(lineNum);
			if (hunk === undefined) {
				hunk = { lines: new Set(), clipboard: false };
				hunks.set(lineNum, hunk);
			}
			return hunk;
		};
		for (const edit of this.edits) {
			switch (edit.kind) {
				case "cut":
					getHunk(edit.lineNum).clipboard = true;
					break;
				case "paste":
					if (edit.at.kind === "span") {
						const hunk = getHunk(edit.lineNum);
						hunk.clipboard = true;
						for (
							let line = edit.at.range.start.line;
							line <= edit.at.range.end.line;
							line++
						) {
							hunk.lines.add(line);
						}
					}
					break;
				case "delete":
					getHunk(edit.lineNum).lines.add(edit.anchor.line);
					break;
				default:
					break;
			}
		}
		const owner = new Map<number, number>();
		const dropped = new Set<number>();
		const lineNums = [...hunks.keys()].sort((a, b) => a - b);
		for (const lineNum of lineNums) {
			const hunk = hunks.get(lineNum)!;
			if (hunk.lines.size === 0) continue;
			const overlaps: number[] = [];
			for (const line of hunk.lines) {
				const o = owner.get(line);
				if (o !== undefined) overlaps.push(o);
			}
			overlaps.sort((a, b) => a - b);
			if (overlaps.length === 0) {
				for (const line of hunk.lines) owner.set(line, lineNum);
				continue;
			}
			const previous = overlaps.length === 1 ? overlaps[0] : undefined;
			const exact =
				previous !== undefined &&
				(() => {
					const old = hunks.get(previous);
					if (old === undefined || old.clipboard) return false;
					if (old.lines.size !== hunk.lines.size) return false;
					for (const line of hunk.lines) {
						if (!old.lines.has(line)) return false;
					}
					return true;
				})();
			if (exact) {
				const prev = previous!;
				dropped.add(prev);
				for (const [line, value] of owner) {
					if (value === prev) owner.delete(line);
				}
				for (const line of hunk.lines) owner.set(line, lineNum);
				this.warnOnce(REPLACE_PAIR_COALESCED_WARNING);
				continue;
			}
			let first = 0;
			for (const line of hunk.lines) {
				if (owner.has(line)) {
					first = line;
					break;
				}
			}
			const prior = previous !== undefined ? String(previous) : "an earlier line";
			throw failAt(
				lineNum,
				`anchor line ${first} is already targeted by another hunk on line ${prior}. Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.`,
			);
		}
		if (dropped.size > 0) {
			this.edits = this.edits.filter(edit => !dropped.has(edit.lineNum));
		}
	}
}

function validateRange(
	range: ParsedRange,
	lineNum: number,
	op: AbsoluteRangeOp,
	register: string | undefined,
): void {
	if (range.end.line < range.start.line) {
		throw new ParseFailureError({
			kind: "invalidAbsoluteRange",
			detail: {
				patchLine: lineNum,
				startLine: range.start.line,
				endLine: range.end.line,
				op,
				register,
			},
		});
	}
	const span = range.end.line - range.start.line + 1;
	if (span > MAX_EXPANDED_RANGE_LINES) {
		throw failAt(
			lineNum,
			`${op} range spans ${span} lines; the maximum is ${MAX_EXPANDED_RANGE_LINES}. Split it into smaller hunks.`,
		);
	}
}

function failAt<T>(line: number, message: string): T {
	throw new ParseFailureError({ kind: "other", message: `line ${line}: ${message}` });
}

function bodylessMessage(target: BlockTarget, hadColon: boolean): string | null {
	if (target.kind === "cut" || target.kind === "cutBlock") return CUT_TAKES_NO_BODY;
	if (target.kind === "rem" || target.kind === "move") return null;
	if (targetRegister(target) !== undefined) return REGISTER_PUT_TAKES_NO_BODY;
	if (!hadColon) return COLONLESS_PUT_TAKES_NO_BODY;
	return null;
}

function completeBodyless(pending: Pending): boolean {
	const target = pending.target;
	return (
		target.kind === "cut" ||
		target.kind === "cutBlock" ||
		targetRegister(target) !== undefined ||
		(!pending.hadColon &&
			(target.kind === "insertBefore" ||
				target.kind === "insertAfter" ||
				target.kind === "insertAfterBlock" ||
				target.kind === "bof" ||
				target.kind === "eof"))
	);
}

function markdownBullet(text: string): boolean {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("- ")) return false;
	const next = [...trimmed.slice(2)][0];
	return next !== undefined && !/\s/.test(next);
}

function parseSnapshotRow(text: string): [number, string] | null {
	const trimmed = text.trimStart();
	const split = trimmed.search(/[:|]/);
	if (split === -1) return null;
	const number = trimmed.slice(0, split);
	if (number.startsWith("0") || !/^[0-9]+$/.test(number)) return null;
	const value = Number.parseInt(number, 10);
	if (!Number.isSafeInteger(value)) return null;
	return [value, trimmed.slice(split + 1)];
}

function parseBareRange(text: string): ParsedRange | null {
	const trimmed = text.trim();
	if (!trimmed.endsWith(":")) return null;
	const before = trimmed.slice(0, -1).trim();
	const numbers = before
		.split(/[\s\-\.=…]/)
		.filter(part => part.length > 0);
	if (numbers.length !== 2) return null;
	const start = Number.parseInt(numbers[0], 10);
	const end = Number.parseInt(numbers[1], 10);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		!/^[0-9]+$/.test(numbers[0]) ||
		!/^[0-9]+$/.test(numbers[1]) ||
		start === 0 ||
		end === 0
	) {
		return null;
	}
	return { start: { line: start }, end: { line: end } };
}

function shortPreview(text: string, max: number): string {
	const chars = [...text];
	return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

function contaminationMessage(text: string): string | null {
	const trimmed = text.trimStart();
	for (const prefix of ["*** Update File:", "*** Add File:", "*** Delete File:", "*** Move to:"]) {
		if (trimmed.startsWith(prefix)) {
			return `apply_patch sentinel ${jsonQuote(shortPreview(trimmed, 48))} is not valid in hashline. File sections start with \`[path#HASH]\` (no \`Update File:\` / \`Add File:\` keyword). Use \`PUT N.=M:\`, \`CUT N.=M\`, or \`PUT <N:\`/\`PUT >N:\` ops.`;
		}
	}
	if (trimmed.startsWith("@@")) {
		if (UNIFIED_HUNK_RE.test(trimmed)) {
			return "unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. Use `PUT N.=M:`, `CUT N.=M`, or `PUT <N:`/`PUT >N:` ops.";
		}
		return `\`@@\`-bracketed hunk header ${jsonQuote(shortPreview(trimmed, 48))} is not valid in hashline. Drop the \`@@ ... @@\` brackets and write a header such as \`PUT N.=M:\`.`;
	}
	if (
		trimmed.length > 0 &&
		/^[0-9\s]+$/.test(trimmed) &&
		trimmed.trim().split(/\s+/).length === 1
	) {
		const n = trimmed.trim();
		return `hunk headers need a verb and both endpoints. Use \`PUT ${n}.=${n}:\` to replace, or \`CUT ${n}.=${n}\` to delete.`;
	}
	const pieces = trimmed.replace(/:+$/, "").split(/\s+/).filter(p => p.length > 0);
	if (pieces.length === 2 && pieces.every(p => /^[0-9]+$/.test(p))) {
		return `bare range hunk header ${jsonQuote(trimmed)} is not valid. Hunk headers need a verb: use \`PUT N.=M:\` or \`CUT N.=M\`.`;
	}
	return null;
}

function stripUniformBarePrefixes(rows: PayloadRow[]): void {
	let saw = false;
	let allLiteral = true;
	for (const row of rows) {
		if (!row.bare || row.text.trim().length === 0) continue;
		saw = true;
		const stripped = stripOneLeadingHashlinePrefix(row.text);
		if (stripped === row.text) return;
		allLiteral = allLiteral && literalValue(stripped);
	}
	if (!saw || allLiteral) return;
	for (const row of rows) {
		if (!row.bare || row.text.trim().length === 0) continue;
		row.text = stripOneLeadingHashlinePrefix(row.text);
	}
}

function literalValue(text: string): boolean {
	const value = text.trim().replace(/,+$/, "").trim();
	const quoted =
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'")));
	if (quoted) return true;
	return value.length > 0 && Number.parseFloat(value) === Number(value);
}

/** Parse a complete hashline section body. */
export function parsePatch(diff: string): Parsed {
	return parseImpl(diff, false);
}

/** Parse a partial body while dropping the trailing incomplete operation. */
export function parsePatchStreaming(diff: string): Parsed {
	return parseImpl(diff, true);
}

function parseImpl(diff: string, streaming: boolean): Parsed {
	const tokenizer = new Tokenizer();
	const executor = new Executor();
	for (const token of [...tokenizer.feed(diff), ...tokenizer.end()]) {
		executor.feed(token);
	}
	return executor.finish(streaming);
}
