/**
 * Syntax probe for hashline boundary/echo repair (port of OMP's
 * `modes/hashline/syntax.rs`, whose semantics come from `pi-ast::block` /
 * `pi-ast::summary`). OMP parses with tree-sitter; this port drives the
 * ast-grep napi binding, which embeds the same tree-sitter grammars, and
 * emulates the tree-sitter-markdown `section` behavior for `.md` files
 * (heading sections span until the next same-or-higher-level heading).
 */
import { langForFile, loadNapi, resolveLang } from "../shared/astlang.ts";
import { xxh32 } from "../shared/xxhash.ts";

/** A node span as consumed by the applier and block resolver. */
export interface NodeSpan {
	/** 1-indexed inclusive first line of the node. */
	startLine: number;
	/** 1-indexed inclusive last content line of the node. */
	endLine: number;
	/** Grammar node kind (e.g. `attribute_item`, `function_item`). */
	kind: string;
}

function hashText(text: string): number {
	return xxh32(new TextEncoder().encode(text));
}

type Napi = { parse(lang: unknown, src: string): { root(): NapiNode } };
export type NapiNode = {
	id(): number;
	range(): {
		start: { line: number; column: number; index: number };
		end: { line: number; column: number; index: number };
	};
	isNamed(): boolean;
	kind(): string;
	text(): string;
	children(): NapiNode[];
	next(): NapiNode | null;
	parent(): NapiNode | null;
};

const CACHE_MAX = 256;
const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdx"]);

class SyntaxCache {
	chains = new Map<string, NodeSpan[]>();
	chainOrder: string[] = [];
	boundaries = new Map<string, number[]>();
	boundaryOrder: string[] = [];
	parses = new Map<string, boolean>();
	parseOrder: string[] = [];
	put<T>(map: Map<string, T>, order: string[], key: string, value: T): void {
		if (map.size >= CACHE_MAX && order.length > 0) map.delete(order.shift() as string);
		order.push(key);
		map.set(key, value);
	}
}
const cache = new SyntaxCache();

function key(textHash: number, textLen: number, path: string, start: number, end: number): string {
	return `${textHash}:${textLen}:${path}:${start}:${end}`;
}

// ── tree-sitter-compatible node helpers ───────────────────────────────────

/** `node_start_line`: start row + 1. */
export function nodeStartLine(node: NapiNode): number {
	return node.range().start.line + 1;
}

/**
 * `node_content_end_line`: tree-sitter reports `end_position` one past the
 * last byte; when that position is at column 0 of the next row, the naive
 * `row + 1` answer is one greater than the last visible content row.
 */
export function nodeContentEndLine(node: NapiNode): number {
	const end = node.range().end;
	const row = end.column === 0 && end.line > 0 ? end.line - 1 : end.line;
	return row + 1;
}

export function isErrorKind(kind: string): boolean {
	return kind === "ERROR" || kind === "MISSING";
}

/**
 * `named_descendant_for_point_range`: the innermost named node whose byte
 * span contains the one-column range [startByte, endByte]. Spanning a full
 * column skips zero-width separator nodes.
 */
export function namedDescendantForPointRange(root: NapiNode, startByte: number, endByte: number): NapiNode {
	let node = root;
	for (;;) {
		let next: NapiNode | null = null;
		for (const child of node.children()) {
			if (!child.isNamed()) continue;
			const range = child.range();
			if (range.start.index <= startByte && range.end.index >= endByte) {
				next = child;
				break;
			}
		}
		if (next === null) return node;
		node = next;
	}
}

/** `node.has_error()`: any ERROR/MISSING node in the subtree. */
export function hasError(node: NapiNode): boolean {
	const stack: NapiNode[] = [node];
	while (stack.length > 0) {
		const current = stack.pop() as NapiNode;
		if (isErrorKind(current.kind())) return true;
		for (const child of current.children()) stack.push(child);
	}
	return false;
}

export interface ParsedFile {
	root: NapiNode;
	rootId: number;
	lineStarts: number[];
}

export function isMarkdownPath(filePath: string): boolean {
	const dot = filePath.lastIndexOf(".");
	return dot > 0 && MARKDOWN_EXTS.has(filePath.slice(dot).toLowerCase());
}

export async function parseForPath(text: string, filePath: string): Promise<ParsedFile | null> {
	const napi = (await loadNapi()) as Napi | null;
	if (!napi) return null;
	if (isMarkdownPath(filePath)) return null;
	const langName = langForFile(filePath);
	if (langName === undefined) return null;
	const lang = await resolveLang(langName);
	if (lang === null) return null;
	let root: NapiNode;
	try {
		root = napi.parse(lang, text).root();
	} catch {
		return null;
	}
	const bytes = new TextEncoder().encode(text);
	const lineStarts = [0];
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0x0a) lineStarts.push(i + 1);
	}
	return { root, rootId: root.id(), lineStarts };
}

// ── markdown section emulation (tree-sitter-md `section` semantics) ────────

