/**
 * Block-op resolution for `PUT N*` / `CUT N*` (port of OMP's
 * `modes/hashline/block.rs`, which resolves blocks through tree-sitter; this
 * port drives the ast-grep napi binding, which embeds the same grammars, and
 * emulates the tree-sitter-markdown block nodes for `.md` files).
 */
import { xxh32 } from "../shared/xxhash.ts";
import { STRUCTURAL_CLOSER_RE } from "./apply.ts";
import {
	type BlockDiagnosticSuggestions,
	type BlockOp,
	blockSingleLineMessage,
	blockUnresolvedMessage,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
	pasteAfterBlockCloserLoweredWarning,
	pasteAfterBlockUnresolvedLoweredWarning,
} from "./messages.ts";
import {
	hasError,
	isMarkdownPath,
	markdownSections,
	namedDescendantForPointRange,
	nodeContentEndLine,
	nodeStartLine,
	parseForPath,
	type NapiNode,
} from "./syntax.ts";
import type {
	Anchor,
	BlockMode,
	BlockOpKind,
	BlockResolution,
	BlockSpan,
	Cursor,
	Edit,
	ParsedRange,
} from "./types.ts";
import { HashlineError } from "./error.ts";

const BLOCK_SUGGESTION_SCAN_LIMIT = 64;
const RESOLUTION_CACHE_MAX = 512;

const resolutionCache = new Map<string, BlockSpan | null>();
const resolutionOrder: string[] = [];

function resolutionKey(text: string, line: number, path: string): string {
	return `${xxh32(new TextEncoder().encode(text))}:${text.length}:${line}:${path}`;
}

// ── block_range_at (pi-ast::block) emulation ───────────────────────────────

function firstContentColumn(line: string): number | null {
	for (let c = 0; c < line.length; c++) {
		const unit = line.charCodeAt(c);
		if (unit !== 0x20 && unit !== 0x09) return c;
	}
	return null;
}

const STATEMENT_SEQUENCE_KINDS = new Set([
	"statement_list",
	"block",
	"body_statement",
	"statements",
	"body",
	"indented_block",
	"block_mapping",
	"block_sequence",
	"import_list",
	"hash_literal_body",
]);

const EXTRA_COMMENT_KINDS = new Set([
	"comment",
	"line_comment",
	"block_comment",
	"comment_line",
	"comment_block",
	"multiline_comment",
	"singleline_comment",
	"doc_comment",
	"shebang",
]);

/**
 * Is `parent` a statement-sequence container that `node` merely opens? These
 * nodes wrap the sibling statements of a body without a token of their own,
 * so they begin exactly where their first child does: adopting one would
 * swallow every following sibling statement.
 */
function isStatementSequence(parent: NapiNode, node: NapiNode): boolean {
	if (!STATEMENT_SEQUENCE_KINDS.has(parent.kind())) return false;
	if (parent.range().start.index !== node.range().start.index) return false;
	const endRow = node.range().end.line;
	const startCol = node.range().start.column;
	// The next named sibling, skipping extras (comments) — emulating
	// tree-sitter's `next_named_sibling` plus its `is_extra` filter.
	let sibling = node.next();
	let skippedExtra = false;
	while (sibling !== null) {
		if (!sibling.isNamed()) {
			sibling = sibling.next();
			continue;
		}
		if (EXTRA_COMMENT_KINDS.has(sibling.kind())) {
			skippedExtra = true;
			sibling = sibling.next();
			continue;
		}
		break;
	}
	if (sibling === null) return skippedExtra;
	return sibling.range().start.line > endRow && sibling.range().start.column === startCol;
}

function markdownHeadingLevel(line: string): number | null {
	const match = /^ {0,3}(#{1,6})(\s|$)/.exec(line);
	return match === null ? null : match[1].length;
}

const MARKDOWN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const MARKDOWN_LIST_ITEM_RE = /^\s*([-*+]|\d{1,9}[.)])\s+/;

function isPlainMarkdownLine(line: string): boolean {
	return (
		line.trim().length > 0 &&
		markdownHeadingLevel(line) === null &&
		!MARKDOWN_FENCE_RE.test(line) &&
		!MARKDOWN_LIST_ITEM_RE.test(line)
	);
}

/**
 * Markdown block that *begins* on `line` (1-indexed), emulating the
 * tree-sitter-markdown nodes: a heading's `section`, a fenced code block, a
 * `list`, or a `paragraph`. A run that began earlier resolves to nothing.
 */
