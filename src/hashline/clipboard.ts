/**
 * Clipboard edit resolution (port of OMP's `modes/hashline/clipboard.rs`).
 */
import {
	EMPTY_PASTE,
	ambiguousAnonymousPasteMessage,
	emptyRegisterPasteWarning,
	emptyRegisterSpanPasteMessage,
} from "./messages.ts";
import type { Anchor, Cursor, Edit, PasteTarget } from "./types.ts";
import { HashlineError } from "./error.ts";
import type { EmptyPaste } from "./apply.ts";

/** Clipboard registers threaded through one patch application. */
export class Clipboard {
	/** Latest anonymous cut. */
	lines: string[] | null = null;
	/** Named registers, retained between batches. */
	named: Map<string, string[]> | null = null;
	/** Anonymous cuts not yet consumed. */
	pendingAnonCuts: string[] | null = null;

	/** Start a batch with named registers only. */
	static startBatch(source: Clipboard): Clipboard {
		const batch = new Clipboard();
		batch.named = source.named === null ? null : new Map(source.named);
		return batch;
	}

	/** Make a transactional deep copy. */
	fork(): Clipboard {
		const fork = new Clipboard();
		fork.lines = this.lines === null ? null : this.lines.slice();
		fork.named = this.named === null ? null : new Map([...this.named].map(([k, v]) => [k, v.slice()]));
		fork.pendingAnonCuts = this.pendingAnonCuts === null ? null : this.pendingAnonCuts.slice();
		return fork;
	}

	/** Merge named registers from a completed transaction. */
	commitFrom(fork: Clipboard): void {
		if (fork.named === null) return;
		if (this.named === null) this.named = new Map();
		for (const [name, lines] of fork.named) this.named.set(name, lines.slice());
	}
}



function describeCut(edit: Extract<Edit, { kind: "cut" }>): string {
	const range = edit.range;
	const span =
		range.start.line === range.end.line
			? String(range.start.line)
			: `${range.start.line}.=${range.end.line}`;
	return edit.register !== undefined ? `CUT ${span} @${edit.register}` : `CUT ${span}`;
}

/** Whether an edit stream contains an operation that reads or writes a clipboard register. */
export function hasClipboardEdit(edits: Edit[]): boolean {
	return edits.some(edit => {
		switch (edit.kind) {
			case "cut":
			case "paste":
				return true;
			case "block":
				return edit.mode === "cut" || edit.mode === "pasteAfter" || edit.register !== undefined;
			default:
				return false;
		}
	});
}

function knownRegisters(clipboard: Clipboard): string[] {
	const known = clipboard.named === null ? [] : [...clipboard.named.keys()];
	known.sort();
	return known;
}

function readRegister(
	register: string | undefined,
	span: boolean,
	clipboard: Clipboard,
	lineNum: number,
	onEmptyPaste: EmptyPaste,
	onWarning: (warning: string) => void,
): string[] | null {
	if (register !== undefined) {
		const lines = clipboard.named?.get(register);
		if (lines !== undefined) return lines.slice();
		if (onEmptyPaste === "drop") return null;
		const known = knownRegisters(clipboard);
		if (span) {
			throw new HashlineError(
				`line ${lineNum}: ${emptyRegisterSpanPasteMessage(register, known)}`,
			);
		}
		onWarning(`line ${lineNum}: ${emptyRegisterPasteWarning(register, known)}`);
		return [];
	}
	const pending = clipboard.pendingAnonCuts ?? [];
	if (pending.length > 1) {
		if (onEmptyPaste === "drop") return null;
		throw new HashlineError(`line ${lineNum}: ${ambiguousAnonymousPasteMessage(pending)}`);
	}
	if (clipboard.lines === null) {
		if (onEmptyPaste === "drop") return null;
		throw new HashlineError(`line ${lineNum}: ${EMPTY_PASTE}`);
	}
	clipboard.pendingAnonCuts = [];
	return clipboard.lines;
}

