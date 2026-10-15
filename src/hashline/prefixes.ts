/**
 * Normalization of line prefixes copied from read/search output (port of
 * OMP's `modes/hashline/prefixes.rs`).
 */

const HL_PREFIX_RE = /^\s*(?:(?:>>>|>>)\s*)?(?:[+*-]\s*)?\d+[:|]/;
const HL_PREFIX_PLUS_RE = /^\s*(?:(?:>>>|>>)\s*)?\+\s*\d+:/;
const HL_HEADER_RE = /^\s*\[[^#\r\n]+#[0-9a-fA-F]{4}\]\s*$/;
const READ_RANGE_ELISION_RE = /^\s*[1-9]\d*\s*-\s*[1-9]\d*:.*(?:…|\.\.\.).*$/;
const READ_SINGLE_ELISION_RE = /^\s*(?:…|\.\.\.)\s*$/;

/** Whether a row is a truncation notice emitted by `read`. */
export function isReadTruncationNotice(line: string): boolean {
	const trimmed = line.trim();
	if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) return false;
	const body = trimmed.slice(1, -1);
	const showingNotice =
		body.startsWith("Showing ") &&
		(body.includes(" line") || body.includes("lines ") || body.includes("bytes ")) &&
		(body.includes(" of ") || body.includes(" elided"));
	const moreParts = body.split(" more line");
	const moreNotice =
		(body.startsWith("More lines in ") ||
			(moreParts.length === 2 && moreParts[0].trim() !== "" && !Number.isNaN(Number(moreParts[0].trim())))) &&
		body.includes(" in ") &&
		body.includes(". Use ") &&
		body.endsWith(" to continue");
	const elidedNotice =
		(body.startsWith("…") || body.startsWith("...")) &&
		body.includes("ln elided;") &&
		body.includes("re-read needed ranges");
	const oversizedLineNotice =
		body.startsWith("Line ") && body.includes(" exceeds ") && body.includes(" limit.");
	return showingNotice || moreNotice || elidedNotice || oversizedLineNotice;
}

/** Whether a row is display-only metadata emitted by `read`. */
export function isReadMetadataLine(line: string): boolean {
	return (
		isReadTruncationNotice(line) ||
		READ_RANGE_ELISION_RE.test(line) ||
		READ_SINGLE_ELISION_RE.test(line)
	);
}

function stripLeadingHashlinePrefixes(line: string): string {
	let result = line;
	for (;;) {
		const next = result.replace(HL_PREFIX_RE, "");
		if (next === result) return result;
		result = next;
	}
}

/** Strip at most one leading read/search line-number prefix. */
export function stripOneLeadingHashlinePrefix(line: string): string {
	return line.replace(HL_PREFIX_RE, "");
}

interface LinePrefixStats {
	nonEmpty: number;
	headerCount: number;
	hashPrefixCount: number;
	diffPlusHashPrefixCount: number;
	diffPlusCount: number;
}

function collectLinePrefixStats(lines: string[]): LinePrefixStats {
	const stats: LinePrefixStats = {
		nonEmpty: 0,
		headerCount: 0,
		hashPrefixCount: 0,
		diffPlusHashPrefixCount: 0,
		diffPlusCount: 0,
	};
	for (const line of lines) {
		if (line.length === 0 || isReadMetadataLine(line)) continue;
		stats.nonEmpty++;
		if (HL_HEADER_RE.test(line)) {
			stats.headerCount++;
			continue;
		}
		if (HL_PREFIX_RE.test(line)) stats.hashPrefixCount++;
		if (HL_PREFIX_PLUS_RE.test(line)) stats.diffPlusHashPrefixCount++;
		if (line.startsWith("+") && !line.startsWith("++")) stats.diffPlusCount++;
	}
	return stats;
}

/** Opportunistically strip a consistent numbered or diff prefix scheme. */
export function stripNewLinePrefixes(lines: string[]): string[] {
	const stats = collectLinePrefixStats(lines);
	if (stats.nonEmpty === 0) return lines.slice();
	const contentLineCount = stats.nonEmpty - stats.headerCount;
	const stripHash = contentLineCount > 0 && stats.hashPrefixCount === contentLineCount;
	const stripPlus =
		!stripHash &&
		stats.diffPlusHashPrefixCount === 0 &&
		stats.diffPlusCount > 0 &&
		stats.diffPlusCount >= stats.nonEmpty * 0.5;
	if (!stripHash && !stripPlus && stats.diffPlusHashPrefixCount === 0) return lines.slice();
	const out: string[] = [];
	for (const line of lines) {
		if (isReadMetadataLine(line) || (stripHash && HL_HEADER_RE.test(line))) continue;
		if (stripHash) {
			out.push(stripLeadingHashlinePrefixes(line));
		} else if (stripPlus && line.startsWith("+") && !line.startsWith("++")) {
			out.push(line.slice(1));
		} else if (stats.diffPlusHashPrefixCount > 0 && HL_PREFIX_PLUS_RE.test(line)) {
			out.push(stripOneLeadingHashlinePrefix(line));
		} else {
			out.push(line);
		}
	}
	return out;
}

/** Normalize a multiline text payload into unprefixed rows. */
export function hashlineParseText(edit: string | null | undefined): string[] {
	if (edit === null || edit === undefined) return [];
	const trimmed = edit.endsWith("\n") ? edit.slice(0, -1) : edit;
	return stripNewLinePrefixes(trimmed.replace(/\r/g, "").split("\n"));
}

/** Normalize an existing row slice into unprefixed rows. */
export function hashlineParseLines(edit: string[] | null | undefined): string[] {
	if (edit === null || edit === undefined) return [];
	return stripNewLinePrefixes(edit);
}

/**
 * Strip numbered prefixes only when every content row carries one (port of
 * OMP's `strip_hashline_prefixes`, the stricter writer-side variant used by
 * the write tool's `stripWriteContent`). Unlike {@link stripNewLinePrefixes}
 * it never applies the diff-plus fallback and drops read-metadata rows and
 * `[PATH#TAG]` headers unconditionally once the all-rows-prefixed check
 * passes.
 */
export function stripHashlinePrefixes(lines: string[]): string[] {
	const stats = collectLinePrefixStats(lines);
	if (stats.nonEmpty === 0) return lines.slice();
	const contentLineCount = stats.nonEmpty - stats.headerCount;
	if (contentLineCount === 0 || stats.hashPrefixCount !== contentLineCount) return lines.slice();
	const out: string[] = [];
	for (const line of lines) {
		if (isReadMetadataLine(line) || HL_HEADER_RE.test(line)) continue;
		out.push(stripLeadingHashlinePrefixes(line));
	}
	return out;
}


/**
 * Strip a copied `[path#TAG]` hashline header wrapper from a write/edit
 * target (port of OMP's `unwrapHashlineHeaderPath`). Only unwraps the strict
 * header shape (`[path]` or `[path#XXXX]` with a 4-hex tag); anything else is
 * returned unchanged so downstream resolution surfaces the real error. A
 * valid tag disambiguates a `#` inside the path (yadm alt files).
 */
export function unwrapHashlineHeaderPath(targetPath: string): string {
	const trimmed = targetPath.trimEnd();
	if (trimmed.length < 2 || trimmed[0] !== "[" || trimmed[trimmed.length - 1] !== "]") return targetPath;
	const inner = trimmed.slice(1, trimmed.length - 1);
	const tagMatch = /#([0-9A-Fa-f]{4})\s*$/.exec(inner);
	const pathPart = tagMatch ? inner.slice(0, tagMatch.index) : inner;
	if (pathPart.length === 0 || (!tagMatch && pathPart.includes("#"))) return targetPath;
	return pathPart;
}
