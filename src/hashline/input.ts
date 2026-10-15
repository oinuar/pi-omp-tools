/**
 * Top-level parser for hashline file sections (port of OMP's
 * `modes/hashline/input.rs`).
 */
import { HL_FILE_HASH_EXAMPLES, HL_FILE_HASH_LENGTH } from "./format.ts";
import {
	ABORT_MARKER,
	BEGIN_PATCH_MARKER,
	CLIPBOARD_INTERLEAVED_SECTIONS,
	END_PATCH_MARKER,
	jsonQuote,
} from "./messages.ts";
import { hasClipboardEdit } from "./clipboard.ts";
import { parsePatch, type ParseFailure, ParseFailureError } from "./parser.ts";
import { Tokenizer, headerPathHasOrphanBracket } from "./tokenizer.ts";
import type { Cursor, Edit, FileOp, ParsedRange } from "./types.ts";

/** Envelope and abort sentinels recognized when nested inside a header row. */
const ENVELOPE_MARKERS: string[] = [BEGIN_PATCH_MARKER, END_PATCH_MARKER, ABORT_MARKER];

const APPLY_PATCH_PATH_NOISE_RE =
	/^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*/i;
const RECOVERY_TAG_RE = /#([0-9A-Fa-f]{4})\s*$/;
const UNIFIED_HUNK_RE = /^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/;

/** Parsed edits, optional file operation, and parser warnings for one section. */
export interface SectionParsed {
	edits: Edit[];
	fileOp: FileOp | null;
	warnings: string[];
}

interface RawSection {
	path: string;
	fileHash: string | null;
	diff: string;
	interleaved: boolean;
}

/** One target file section with a lazily memoized parsed body. */
export class PatchSection {
	path: string;
	fileHash: string | null;
	diff: string;
	private parsed: SectionParsed | { error: string } | { failure: ParseFailure } | null = null;
	private interleaved: boolean;

	/** Construct a section from its authored path, optional tag, and body. */
	constructor(path: string, fileHash: string | null, diff: string) {
		this.path = path;
		this.fileHash = fileHash;
		this.diff = diff;
		this.interleaved = false;
	}

	static fromRaw(raw: RawSection): PatchSection {
		const section = new PatchSection(raw.path, raw.fileHash, raw.diff);
		section.interleaved = raw.interleaved;
		return section;
	}

	/** Parse and memoize this section's body. */
	parse(): SectionParsed {
		if (this.parsed !== null) {
			if ("error" in this.parsed) throw new Error(this.parsed.error);
			if ("failure" in this.parsed) throw new ParseFailureError(this.parsed.failure);
			return this.parsed;
		}
		let result: SectionParsed | { error: string } | { failure: ParseFailure };
		try {
			const parsed = parsePatch(this.diff);
			if (this.interleaved && hasClipboardEdit(parsed.edits)) {
				throw new Error(CLIPBOARD_INTERLEAVED_SECTIONS);
			}
			if (parsed.fileOp !== null && parsed.fileOp.kind === "move") {
				parsed.fileOp.dest = normalizeHashlinePath(parsed.fileOp.dest, null);
			}
			result = parsed;
		} catch (error) {
			if (error instanceof ParseFailureError) {
				this.parsed = { failure: error.failure };
				throw error;
			}
			result = { error: error instanceof Error ? error.message : String(error) };
		}
		this.parsed = result;
		if ("error" in result) throw new Error(result.error);
		return result;
	}

	/** Return the parsed low-level edits. */
	edits(): Edit[] {
		return this.parse().edits;
	}

	/** Return the optional whole-file operation. */
	fileOp(): FileOp | null {
		return this.parse().fileOp;
	}

	/** Return parser recovery warnings. */
	warnings(): string[] {
		return this.parse().warnings;
	}

	/** Whether any edit targets concrete source content. */
	hasAnchorScopedEdit(): boolean {
		return this.edits().some(edit => {
			switch (edit.kind) {
				case "delete":
				case "cut":
				case "block":
					return true;
				case "paste":
					return edit.at.kind === "span"
						? true
						: edit.at.cursor.kind === "before" || edit.at.cursor.kind === "after";
				case "insert":
					return edit.cursor.kind === "before" || edit.cursor.kind === "after";
			}
		});
	}

	/** Collect concrete anchor lines in ascending order without duplicates. */
	collectAnchorLines(): number[] {
		const lines: number[] = [];
		for (const edit of this.edits()) {
			switch (edit.kind) {
				case "delete":
				case "block":
					lines.push(edit.anchor.line);
					break;
				case "cut":
					for (let line = edit.range.start.line; line <= edit.range.end.line; line++) {
						lines.push(line);
					}
					break;
				case "paste":
					if (edit.at.kind === "span") {
						for (
							let line = edit.at.range.start.line;
							line <= edit.at.range.end.line;
							line++
						) {
							lines.push(line);
						}
					} else if (edit.at.cursor.kind === "before" || edit.at.cursor.kind === "after") {
						lines.push(edit.at.cursor.line);
					}
					break;
				case "insert":
					if (edit.cursor.kind === "before" || edit.cursor.kind === "after") {
						lines.push(edit.cursor.line);
					}
					break;
			}
		}
		lines.sort((a, b) => a - b);
		return [...new Set(lines)];
	}

