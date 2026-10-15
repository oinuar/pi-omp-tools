/**
 * Stateful line tokenizer for hashline patches (port of OMP's
 * `modes/hashline/tokenizer.rs`).
 */
import {
	HL_CUT_KEYWORD,
	HL_FILE_HASH_LENGTH,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
	HL_MOVE_KEYWORD,
	HL_PUT_KEYWORD,
	HL_REM_KEYWORD,
} from "./format.ts";
import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER, jsonQuote } from "./messages.ts";
import type { Anchor, ParsedRange } from "./types.ts";
import { HashlineError } from "./error.ts";

/** Locator and optional register parsed from one operation header. */
export type BlockTarget =
	| { kind: "replace"; range: ParsedRange; register?: string }
	| { kind: "block"; anchor: Anchor; register?: string }
	| { kind: "insertBefore"; anchor: Anchor; register?: string }
	| { kind: "insertAfter"; anchor: Anchor; register?: string }
	| { kind: "insertAfterBlock"; anchor: Anchor; register?: string }
	| { kind: "cut"; range: ParsedRange; register?: string }
	| { kind: "cutBlock"; anchor: Anchor; register?: string }
	| { kind: "bof"; register?: string }
	| { kind: "eof"; register?: string }
	| { kind: "rem" }
	| { kind: "move"; dest: string };

/** One classified hashline input row. */
export type Token =
	| { kind: "blank"; lineNum: number }
	| { kind: "envelopeBegin"; lineNum: number }
	| { kind: "envelopeEnd"; lineNum: number }
	| { kind: "abort"; lineNum: number }
	| { kind: "header"; lineNum: number; path: string; fileHash?: string }
	| { kind: "opBlock"; lineNum: number; target: BlockTarget; hadColon: boolean }
	| { kind: "payloadLiteral"; lineNum: number; text: string }
	| { kind: "raw"; lineNum: number; text: string };

export function targetRegister(target: BlockTarget): string | undefined {
	if (target.kind === "rem" || target.kind === "move") return undefined;
	return target.register;
}

/** Stateful line-oriented hashline tokenizer. */
export class Tokenizer {
	private buffer = "";
	private nextLineNum = 1;
	private closed = false;

	/** Feed a text chunk and return tokens for complete rows. */
	feed(chunk: string): Token[] {
		if (this.closed) throw new HashlineError("Tokenizer is closed; call reset() before reusing.");
		if (chunk.length === 0) return [];
		this.buffer += chunk;
		const tokens: Token[] = [];
		while (true) {
			const index = this.buffer.indexOf("\n");
			if (index === -1) break;
			let line = this.buffer.slice(0, index);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.buffer = this.buffer.slice(index + 1);
			tokens.push(classifyLine(line, this.nextLineNum));
			this.nextLineNum += 1;
		}
		return tokens;
	}

	/** Close the stream and classify its final unterminated row. */
	end(): Token[] {
		if (this.closed) return [];
		this.closed = true;
		if (this.buffer.length === 0) return [];
		let line = this.buffer;
		this.buffer = "";
		if (line.endsWith("\r")) line = line.slice(0, -1);
		const token = classifyLine(line, this.nextLineNum);
		this.nextLineNum += 1;
		return [token];
	}

	/** Reset this tokenizer for reuse. */
	reset(): void {
		this.buffer = "";
		this.nextLineNum = 1;
		this.closed = false;
	}

	/** Tokenize one complete string. */
	tokenizeAll(text: string): Token[] {
		this.reset();
		return [...this.feed(text), ...this.end()];
	}

	/** Classify one already-split row. */
	tokenize(line: string, lineNum: number): Token {
		return classifyLine(line, lineNum);
	}

	/** Whether a row is a complete operation header. */
	isOp(line: string): boolean {
		return parseHunkHeader(line) !== null;
	}

	/** Whether a row is a valid file header. */
	isHeader(line: string): boolean {
		return parseHeader(line) !== null;
	}
}

/** Parse a positive bare line-number anchor. */
export function parseLid(raw: string, lineNum: number): Anchor {
	const value = raw.trim();
	if (!validLineNumber(value)) {
		throw new HashlineError(
			`line ${lineNum}: expected a line number such as "160", "42", "7"; got ${jsonQuote(raw)}. Use [PATH#hash] from your latest read for file-version binding.`,
		);
	}
	const line = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(line)) throw new HashlineError("line number is too large");
	return { line };
}

/** Whether text is a complete operation header. */
export function isHunkHeaderText(text: string): boolean {
	const lead = text.trimStart();
	const hasKeyword = [HL_PUT_KEYWORD, HL_CUT_KEYWORD, HL_REM_KEYWORD, HL_MOVE_KEYWORD].some(
		keyword => lead.startsWith(keyword),
	);
	return hasKeyword && parseHunkHeader(text) !== null;
}