function markdownHeading(line: string): number | null {
	// ATX headings allow up to three leading spaces.
	const match = /^ {0,3}(#{1,6})(\s|$)/.exec(line);
	return match === null ? null : match[1].length;
}

/**
 * Section spans for every heading: a section starts at the heading line and
 * runs to the line before the next heading of the same or higher level (or
 * EOF), mirroring tree-sitter-md's nested `section` nodes.
 */
export function markdownSections(lines: string[]): Array<{ start: number; end: number }> {
	const lastContent =
		lines.length - (lines.length > 0 && lines[lines.length - 1] === "" ? 1 : 0);
	const headings: Array<{ line: number; level: number }> = [];
	for (let i = 0; i < lastContent; i++) {
		const level = markdownHeading(lines[i]);
		if (level !== null) headings.push({ line: i + 1, level });
	}
	const sections: Array<{ start: number; end: number }> = [];
	for (let i = 0; i < headings.length; i++) {
		let end = lastContent;
		for (let j = i + 1; j < headings.length; j++) {
			if (headings[j].level <= headings[i].level) {
				end = headings[j].line - 1;
				break;
			}
		}
		sections.push({ start: headings[i].line, end });
	}
	return sections;
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Named-node chain containing a 1-indexed line, innermost first (port of
 * `node_chain_at`). Empty when the language is unrecognized, the line is
 * out of range / blank, or the source fails to parse.
 */
export async function nodeChain(lines: string[], path: string, line: number): Promise<NodeSpan[]> {
	const text = lines.join("\n");
	const cacheKey = key(hashText(text), text.length, path, line, line);
	const cached = cache.chains.get(cacheKey);
	if (cached !== undefined) return cached;

	let chain: NodeSpan[] = [];
	const row = line - 1;
	if (line > 0 && text.length > 0 && row >= 0 && row < lines.length) {
		if (isMarkdownPath(path)) {
			const containing = markdownSections(lines).filter(
				section => section.start <= line && line <= section.end,
			);
			// Innermost first: the deepest section containing the line leads.
			containing.sort((a, b) => b.start - a.start);
			for (const section of containing) {
				chain.push({ startLine: section.start, endLine: section.end, kind: "section" });
			}
		} else {
			const parsed = await parseForPath(text, path);
			if (parsed !== null) {
				const targetLine = lines[row];
				let col = -1;
				for (let c = 0; c < targetLine.length; c++) {
					const unit = targetLine.charCodeAt(c);
					if (unit !== 0x20 && unit !== 0x09) {
						col = c;
						break;
					}
				}
				if (col >= 0) {
					const startByte = parsed.lineStarts[row] + col;
					const leaf = namedDescendantForPointRange(parsed.root, startByte, startByte + 1);
					if (leaf.range().start.line === row) {
						let node: NapiNode | null = leaf;
						while (node !== null) {
							if (node.id() === parsed.rootId) break;
							if (node.isNamed() && !isErrorKind(node.kind())) {
								chain.push({
									startLine: nodeStartLine(node),
									endLine: nodeContentEndLine(node),
									kind: node.kind(),
								});
							}
							node = node.parent();
						}
					}
				}
			}
		}
	}
	cache.put(cache.chains, cache.chainOrder, cacheKey, chain);
	return chain;
}

/**
 * Syntax block boundaries enclosing a 1-indexed inclusive line range (port of
 * `enclosing_block_boundaries`): for each multi-line named node whose span
 * crosses the window, the endpoint line sitting outside the window.
 */
export async function enclosingBoundaries(
	lines: string[],
	path: string,
	start: number,
	end: number,
): Promise<number[]> {
	const text = lines.join("\n");
	const cacheKey = key(hashText(text), text.length, path, start, end);
	const cached = cache.boundaries.get(cacheKey);
	if (cached !== undefined) return cached;

	const out = new Set<number>();
	if (text.length > 0 && start > 0 && end >= start) {
		if (isMarkdownPath(path)) {
			for (const section of markdownSections(lines)) {
				const startVisible = section.start >= start && section.start <= end;
				const endVisible = section.end >= start && section.end <= end;
				if (section.end > section.start) {
					if (startVisible && !endVisible) out.add(section.end);
					else if (endVisible && !startVisible) out.add(section.start);
				}
			}
		} else {
			const parsed = await parseForPath(text, path);
			if (parsed !== null && !hasError(parsed.root)) {
				const visit = (node: NapiNode): void => {
					const range = node.range();
					const rawStart = range.start.line + 1;
					const rawEnd = range.end.line + 1;
					// Prune subtrees whose raw span holds no visible line.
					if (rawEnd < start || rawStart > end) return;
					if (node.isNamed() && node.parent() !== null) {
						const nodeStart = nodeStartLine(node);
						const nodeEnd = nodeContentEndLine(node);
						if (nodeEnd > nodeStart) {
							const startVisible = nodeStart >= start && nodeStart <= end;
							const endVisible = nodeEnd >= start && nodeEnd <= end;
							if (startVisible && !endVisible) out.add(nodeEnd);
							else if (endVisible && !startVisible) out.add(nodeStart);
						}
					}
					for (const child of node.children()) visit(child);
				};
				visit(parsed.root);
			}
		}
	}
	const sorted = [...out].sort((a, b) => a - b);
	cache.put(cache.boundaries, cache.boundaryOrder, cacheKey, sorted);
	return sorted;
}

/**
 * Whether text parses cleanly for the supplied path language. False when the
 * path has no recognized language or the parse carries a syntax error.
 * Markdown always parses cleanly.
 */
export async function parsesCleanly(path: string | null, text: string): Promise<boolean> {
	if (path === null) return false;
	const cacheKey = key(hashText(text), text.length, path, 0, 0);
	const cached = cache.parses.get(cacheKey);
	let parsed = false;
	if (isMarkdownPath(path)) {
		parsed = true;
	} else {
		const file = await parseForPath(text, path);
		parsed = file !== null && !hasError(file.root);
	}
	cache.put(cache.parses, cache.parseOrder, cacheKey, parsed);
	return parsed;
}