function writeRegister(edit: Extract<Edit, { kind: "cut" }>, fileLines: string[], clipboard: Clipboard): void {
	const { range, lineNum } = edit;
	if (range.start.line === 0 || range.end.line > fileLines.length) {
		throw new HashlineError(
			`line ${lineNum}: \`${describeCut(edit)}\` is out of range (file has ${fileLines.length} lines).`,
		);
	}
	const captured = fileLines.slice(range.start.line - 1, range.end.line);
	if (edit.register !== undefined) {
		if (clipboard.named === null) clipboard.named = new Map();
		clipboard.named.set(edit.register, captured);
	} else {
		clipboard.lines = captured;
		if (clipboard.pendingAnonCuts === null) clipboard.pendingAnonCuts = [];
		clipboard.pendingAnonCuts.push(describeCut(edit));
	}
}

/** Lower cut/paste operations into inserts and deletes against the original file lines. */
export function resolveClipboardEdits(
	edits: Edit[],
	fileLines: string[],
	clipboard: Clipboard,
	onEmptyPaste: EmptyPaste,
	onWarning: (warning: string) => void,
): Edit[] {
	if (!hasClipboardEdit(edits)) return edits.slice();
	const resolved: Edit[] = [];
	let synthIndex = 0;
	for (const edit of edits) {
		if (edit.kind === "cut") {
			writeRegister(edit, fileLines, clipboard);
			continue;
		}
		if (edit.kind === "paste") {
			const lines = readRegister(
				edit.register,
				edit.at.kind === "span",
				clipboard,
				edit.lineNum,
				onEmptyPaste,
				onWarning,
			);
			if (lines === null) continue;
		if (edit.at.kind === "gap") {
			const cursor = edit.at.cursor;
			for (const text of lines) {
				resolved.push({
					kind: "insert",
					cursor,
					text,
					lineNum: edit.lineNum,
					index: synthIndex,
					replacement: false,
					blockStart: edit.blockStart,
				});
				synthIndex += 1;
			}
		} else {
			const range = edit.at.range;
			if (range.start.line === 0 || range.end.line > fileLines.length) {
				const registerSuffix =
					edit.register !== undefined ? ` @${edit.register}` : "";
				throw new HashlineError(
					`line ${edit.lineNum}: \`PUT ${range.start.line}.=${range.end.line}${registerSuffix}\` is out of range (file has ${fileLines.length} lines).`,
				);
			}
			const cursor: Cursor = { kind: "before", line: range.start.line };
			for (const text of lines) {
				resolved.push({
					kind: "insert",
					cursor,
					text,
					lineNum: edit.lineNum,
					index: synthIndex,
					replacement: true,
				});
				synthIndex += 1;
			}
			for (let line = range.start.line; line <= range.end.line; line++) {
				const anchor: Anchor = { line };
				resolved.push({
					kind: "delete",
					anchor,
					lineNum: edit.lineNum,
					index: synthIndex,
					oldAssertion: null,
				});
				synthIndex += 1;
			}
		}
			continue;
		}
		resolved.push(edit);
	}
	return resolved;
}

/** Validate anonymous clipboard sequencing without mutating the supplied clipboard. */
export function validateClipboardSequence(edits: Edit[], clipboard: Clipboard): void {
	const fork = clipboard.fork();
	for (const edit of edits) {
		if (edit.kind === "cut") {
			if (edit.register !== undefined) {
				if (fork.named === null) fork.named = new Map();
				fork.named.set(edit.register, []);
			} else {
				fork.lines = [];
				if (fork.pendingAnonCuts === null) fork.pendingAnonCuts = [];
				fork.pendingAnonCuts.push(describeCut(edit));
			}
		} else if (edit.kind === "paste") {
			readRegister(
				edit.register,
				edit.at.kind === "span",
				fork,
				edit.lineNum,
				"throw",
				() => {},
			);
		}
	}
}