function validLineNumber(raw: string): boolean {
	return (
		raw.length > 0 &&
		!raw.startsWith("0") &&
		/^[0-9]+$/.test(raw) &&
		Number.parseInt(raw, 10) === Number(raw) &&
		Number(raw) <= Number.MAX_SAFE_INTEGER
	);
}

function parseNumberPrefix(raw: string): { value: number; used: number } | null {
	if (!/^[1-9]/.test(raw)) return null;
	let end = 1;
	while (end < raw.length && /[0-9]/.test(raw[end])) end++;
	const value = Number.parseInt(raw.slice(0, end), 10);
	if (!Number.isSafeInteger(value)) return null;
	return { value, used: end };
}

/** Parse `A`, `A.=B`, `A-B`, `A..B`, `A…B` (whitespace around separators). */
function parseRange(
	raw: string,
	allowSingle: boolean,
): { range: ParsedRange; used: number; hadSeparator: boolean } | null {
	const leading = raw.length - raw.trimStart().length;
	const startInfo = parseNumberPrefix(raw.slice(leading));
	if (!startInfo) return null;
	const { value: start, used } = startInfo;
	let cursor = leading + used;
	let sawNonWs = false;
	while (cursor < raw.length) {
		const ch = raw[cursor];
		if (/\s/.test(ch) || ch === "-" || ch === "." || ch === "=" || ch === "…") {
			if (!/\s/.test(ch)) sawNonWs = true;
			cursor += 1;
		} else {
			break;
		}
	}
	const endInfo = parseNumberPrefix(raw.slice(cursor));
	if (endInfo) {
		cursor += endInfo.used;
		while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;
		return {
			range: { start: { line: start }, end: { line: endInfo.value } },
			used: cursor,
			hadSeparator: true,
		};
	}
	if (!allowSingle) return null;
	if (sawNonWs && (cursor === raw.length || raw[cursor] === ":" || raw[cursor] === "@")) {
		return {
			range: { start: { line: start }, end: { line: start } },
			used: cursor,
			hadSeparator: true,
		};
	}
	return {
		range: { start: { line: start }, end: { line: start } },
		used: cursor,
		hadSeparator: false,
	};
}

function parseRegisterAndColon(
	raw: string,
	target: BlockTarget,
): { target: BlockTarget; hadColon: boolean } | null {
	let rest = raw.trimStart();
	if (rest.startsWith("@")) {
		const registerRaw = rest.slice(1);
		const nameLen = registerRaw.match(/^[A-Za-z0-9_-]*/)?.[0].length ?? 0;
		if (nameLen === 0 || nameLen > 64) return null;
		const name = registerRaw.slice(0, nameLen);
		target = withRegister(target, name);
		rest = registerRaw.slice(nameLen).trimStart();
	}
	const hadColon = rest.startsWith(":");
	if (hadColon) rest = rest.slice(1).trimStart();
	if (rest.length === 0) return { target, hadColon };
	return null;
}

function withRegister(target: BlockTarget, register: string | undefined): BlockTarget {
	if (
		target.kind === "replace" ||
		target.kind === "block" ||
		target.kind === "insertBefore" ||
		target.kind === "insertAfter" ||
		target.kind === "insertAfterBlock" ||
		target.kind === "cut" ||
		target.kind === "cutBlock" ||
		target.kind === "bof" ||
		target.kind === "eof"
	) {
		return { ...target, register };
	}
	return target;
}

function parsePutTarget(raw: string): { target: BlockTarget; hadColon: boolean } | null {
	const rest = raw.trimStart();
	if (rest.startsWith(">")) {
		const after = rest.slice(1).trimStart();
		if (after.startsWith("$")) {
			return parseRegisterAndColon(after.slice(1), { kind: "eof" });
		}
		const info = parseNumberPrefix(after);
		if (!info) return null;
		const { value: line, used } = info;
		let tail = after.slice(used);
		const block = tail.startsWith("*");
		if (block) tail = tail.slice(1);
		const target = block
			? { kind: "insertAfterBlock" as const, anchor: { line } }
			: { kind: "insertAfter" as const, anchor: { line } };
		return parseRegisterAndColon(tail, target);
	}
	if (rest.startsWith("<")) {
		const after = rest.slice(1).trimStart();
		const info = parseNumberPrefix(after);
		if (!info) return null;
		const { value: line, used } = info;
		let tail = after.slice(used);
		if (tail.startsWith("*")) tail = tail.slice(1);
		const target =
			line === 1
				? { kind: "bof" as const }
				: { kind: "insertBefore" as const, anchor: { line } };
		return parseRegisterAndColon(tail, target);
	}
	const parsed = parseRange(rest, true);
	if (!parsed) return null;
	let tail = rest.slice(parsed.used);
	if (tail.startsWith("*")) {
		if (parsed.hadSeparator) return null;
		tail = tail.slice(1);
		return parseRegisterAndColon(tail, {
			kind: "block",
			anchor: parsed.range.start,
		});
	}
	return parseRegisterAndColon(tail, {
		kind: "replace",
		range: parsed.range,
	});
}