	/** Rebind this section to another path while preserving its cached parse. */
	withPath(path: string): PatchSection {
		const next = new PatchSection(path, this.fileHash, this.diff);
		next.interleaved = this.interleaved;
		if (this.parsed !== null && !("error" in this.parsed)) {
			next.parsed = this.parsed;
		}
		return next;
	}
}

/** A parsed multi-file hashline patch. */
export class Patch {
	sections: PatchSection[];

	private constructor(sections: PatchSection[]) {
		this.sections = sections;
	}

	/** Split and coalesce authored file sections. */
	static parse(input: string, options: SplitOptions = {}): Patch {
		const raw = mergeSamePathSections(splitRawSections(input, options));
		return new Patch(raw.map(rawSection => PatchSection.fromRaw(rawSection)));
	}

	/** Parse exactly the first section, rejecting an empty patch. */
	static parseSingle(input: string, options: SplitOptions = {}): PatchSection {
		const section = Patch.parse(input, options).sections[0];
		if (!section) throw new Error("Patch input did not produce any sections.");
		return section;
	}
}

/** Optional context for section splitting and headerless streaming recovery. */
export interface SplitOptions {
	/** Working directory used to shorten absolute header paths. */
	cwd?: string;
	/** Target path used when a streaming body has no header yet. */
	path?: string;
}

/** Whether any input row is a recognizable hashline operation header. */
export function containsRecognizableHashlineOperations(input: string): boolean {
	const tokenizer = new Tokenizer();
	return input.split("\n").some(line => tokenizer.isOp(line.replace(/\r$/, "")));
}

function unquote(path: string): string {
	if (
		path.length >= 2 &&
		((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))
	) {
		return path.slice(1, -1);
	}
	return path;
}

function lexicalNormalize(path: string): string {
	const parts = path.split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	const joined = out.join("/");
	return path.startsWith("/") ? (joined.length > 0 ? `/${joined}` : "/") : joined;
}

function normalizeHashlinePath(raw: string, cwd: string | null): string {
	const cleaned = unquote(raw.trim()).replace(APPLY_PATCH_PATH_NOISE_RE, "");
	if (cwd === null || !cleaned.startsWith("/")) return cleaned;
	const normalized = lexicalNormalize(cleaned);
	const normalizedCwd = lexicalNormalize(cwd);
	const prefix = normalizedCwd.endsWith("/") ? normalizedCwd : `${normalizedCwd}/`;
	if (normalized === normalizedCwd) return ".";
	if (normalized.startsWith(prefix)) {
		const relative = normalized.slice(prefix.length);
		return relative.length > 0 ? relative : ".";
	}
	return cleaned;
}

type HeaderLineResult = { section: RawSection } | { error: string } | null;

function parseHeaderLine(line: string, cwd: string | null): HeaderLineResult {
	const trimmed = unbracketEnvelopeMarkers(line.replace(/\s+$/, ""));
	if (!trimmed.startsWith("[")) return null;
	const tokenizer = new Tokenizer();
	const token = tokenizer.tokenize(trimmed, 0);
	if (token.kind === "header") {
		const path = normalizeHashlinePath(token.path, cwd);
		if (path.length === 0) {
			return { error: 'Input header "[]" is empty; provide a file path.' };
		}
		return {
			section: {
				path,
				fileHash: token.fileHash ?? null,
				diff: "",
				interleaved: false,
			},
		};
	}
	const recovered = recoverHeader(trimmed, cwd);
	if (recovered !== null) return { section: recovered };
	return {
		error: `Input header must be [PATH] or [PATH#TAG] with a ${HL_FILE_HASH_LENGTH}-hex content-hash tag; got ${jsonQuote(trimmed)}.`,
	};
}

function recoverHeader(line: string, cwd: string | null): RawSection | null {
	if (!line.startsWith("[")) return null;
	const inner = line.slice(1);
	const body = (inner.endsWith("]") ? inner.slice(0, -1) : inner).trim();
	const cleaned = body.replace(APPLY_PATCH_PATH_NOISE_RE, "");
	if (cleaned.length === 0) return null;
	const match = cleaned.match(RECOVERY_TAG_RE);
	let pathText: string;
	let fileHash: string | null;
	if (match !== null && match.index !== undefined) {
		pathText = cleaned.slice(0, match.index);
		fileHash = match[1].toUpperCase();
	} else {
		pathText = cleaned;
		fileHash = null;
	}
	// Only a recovered tag disambiguates a `#` inside the path; untagged, it is
	// a malformed tag (`a.ts#1A2B copied`), not part of a file name.
	if ((fileHash === null && pathText.includes("#")) || headerPathHasOrphanBracket(pathText)) {
		return null;
	}
	const path = normalizeHashlinePath(pathText, cwd);
	if (path.length === 0) return null;
	return { path, fileHash, diff: "", interleaved: false };
}