function markdownBlockAt(lines: string[], line: number): BlockSpan | null {
	const lastContent =
		lines.length - (lines.length > 0 && lines[lines.length - 1] === "" ? 1 : 0);
	if (line < 1 || line > lastContent) return null;
	const text = lines[line - 1];

	const heading = markdownHeadingLevel(text);
	if (heading !== null) {
		let end = lastContent;
		for (let l = line + 1; l <= lastContent; l++) {
			const level = markdownHeadingLevel(lines[l - 1]);
			if (level !== null && level <= heading) {
				end = l - 1;
				break;
			}
		}
		return { start: line, end };
	}

	const fence = MARKDOWN_FENCE_RE.exec(text);
	if (fence !== null) {
		const char = fence[1][0];
		const closeRe = new RegExp(`^ {0,3}${char === "\`" ? "`" : "~"}{3,}\\s*$`);
		let end = lastContent;
		for (let l = line + 1; l <= lastContent; l++) {
			if (closeRe.test(lines[l - 1])) {
				end = l;
				break;
			}
		}
		return { start: line, end };
	}

	if (MARKDOWN_LIST_ITEM_RE.test(text)) {
		// Only the first item line begins the list.
		if (line > 1) {
			const prev = lines[line - 2];
			if (prev !== undefined && (MARKDOWN_LIST_ITEM_RE.test(prev) || /^\s{2,}\S/.test(prev))) {
				return null;
			}
		}
		let end = line;
		for (let l = line + 1; l <= lastContent; l++) {
			const ltext = lines[l - 1];
			if (ltext.trim().length === 0) break;
			if (MARKDOWN_LIST_ITEM_RE.test(ltext) || /^\s{2,}\S/.test(ltext)) end = l;
			else break;
		}
		return { start: line, end };
	}

	if (isPlainMarkdownLine(text)) {
		// Only the first line begins the paragraph.
		if (line > 1) {
			const prev = lines[line - 2];
			if (prev !== undefined && isPlainMarkdownLine(prev)) return null;
		}
		let end = line;
		for (let l = line + 1; l <= lastContent; l++) {
			if (!isPlainMarkdownLine(lines[l - 1])) break;
			end = l;
		}
		return { start: line, end };
	}

	return null;
}

/**
 * Resolve the line span of the outermost named node that *begins* on a
 * 1-indexed line (excluding the whole-file root), or `null` when no block
 * begins there. A single-line statement yields the degenerate span
 * `{ line, line }`; callers decide what that means.
 */
async function resolveBlock(lines: string[], path: string, line: number): Promise<BlockSpan | null> {
	if (line < 1 || line > lines.length) return null;
	const text = lines.join("\n");
	if (text.length === 0) return null;
	const row = line - 1;
	const col = firstContentColumn(lines[row]);
	if (col === null) return null;

	if (isMarkdownPath(path)) return markdownBlockAt(lines, line);

	const parsed = await parseForPath(text, path);
	if (parsed === null) return null;
	const root = parsed.root;
	const startByte = parsed.lineStarts[row] + col;
	const leaf = namedDescendantForPointRange(root, startByte, startByte + 1);
	// A leaf whose own start row is earlier than `row` means the point landed
	// on a continuation line or a closing delimiter of an earlier block.
	if (leaf.range().start.line !== row) return null;
	// Climb to the outermost named ancestor that still begins on `row`,
	// excluding the whole-file root.
	let node: NapiNode = leaf;
	for (;;) {
		const parent = node.parent();
		if (parent === null) break;
		if (parent.id() === parsed.rootId) break;
		if (parent.range().start.line !== row) break;
		if (isStatementSequence(parent, node)) break;
		node = parent;
	}
	if (hasError(node)) return null;
	return { start: nodeStartLine(node), end: nodeContentEndLine(node) };
}

// ── resolution with caching (native_block_resolver) ────────────────────────

/**
 * Resolve the syntactic block at a 1-indexed line, memoized by content and
 * path (port of `native_block_resolver`).
 */
export async function nativeBlockResolver(path: string, text: string, line: number): Promise<BlockSpan | null> {
	const key = resolutionKey(text, line, path);
	if (resolutionCache.has(key)) return resolutionCache.get(key) as BlockSpan | null;
	const result = await resolveBlock(text.split("\n"), path, line);
	if (resolutionCache.size >= RESOLUTION_CACHE_MAX && resolutionOrder.length > 0) {
		const oldest = resolutionOrder.shift() as string;
		resolutionCache.delete(oldest);
	}
	resolutionOrder.push(key);
	resolutionCache.set(key, result);
	return result;
}

// ── suggestion scans ────────────────────────────────────────────────────────

/** Nearest following multi-line block beginning after the anchor. */
async function findNextBlock(anchorLine: number, lines: string[], path: string, text: string): Promise<BlockSpan | null> {
	const last = Math.min(lines.length, anchorLine + BLOCK_SUGGESTION_SCAN_LIMIT);
	for (let line = anchorLine + 1; line <= last; line++) {
		if (lines[line - 1] === undefined || lines[line - 1].trim().length === 0) continue;
		const span = await nativeBlockResolver(path, text, line);
		if (span !== null && span.start === line && span.end > line) return span;
	}
	return null;
}

/** Nearest preceding multi-line block whose span contains the anchor. */
async function findEnclosingBlock(anchorLine: number, lines: string[], path: string, text: string): Promise<BlockSpan | null> {
	const first = Math.max(1, anchorLine - BLOCK_SUGGESTION_SCAN_LIMIT);
	for (let line = anchorLine - 1; line >= first; line--) {
		if (lines[line - 1] === undefined || lines[line - 1].trim().length === 0) continue;
		const span = await nativeBlockResolver(path, text, line);
		if (span !== null && span.start === line && span.end >= anchorLine && span.end > line) return span;
	}
	return null;
}

/** Source-aware suggestions for a block-anchor diagnostic. */
export async function blockSuggestions(
	fileLines: string[],
	path: string,
	line: number,
): Promise<BlockDiagnosticSuggestions> {
	const text = fileLines.join("\n");
	const nextBlock =
		fileLines[line - 1] === undefined || fileLines[line - 1].trim().length === 0
			? await findNextBlock(line, fileLines, path, text)
			: null;
	const enclosingBlock = nextBlock === null ? await findEnclosingBlock(line, fileLines, path, text) : null;
	return { nextBlock, enclosingBlock };
}

// ── block-op lowering (resolve_block_edits) ────────────────────────────────

export type Unresolved = "throw" | "drop";

/** Whether an edit stream contains a deferred block operation. */
export function hasBlockEdit(edits: Edit[]): boolean {
	return edits.some(edit => edit.kind === "block");
}

function blockMode(mode: BlockMode | undefined): { messageOp: BlockOp; resultOp: BlockOpKind } {
	switch (mode) {
		case undefined:
			return { messageOp: "replace", resultOp: "replace" };
		case "insertAfter":
			return { messageOp: "insertAfter", resultOp: "insertAfter" };
		case "cut":
			return { messageOp: "cut", resultOp: "cut" };
		case "pasteAfter":
			return { messageOp: "pasteAfter", resultOp: "pasteAfter" };
	}
}

/** Resolve deferred block operations to ordinary edits. */
export async function resolveBlockEdits(
	edits: Edit[],
	text: string,
	path: string,
	onUnresolved: Unresolved,
	onResolved: (resolution: BlockResolution) => void,
	onWarning: (warning: string) => void,
): Promise<Edit[]> {
	if (!hasBlockEdit(edits)) return edits.slice();
	const lines = text.split("\n");
	const resolved: Edit[] = [];
	let synthIndex = 0;
	for (const edit of edits) {
		if (edit.kind !== "block") {
			resolved.push(edit);
			continue;
		}
		const anchor = edit.anchor;
		const payloads = edit.payloads;
		const mode = edit.mode;
		const register = edit.register;
		const lineNum = edit.lineNum;
		const { messageOp, resultOp } = blockMode(mode);
		const span = await nativeBlockResolver(path, text, anchor.line);
		if (span === null) {
			if (mode === "insertAfter" || mode === "pasteAfter") {
				const isCloser = STRUCTURAL_CLOSER_RE.test(lines[anchor.line - 1] ?? "");
				if (mode === "pasteAfter") {
					onWarning(
						isCloser
							? pasteAfterBlockCloserLoweredWarning(anchor.line)
							: pasteAfterBlockUnresolvedLoweredWarning(anchor.line),
					);
					resolved.push({
						kind: "paste",
						at: { kind: "gap", cursor: { kind: "after", line: anchor.line } },
						register,
						lineNum,
						index: synthIndex,
						blockStart: undefined,
					});
					synthIndex += 1;
				} else {
					onWarning(
						isCloser
							? insertAfterBlockCloserLoweredWarning(anchor.line)
							: insertAfterBlockUnresolvedLoweredWarning(anchor.line),
					);
					for (const payload of payloads) {
						resolved.push({
							kind: "insert",
							cursor: { kind: "after", line: anchor.line },
							text: payload,
							lineNum,
							index: synthIndex,
							replacement: false,
							blockStart: undefined,
						});
						synthIndex += 1;
					}
				}
				continue;
			}
			if (onUnresolved === "drop") continue;
			const anchorLine = lines[anchor.line - 1];
			const nextBlock =
				anchorLine !== undefined && anchorLine.trim().length === 0
					? await findNextBlock(anchor.line, lines, path, text)
					: null;
			const enclosingBlock = nextBlock === null ? await findEnclosingBlock(anchor.line, lines, path, text) : null;
			const suggestions: BlockDiagnosticSuggestions = { nextBlock, enclosingBlock };
			const rangeOp = messageOp === "cut" ? ("cut" as const) : ("replace" as const);
			throw new HashlineError(
				`line ${lineNum}: ${blockUnresolvedMessage(anchor.line, rangeOp, lines, suggestions, register)}`,
			);
		}
		if (span.start === span.end) {
			if (onUnresolved === "drop") continue;
			const enclosing = await findEnclosingBlock(anchor.line, lines, path, text);
			throw new HashlineError(
				`line ${lineNum}: ${blockSingleLineMessage(anchor.line, messageOp, enclosing)}`,
			);
		}
		onResolved({
			anchorLine: anchor.line,
			start: span.start,
			end: span.end,
			op: resultOp,
		});
		switch (mode) {
			case "pasteAfter": {
				resolved.push({
					kind: "paste",
					at: { kind: "gap", cursor: { kind: "after", line: span.end } },
					register,
					lineNum,
					index: synthIndex,
					blockStart: span.start,
				});
				synthIndex += 1;
				break;
			}
			case "cut": {
				const range: ParsedRange = { start: { line: span.start }, end: { line: span.end } };
				resolved.push({ kind: "cut", range, register, lineNum, index: synthIndex });
				synthIndex += 1;
				for (let line = span.start; line <= span.end; line++) {
					const deleteAnchor: Anchor = { line };
					resolved.push({ kind: "delete", anchor: deleteAnchor, lineNum, index: synthIndex, oldAssertion: null });
					synthIndex += 1;
				}
				break;
			}
			case "insertAfter": {
				for (const payload of payloads) {
					resolved.push({
						kind: "insert",
						cursor: { kind: "after", line: span.end },
						text: payload,
						lineNum,
						index: synthIndex,
						replacement: false,
						blockStart: span.start,
					});
					synthIndex += 1;
				}
				break;
			}
			case undefined: {
				if (register !== undefined) {
					const range: ParsedRange = { start: { line: span.start }, end: { line: span.end } };
					resolved.push({
						kind: "paste",
						at: { kind: "span", range },
						register,
						lineNum,
						index: synthIndex,
						blockStart: undefined,
					});
					synthIndex += 1;
				} else {
					for (const payload of payloads) {
						resolved.push({
							kind: "insert",
							cursor: { kind: "before", line: span.start },
							text: payload,
							lineNum,
							index: synthIndex,
							replacement: true,
							blockStart: undefined,
						});
						synthIndex += 1;
					}
					for (let line = span.start; line <= span.end; line++) {
						const deleteAnchor: Anchor = { line };
						resolved.push({ kind: "delete", anchor: deleteAnchor, lineNum, index: synthIndex, oldAssertion: null });
						synthIndex += 1;
					}
				}
				break;
			}
		}
	}
	return resolved;
}

/**
 * Full block-unresolved error for the applier / patcher: gathers suggestions
 * and renders the centralized message (with the anchored-context preview when
 * file lines are available).
 */
export async function blockUnresolved(
	line: number,
	op: BlockOp,
	fileLines: string[] | null,
	path: string,
	register?: string,
): Promise<string> {
	const suggestions =
		fileLines === null
			? { nextBlock: null, enclosingBlock: null }
			: await blockSuggestions(fileLines, path, line);
	const rangeOp = op === "cut" ? ("cut" as const) : ("replace" as const);
	return blockUnresolvedMessage(line, rangeOp, fileLines, suggestions, register);
}