function parseCutTarget(raw: string): { target: BlockTarget; hadColon: boolean } | null {
	const rest = raw.trimStart();
	const parsed = parseRange(rest, true);
	if (!parsed) return null;
	let tail = rest.slice(parsed.used);
	if (tail.startsWith("*")) {
		if (parsed.hadSeparator) return null;
		tail = tail.slice(1);
		return parseRegisterAndColon(tail, {
			kind: "cutBlock",
			anchor: parsed.range.start,
		});
	}
	return parseRegisterAndColon(tail, { kind: "cut", range: parsed.range });
}

function keywordTail(line: string, keyword: string): string | null {
	if (!line.startsWith(keyword)) return null;
	const rest = line.slice(keyword.length);
	if (rest.length === 0 || rest.startsWith(":") || /^\s/.test(rest)) return rest;
	return null;
}

function parseHunkHeader(line: string): { target: BlockTarget; hadColon: boolean } | null {
	const trimmed = line.trim();
	let rest = keywordTail(trimmed, HL_REM_KEYWORD);
	if (rest !== null) {
		if (rest.trim().length !== 0) return null;
		return { target: { kind: "rem" }, hadColon: false };
	}
	rest = keywordTail(trimmed, HL_MOVE_KEYWORD);
	if (rest !== null) {
		const dest = unquotePath(rest.trim());
		if (dest === null || dest.length === 0) return null;
		return { target: { kind: "move", dest }, hadColon: false };
	}
	rest = keywordTail(trimmed, HL_PUT_KEYWORD);
	if (rest !== null) return parsePutTarget(rest);
	rest = keywordTail(trimmed, HL_CUT_KEYWORD);
	if (rest !== null) return parseCutTarget(rest);
	return null;
}

function unquotePath(raw: string): string | null {
	if (
		raw.length >= 2 &&
		((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
	) {
		return raw.slice(1, -1);
	}
	if (raw.startsWith('"') || raw.startsWith("'")) return null;
	return raw;
}

/** Whether a header path closes a bracket it never opened (`Foo] [bar.ts`). */
export function headerPathHasOrphanBracket(path: string): boolean {
	let depth = 0;
	for (const ch of path) {
		if (ch === "[") depth += 1;
		else if (ch === "]") {
			if (depth === 0) return true;
			depth -= 1;
		}
	}
	return false;
}

/** Split a `[PATH]` / `[PATH#TAG]` header row. */
function parseHeader(line: string): { path: string; fileHash?: string } | null {
	const trimmed = line.replace(/\s+$/, "");
	if (!trimmed.startsWith(HL_FILE_PREFIX) || !trimmed.endsWith(HL_FILE_SUFFIX)) return null;
	const body = trimmed.slice(1, -1);
	if (body.length === 0) return null;
	const hashIndex = body.lastIndexOf(HL_FILE_HASH_SEP);
	if (hashIndex >= 0) {
		const path = body.slice(0, hashIndex);
		const hash = body.slice(hashIndex + 1);
		if (
			path.length === 0 ||
			headerPathHasOrphanBracket(path) ||
			hash.length !== HL_FILE_HASH_LENGTH ||
			!/^[0-9a-fA-F]+$/.test(hash)
		) {
			return null;
		}
		return { path, fileHash: hash.toUpperCase() };
	}
	if (headerPathHasOrphanBracket(body)) return null;
	return { path: body };
}

function markerLineEquals(line: string, marker: string): boolean {
	return line.replace(/\s+$/, "") === marker;
}

function classifyLine(line: string, lineNum: number): Token {
	if (line.length === 0) return { kind: "blank", lineNum };
	if (markerLineEquals(line, BEGIN_PATCH_MARKER)) return { kind: "envelopeBegin", lineNum };
	if (markerLineEquals(line, END_PATCH_MARKER)) return { kind: "envelopeEnd", lineNum };
	if (markerLineEquals(line, ABORT_MARKER)) return { kind: "abort", lineNum };
	const header = parseHeader(line);
	if (header) return { kind: "header", lineNum, path: header.path, fileHash: header.fileHash };
	const op = parseHunkHeader(line);
	if (op) return { kind: "opBlock", lineNum, target: op.target, hadColon: op.hadColon };
	if (line.startsWith("+")) return { kind: "payloadLiteral", lineNum, text: line.slice(1) };
	return { kind: "raw", lineNum, text: line };
}