/**
 * Unwrap leading bracketed `apply_patch` envelope markers from a row.
 */
function unbracketEnvelopeMarkers(line: string): string {
	let rest = line;
	for (;;) {
		if (!rest.startsWith("[")) return rest;
		const inner = rest.slice(1).replace(/^\s+/, "");
		const marker = ENVELOPE_MARKERS.find(m => inner.startsWith(m));
		if (marker === undefined) return rest;
		let tail = inner.slice(marker.length).replace(/^\s+/, "");
		tail = (tail.startsWith("]") ? tail.slice(1) : tail).replace(/^\s+/, "");
		if (tail.length === 0) return marker;
		rest = tail;
	}
}

function stripLeadingBlanks(input: string): string {
	const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const tokenizer = new Tokenizer();
	const lines = text.split("\n");
	while (
		lines.length > 0 &&
		(() => {
			const clean = unbracketEnvelopeMarkers(lines[0].replace(/\s+$/, ""));
			return (
				clean.trim().length === 0 || tokenizer.tokenize(clean, 0).kind === "envelopeBegin"
			);
		})()
	) {
		lines.shift();
	}
	return lines.join("\n");
}

function splitRawSections(input: string, options: SplitOptions): RawSection[] {
	const normalized = normalizeFallback(input, options);
	const stripped = stripLeadingBlanks(normalized);
	const lines = stripped.split("\n").map(line => (line.endsWith("\r") ? line.slice(0, -1) : line));
	const first = lines[0] ?? "";
	const firstHeader = parseHeaderLine(first, options.cwd ?? null);
	if (firstHeader === null) {
		if (isUnifiedHeader(first.replace(/\s+$/, ""))) {
			throw new Error(
				"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. File sections start with `[path#HASH]`; use `replace`, `delete`, or `insert` ops.",
			);
		}
		const preview = Array.from(first).slice(0, 120).join("");
		throw new Error(
			`input must begin with "[PATH#HASH]" on the first non-blank line for anchored edits; got: ${jsonQuote(preview)}. Example: "[src/foo.ts#${HL_FILE_HASH_EXAMPLES[0]}]" then edit ops.`,
		);
	}
	if (typeof firstHeader === "object" && "error" in firstHeader) {
		throw new Error(firstHeader.error);
	}
	const tokenizer = new Tokenizer();
	const sections: RawSection[] = [];
	let current: RawSection | null = null;
	const body: string[] = [];
	for (const line of lines) {
		const clean = unbracketEnvelopeMarkers(line.replace(/\s+$/, ""));
		const token = tokenizer.tokenize(clean, 0);
		if (token.kind === "envelopeEnd" || token.kind === "abort") break;
		if (token.kind === "envelopeBegin") continue;
		if (clean.startsWith("[")) {
			const parsed = parseHeaderLine(clean, options.cwd ?? null);
			if (parsed !== null && !("error" in parsed)) {
				flushSection(sections, { current }, body);
				current = parsed.section;
				continue;
			}
		}
		body.push(line);
	}
	flushSection(sections, { current }, body);
	return sections;
}

function normalizeFallback(input: string, options: SplitOptions): string {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	for (const line of stripped.split("\n")) {
		if (parseHeaderLine(line, options.cwd ?? null) !== null) return input;
	}
	if (options.path === undefined) return input;
	if (!containsRecognizableHashlineOperations(input)) return input;
	const path = normalizeHashlinePath(options.path, options.cwd ?? null);
	if (path.length === 0) return input;
	return `[${path}]\n${input}`;
}

function flushSection(
	sections: RawSection[],
	slot: { current: RawSection | null },
	body: string[],
): void {
	const section = slot.current;
	slot.current = null;
	if (section === null) {
		body.length = 0;
		return;
	}
	if (body.some(line => line.trim().length > 0)) {
		section.diff = body.join("\n");
		sections.push(section);
	}
	body.length = 0;
}

function mergeSamePathSections(sections: RawSection[]): RawSection[] {
	const result: RawSection[] = [];
	const positions = new Map<string, number>();
	let previous: string | null = null;
	for (const section of sections) {
		const index = positions.get(section.path);
		if (index !== undefined) {
			const existing = result[index];
			if (
				existing.fileHash !== null &&
				section.fileHash !== null &&
				existing.fileHash !== section.fileHash
			) {
				throw new Error(
					`Conflicting hashline snapshot tags for ${section.path}: #${existing.fileHash} and #${section.fileHash}. Re-read the file and retry with one current header.`,
				);
			}
			if (existing.fileHash === null) {
				existing.fileHash = section.fileHash;
			}
			if (previous !== section.path) {
				existing.interleaved = true;
			}
			existing.diff += `\n${section.diff}`;
			previous = section.path;
			continue;
		}
		positions.set(section.path, result.length);
		previous = section.path;
		result.push(section);
	}
	return result;
}

function isUnifiedHeader(line: string): boolean {
	return UNIFIED_HUNK_RE.test(line);
}

