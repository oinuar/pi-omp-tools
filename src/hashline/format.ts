/**
 * Hashline syntax constants and display helpers (port of OMP's
 * `modes/hashline/format.rs`).
 */
import type { Cursor } from "./types.ts";

/** File-header opening delimiter. */
export const HL_FILE_PREFIX = "[";
/** File-header closing delimiter. */
export const HL_FILE_SUFFIX = "]";
/** Literal payload-row sigil. */
export const HL_PAYLOAD_REPLACE = "+";
/** Write-hunk keyword. */
export const HL_PUT_KEYWORD = "PUT";
/** Cut-hunk keyword. */
export const HL_CUT_KEYWORD = "CUT";
/** Whole-file removal keyword. */
export const HL_REM_KEYWORD = "REM";
/** Whole-file move keyword. */
export const HL_MOVE_KEYWORD = "MV";
/** Header/body delimiter. */
export const HL_HEADER_COLON = ":";
/** Before-anchor gap sigil. */
export const HL_GAP_BEFORE = "<";
/** After-anchor gap sigil. */
export const HL_GAP_AFTER = ">";
/** Syntactic-block locator suffix. */
export const HL_BLOCK_SUFFIX = "*";
/** End-of-file anchor. */
export const HL_EOF_ANCHOR = "$";
/** Clipboard-register sigil. */
export const HL_REGISTER_SIGIL = "@";
/** Path/tag separator. */
export const HL_FILE_HASH_SEP = "#";
/** Canonical inclusive-range separator. */
export const HL_RANGE_SEP = ".=";
/** Numbered-line body separator. */
export const HL_LINE_BODY_SEP = ":";
/** Regex source for a positive line number. */
export const HL_LINE_RE_RAW = "[1-9]\\d*";
/** Number of hexadecimal characters in a snapshot tag. */
export const HL_FILE_HASH_LENGTH = 4;
/** Regex source for a snapshot tag. */
export const HL_FILE_HASH_RE_RAW = "[0-9A-F]{4}";
/** Representative snapshot tags used in diagnostics. */
export const HL_FILE_HASH_EXAMPLES = ["1A2B", "3C4D", "9F3E"];

/** Format a concrete replacement hunk header. */
export function formatReplaceHeader(start: number, end: number): string {
	return `PUT ${start}${HL_RANGE_SEP}${end}:`;
}

/** Format a concrete cut hunk header. */
export function formatCutHeader(start: number, end: number): string {
	return `CUT ${start}${HL_RANGE_SEP}${end}`;
}

/** Format a gap locator. */
export function formatGapLocator(cursor: Cursor): string {
	switch (cursor.kind) {
		case "bof":
			return "<1";
		case "eof":
			return ">$";
		case "before":
			return `<${cursor.line}`;
		case "after":
			return `>${cursor.line}`;
	}
}

/** Format an insertion hunk header. */
export function formatInsertHeader(cursor: Cursor): string {
	return `PUT ${formatGapLocator(cursor)}:`;
}

/** Format a named clipboard register. */
export function formatRegister(name: string): string {
	return `@${name}`;
}

/** Format representative line anchors for a diagnostic. */
export function describeAnchorExamples(linePrefix: string): string {
	const examples = linePrefix.length === 0
		? ["160", "42", "7"]
		: (() => {
			const shortened = linePrefix.slice(0, -1);
			return [linePrefix, `${shortened || "4"}2`, "7"];
		})();
	return examples.map(example => `"${example}"`).join(", ");
}

/** Format a file section header. */
export function formatHashlineHeader(path: string, tag: string): string {
	return `[${path}#${tag}]`;
}

/** Format one numbered source line. */
export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}:${line}`;
}

/** Split text into lines addressable by hashline anchors. */
export function splitAddressableFileLines(text: string): string[] {
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

/** Format every LF-delimited row, including a terminal blank sentinel. */
export function formatNumberedLines(text: string, startLine: number): string {
	return text
		.split("\n")
		.map((line, index) => formatNumberedLine(startLine + index, line))
		.join("\n");
}
