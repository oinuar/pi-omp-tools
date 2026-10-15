/**
 * Centralized error/warning text for the hashline parser, applier, and
 * patcher (port of OMP's `modes/hashline/messages.rs` — the exact
 * strings the model was trained on).
 *
 * Continuation convention: multi-line template literals end continued lines
 * with `§`; `cont()` collapses marker + newline + next-line indentation into
 * one space (mirroring Rust `\` line continuations).
 */

const cont = (s: string) => s.replace(/[ \t]*§\n[ \t]*/g, " ");

export interface BlockSpan {
	start: number;
	end: number;
}

const HL_FILE_PREFIX = "[";
const HL_FILE_SUFFIX = "]";
const HL_PAYLOAD_REPLACE = "+";
export const HL_PUT_KEYWORD = "PUT";
export const HL_CUT_KEYWORD = "CUT";
const HL_FILE_HASH_SEP = "#";
const HL_RANGE_SEP = ".=";
const HL_LINE_BODY_SEP = ":";

function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}${HL_LINE_BODY_SEP}${line}`;
}

/** Tiny JS-compatible `JSON.stringify(str)` (escapes `"`, `\`, controls). */
export function jsonQuote(s: string): string {
	let out = '"';
	for (const c of s) {
		switch (c) {
			case '"':
				out += '\\"';
				break;
			case "\\":
				out += "\\\\";
				break;
			case "\n":
				out += "\\n";
				break;
			case "\r":
				out += "\\r";
				break;
			case "\t":
				out += "\\t";
				break;
			case "\b":
				out += "\\b";
				break;
			case "\f":
				out += "\\f";
				break;
			default:
				if (c.charCodeAt(0) < 0x20) out += `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
				else out += c;
		}
	}
	return out + '"';
}

/** Lines of context shown either side of a hash mismatch. */
export const MISMATCH_CONTEXT = 2;

/**
 * Numbered `LINE:TEXT` rows around `anchorLines` (±MISMATCH_CONTEXT),
 * `*`-marking anchors, `...` between non-adjacent runs. Out-of-range anchors
 * contribute no rows.
 */
export function formatAnchoredContext(anchorLines: number[], fileLines: string[]): string[] {
	const displayLines = new Set<number>();
	for (const line of anchorLines) {
		if (line < 1 || line > fileLines.length) continue;
		const lo = Math.max(1, line - MISMATCH_CONTEXT);
		const hi = Math.min(fileLines.length, line + MISMATCH_CONTEXT);
		for (let n = lo; n <= hi; n++) displayLines.add(n);
	}
	const anchorSet = new Set(anchorLines);
	const rows: string[] = [];
	let previous: number | null = null;
	for (const lineNum of [...displayLines].sort((a, b) => a - b)) {
		if (previous !== null && lineNum > previous + 1) rows.push("...");
		previous = lineNum;
		const marker = anchorSet.has(lineNum) ? "*" : " ";
		const text = fileLines[lineNum - 1] ?? "";
		rows.push(`${marker}${formatNumberedLine(lineNum, text)}`);
	}
	return rows;
}

export type AbsoluteRangeOp = "replace" | "cut";

function regSuffix(register?: string): string {
	return register ? ` @${register}` : "";
}

function rangeOpSingle(op: AbsoluteRangeOp, line: number, register?: string): string {
	const suffix = regSuffix(register);
	if (op === "replace") return register ? `${HL_PUT_KEYWORD} ${line}${suffix}` : `${HL_PUT_KEYWORD} ${line}:`;
	return `${HL_CUT_KEYWORD} ${line}${suffix}`;
}

function rangeOpRange(op: AbsoluteRangeOp, start: number, end: number, register?: string): string {
	const suffix = regSuffix(register);
	if (op === "replace")
		return register
			? `${HL_PUT_KEYWORD} ${start}${HL_RANGE_SEP}${end}${suffix}`
			: `${HL_PUT_KEYWORD} ${start}${HL_RANGE_SEP}${end}:`;
	return `${HL_CUT_KEYWORD} ${start}${HL_RANGE_SEP}${end}${suffix}`;
}

function blockFormAt(op: AbsoluteRangeOp, line: number, register?: string): string {
	const suffix = regSuffix(register);
	if (op === "replace") return register ? `${HL_PUT_KEYWORD} ${line}*${suffix}` : `${HL_PUT_KEYWORD} ${line}*:`;
	return `${HL_CUT_KEYWORD} ${line}*${suffix}`;
}

/** Explain absolute range endpoints and provide safe, non-applying retry forms. */
export function invalidAbsoluteRangeMessage(
	patchLine: number,
	start: number,
	end: number,
	op: AbsoluteRangeOp,
	block?: BlockSpan,
	register?: string,
): string {
	const single = rangeOpSingle(op, start, register);
	const countedEnd = start + end - 1;
	const counted = countedEnd >= start ? rangeOpRange(op, start, countedEnd, register) : null;
	const blockForm = blockFormAt(op, start, register);
	let message = cont(
		`line ${patchLine}: Invalid absolute range: start ${start}, end ${end}. The value after §
\`${HL_RANGE_SEP}\` is an absolute source line, not a line count or replacement length. For §
one line use \`${single}\`.`,
	);
	if (counted) message += cont(` For ${end} lines starting at ${start}, use \`${counted}\`.`);
	if (block && block.start === start && block.end > start) {
		message += cont(
			` The syntactic block beginning at ${start} ends at ${block.end}, so \`${blockForm}\` is also valid.`,
		);
	}
	return message;
}

/** Optional patch envelope start marker; silently consumed. */
export const BEGIN_PATCH_MARKER = "*** Begin Patch";

/** Optional patch envelope end marker; terminates parsing. */
export const END_PATCH_MARKER = "*** End Patch";

/** Truncation sentinel emitted by an agent loop mid-call. Ends parsing like
 * END_PATCH_MARKER, without a warning. */
export const ABORT_MARKER = "*** Abort";

/** Exact-range duplicate hunks were normalized to the final hunk. */
export const REPLACE_PAIR_COALESCED_WARNING = cont(
	`Multiple hunks targeted the same exact range; §
kept only the last. Issue one \`PUT\` or \`CUT\` §
hunk per range.`,
);

/** Replacement body indentation was aligned from unchanged structural rows. */
export const REPLACEMENT_INDENT_AUTO_SHIFT_WARNING = cont(
	`Auto-indented a replacement body to match unchanged structural rows in its source range.`,
);

/** Bare body rows auto-converted to literal `+` rows. */
export const BARE_BODY_AUTO_PIPED_WARNING = cont(
	`Auto-prefixed bare body row(s) with \`+\`. Body rows must be \`+TEXT\` literal lines.`,
);

/** Top-level read-output rows recovered as single-line replacements. */
export const SNAPSHOT_ROWS_AUTO_PUT_WARNING = cont(
	`Recovered top-level \`N:TEXT\` snapshot row(s) as §
single-line \`PUT N.=N:\` replacements. Use §
explicit \`PUT\` headers for reliable edits.`,
);

/** Two or more top-level `N:TEXT` read-output rows named the same source line. */
export function repeatedSnapshotRowMessage(line: number): string {
	return cont(
		`two or more pasted \`${line}:TEXT\` read-output rows name line ${line}. Such rows are §
recovered as single-line \`PUT ${line}${HL_RANGE_SEP}${line}:\` replacements, so repeating a §
number would keep only the last row and drop the rest. Write the hunk explicitly: one \`PUT §
${line}${HL_RANGE_SEP}M:\` header covering exactly the lines that change, followed by \`+TEXT\` §
body rows holding their complete final content.`,
	);
}

/** A `+` body row whose text is itself a valid hunk header. */
export function literalOpRowWarning(line: number, text: string): string {
	return cont(
		`line ${line}: body row \`${HL_PAYLOAD_REPLACE}${text}\` is itself a valid hunk header, so it §
was inserted into the file as literal text rather than executed. Ops are never §
\`${HL_PAYLOAD_REPLACE}\`-prefixed — drop the \`${HL_PAYLOAD_REPLACE}\` to run it, and re-issue §
if this line landed in the file by mistake.`,
	);
}

/** Bare range header recovered as an implicit replacement hunk. */
export const BARE_RANGE_AUTO_PUT_WARNING = cont(
	`Recovered a bare \`N.=M:\` header as \`PUT N.=M:\`. Prefix replacement ranges with \`PUT\`.`,
);

/** Copied read-output elision rows were ignored rather than written as source. */
export const READ_METADATA_IGNORED_WARNING = cont(
	`Ignored copied read-output elision row(s). Re-read elided ranges before editing them.`,
);

/** Empty span/block PUT recovered as a delete-only edit. */
export const EMPTY_PUT_AUTO_CUT_WARNING = cont(
	`Interpreted an empty \`PUT\` body as deletion. Use \`CUT N.=M\` or \`CUT N*\` for bodyless deletes.`,
);

/** A bodyless CUT carried a harmless trailing colon. */
export const CUT_COLON_IGNORED_WARNING = cont(
	`Ignored a trailing \`:\` on bodyless \`CUT\`. Prefer \`CUT N.=M\` / \`CUT N*\` without a colon.`,
);

/** Bare `-` body rows accepted as literal Markdown bullets. */
export const MINUS_BULLET_AUTO_PIPED_WARNING = cont(
	`Auto-prefixed bare \`- \` bullet row(s) as literal content. \`-\` rows never remove lines — the §
range does that; always prefix literal body rows with \`+\`: \`+- item\`.`,
);

/** Unified-diff old rows were discarded; explicit `+` rows are final content. */
export const DIFF_OLD_ROWS_IGNORED_WARNING = cont(
	`Ignored unified-diff \`-old\` row(s); the range §
already removes old content, so only \`+new\` rows §
were kept.`,
);

/** Unified-diff-style `-` row in a hunk body. */
export const MINUS_ROW_REJECTED = cont(
	`\`-\` rows are not valid; the range already names the lines §
being changed. For Markdown bullets or other literal \`-\` §
lines, prefix the literal row with \`+\`: \`+- item\`.`,
);

/** Optional source-aware suggestions appended to block-anchor diagnostics. */
export interface BlockDiagnosticSuggestions {
	/** Closest following multi-line block that begins after the authored anchor. */
	nextBlock: BlockSpan | null;
	/** Closest preceding multi-line block whose span contains the authored anchor. */
	enclosingBlock: BlockSpan | null;
}

/**
 * A block-anchored replace/cut could not resolve to a syntactic block.
 * Appends a formatAnchoredContext preview when `fileLines` is given.
 * `PUT >N*` never reaches this path; it lowers to `PUT >N`.
 */
export function blockUnresolvedMessage(
	line: number,
	op: AbsoluteRangeOp,
	fileLines: string[] | null,
	suggestions: BlockDiagnosticSuggestions,
	register?: string,
): string {
	const phrase = blockFormAt(op, line, register);
	const fallback =
		op === "replace"
			? register
				? `${HL_PUT_KEYWORD} ${line}${HL_RANGE_SEP}M @${register}`
				: `${HL_PUT_KEYWORD} ${line}${HL_RANGE_SEP}M:`
			: register
			  ? `${HL_CUT_KEYWORD} ${line}${HL_RANGE_SEP}M @${register}`
			  : `${HL_CUT_KEYWORD} ${line}${HL_RANGE_SEP}M`;
	const anchorText = fileLines?.[line - 1];
	const nextBlock = suggestions.nextBlock;
	let message: string;
	if (anchorText !== undefined && anchorText.trim() === "" && nextBlock) {
		const retry = blockFormAt(op, nextBlock.start, register);
		message = cont(
			`Line ${line} is blank; no syntactic block can begin there. The next multi-line block §
begins at line ${nextBlock.start} and ends at line ${nextBlock.end}. Retry \`${retry}\`.`,
		);
	} else {
		message = cont(
			`\`${phrase}\` could not resolve a syntactic block beginning on line ${line} (unsupported §
language, blank/closer line, or parse error). Use \`${fallback}\` with explicit lines.`,
		);
	}
	if (suggestions.enclosingBlock) {
		const enclosingBlock = suggestions.enclosingBlock;
		const retry = blockFormAt(op, enclosingBlock.start, register);
		message += cont(
			` The nearest enclosing multi-line block begins at line ${enclosingBlock.start} and ends at line ${enclosingBlock.end}; use §
\`${retry}\` to target it.`,
		);
	}
	if (fileLines) {
		const context = formatAnchoredContext([line], fileLines);
		if (context.length > 0) message += `\n\n${context.join("\n")}`;
	}
	return message;
}

/** Block-anchored edit reached a path with no `BlockResolver` wired in. */
export const BLOCK_RESOLVER_UNAVAILABLE = cont(
	`Block locators (\`N*\` in \`PUT N*:\`, \`PUT >N*\`, \`CUT §
N*\`) are not available here (no block resolver §
configured). Use a concrete line range.`,
);

function closerLoweredWarning(blockForm: string, plainForm: string): string {
	return cont(
		`\`${blockForm}\` anchors on a closing delimiter, so it was applied as plain \`${plainForm}\`. §
Anchor on the line that OPENS the construct.`,
	);
}

function unresolvedLoweredWarning(blockForm: string, line: number, plainForm: string): string {
	return cont(
		`\`${blockForm}\` could not resolve a syntactic block on line ${line}, so it was applied as §
plain \`${plainForm}\`. Verify the landing line; anchor on a line that OPENS a construct.`,
	);
}

/** `PUT >N*:` anchored on a closing-delimiter line; applied as `PUT >N:`. */
export function insertAfterBlockCloserLoweredWarning(line: number): string {
	return closerLoweredWarning(`PUT >${line}*:`, `PUT >${line}:`);
}

/** `PUT >N*:` anchor unresolvable; applied as `PUT >N:`. */
export function insertAfterBlockUnresolvedLoweredWarning(line: number): string {
	return unresolvedLoweredWarning(`PUT >${line}*:`, line, `PUT >${line}:`);
}

/** Register `PUT >N*` anchored on a closing-delimiter line; applied as `PUT >N`. */
export function pasteAfterBlockCloserLoweredWarning(line: number): string {
	return closerLoweredWarning(`PUT >${line}*`, `PUT >${line}`);
}

/** Register `PUT >N*` anchor unresolvable; applied as `PUT >N`. */
export function pasteAfterBlockUnresolvedLoweredWarning(line: number): string {
	return unresolvedLoweredWarning(`PUT >${line}*`, line, `PUT >${line}`);
}

export type BoundarySide = "leading" | "trailing";

/** A one-sided exact boundary echo cannot cover the selected range. */
export function ambiguousBoundaryEchoMessage(
	startLine: number,
	endLine: number,
	side: BoundarySide,
	count: number,
): string {
	const whereClause =
		side === "leading"
			? `opens by restating the ${count} line(s) just above the range`
			: `ends by restating the ${count} line(s) just below the range`;
	return cont(
		`\`PUT ${startLine}${HL_RANGE_SEP}${endLine}:\` rejected: the body ${whereClause}, but is too §
short to be the full final content of the selected range. Re-issue with the range covering §
exactly the lines that change and the body as their complete final content.`,
	);
}

/** A syntax-essential selected edge can be retained on either side of the
 * payload, but indentation does not establish which placement was intended. */
export function ambiguousBoundaryPlacementMessage(startLine: number, endLine: number): string {
	return cont(
		`\`PUT ${startLine}${HL_RANGE_SEP}${endLine}:\` rejected: a selected boundary row is required §
for the file to parse, but the body indentation does not establish whether it belongs §
before or after that row. Re-read the region and re-issue with a range that excludes every §
unchanged boundary row.`,
	);
}

/** Exact-text boundary rows were removed because the remaining payload covers
 * the selected range and the same rows already survive immediately outside it. */
export function textualBoundaryEchoWarning(startLine: number, leading: number, trailing: number): string {
	const parts: string[] = [];
	if (leading > 0) parts.push(`${leading} leading`);
	if (trailing > 0) parts.push(`${trailing} trailing`);
	const joined = parts.join(" and ");
	return cont(
		`Auto-repaired a replacement boundary echo at line ${startLine}: dropped ${joined} body §
line(s) already present outside the range. Issue the body as final content for the §
selected range only.`,
	);
}

/** A replacement range's boundary disposition was corrected by the search. */
export function boundaryVariantRepairWarning(startLine: number, kept: number, dropped: number): string {
	const keptPart =
		kept === 0
			? null
			: `retained ${kept} syntax-essential source boundary row(s) selected by the range`;
	const droppedPart =
		dropped === 0 ? null : `dropped ${dropped} body row(s) duplicated just outside the range`;
	const action = [keptPart, droppedPart].filter(Boolean).join(" and ");
	return cont(
		`Auto-repaired replacement boundaries at line ${startLine}: ${action}. The result was §
verified by the syntax probe — re-issue with the range covering exactly the changed lines §
and the body as their complete final content.`,
	);
}

/** The applied result no longer parses while the pre-edit content did. */
export function editBrokeParseWarning(firstChangedLine?: number): string {
	const at = firstChangedLine ? ` near line ${firstChangedLine}` : "";
	return cont(
		`This edit introduced a syntax error${at}: the file parsed before the patch and no longer §
does. It was applied exactly as written, so a line number or range endpoint is likely §
wrong — re-read the touched region and re-issue a correcting edit.`,
	);
}

/** Internal invariant: applyEdits received an unresolved block edit. */
export const UNRESOLVED_BLOCK_INTERNAL =
	"internal error: unresolved block edit reached the applier (resolveBlockEdits was not run).";

/** Internal invariant: clipboard edits must be concrete before application. */
export const UNRESOLVED_CLIPBOARD_INTERNAL = cont(
	`internal error: unresolved clipboard edit §
reached the applier (resolveClipboardEdits was §
not run).`,
);

/** `REM` deletes the whole file and takes no body rows or line ops. */
export const REM_TAKES_NO_BODY = cont(
	`\`REM\` deletes the whole file and takes no body rows or line §
ops. Issue it alone under the header.`,
);

/** `MV DEST` does not take body rows. */
export const MOVE_TAKES_NO_BODY = cont(
	`\`MV DEST\` does not take body rows. Put line edits above the §
\`MV\` row; the destination path follows \`MV\` on the same §
line.`,
);

/** `CUT` hunk received a body row. */
export const CUT_TAKES_NO_BODY = cont(
	`\`CUT\` deletes (and captures) the named lines and takes no §
body rows. To write new content, use \`PUT N.=M:\` with §
\`+TEXT\` rows.`,
);

/** Register `PUT` header carried a `:`. */
export const COLON_ON_REGISTER_PUT = cont(
	`\`PUT … @name\` pastes the register and never takes \`:\` — §
the colon promises body rows. Drop the colon (\`PUT >40 §
@name\`), or drop \`@name\` and write \`+TEXT\` body rows.`,
);

/** Register `PUT` hunk received a body row. */
export const REGISTER_PUT_TAKES_NO_BODY = cont(
	`A register \`PUT\` pastes captured lines and takes no §
\`+\` body rows. To write literal text, drop the §
\`@name\` and use \`PUT …:\` with body rows.`,
);

/** Colonless `PUT` hunk received a body row. */
export const COLONLESS_PUT_TAKES_NO_BODY = cont(
	`\`PUT\` without \`:\` is clipboard-backed and takes no §
body rows. Add \`:\` after the locator to write §
literal content (\`PUT >40:\` then \`+TEXT\` rows).`,
);

/** Colonless anonymous `PUT` on a span target. */
export const COLONLESS_SPAN_PUT = cont(
	`Colonless \`PUT\` is clipboard-backed, and span targets need §
a named register (\`PUT 5.=9 @name\`); the anonymous register §
pastes only at gaps (\`PUT >40\`). To write literal content, §
add \`:\` and \`+TEXT\` body rows.`,
);

/** Anonymous paste ran with an empty anonymous register. */
export const EMPTY_PASTE = cont(
	`Nothing to paste: no unlabeled \`CUT\` precedes this \`PUT\` in this §
call, and the anonymous register never carries across calls. Put §
\`CUT N.=M\` / \`CUT N*\` above it, or use named registers (\`CUT … §
@name\` → \`PUT … @name\`) for cross-call moves.`,
);

/** Named paste read a register that holds nothing; a gap paste applies as empty. */
export function emptyRegisterPasteWarning(name: string, known: string[]): string {
	const base = cont(
		`\`@${name}\` was empty — no \`CUT … @${name}\` precedes this op in this call and no persisted §
register has that name — so nothing was pasted.`,
	);
	return known.length === 0
		? base
		: `${base} Available registers: ${known.map(k => `\`@${k}\``).join(", ")}.`;
}

/** Named paste over a *span* read a register that holds nothing. */
export function emptyRegisterSpanPasteMessage(name: string, known: string[]): string {
	const base = cont(
		`\`@${name}\` is empty — no \`CUT … @${name}\` precedes this op in this call and no persisted §
register has that name — so pasting it over a range would delete those lines and write §
nothing back. Capture the register first (\`CUT … @${name}\`), or use \`CUT\` if deleting the §
range is what you meant.`,
	);
	return known.length === 0
		? base
		: `${base} Available registers: ${known.map(k => `\`@${k}\``).join(", ")}.`;
}

/** Unlabeled paste with two or more unlabeled cuts pending. */
export function ambiguousAnonymousPasteMessage(pending: string[]): string {
	const count = pending.length;
	const joined = pending.join(", ");
	return cont(
		`${count} unlabeled \`CUT\`s are pending (${joined}) — an unlabeled paste cannot tell which one §
you meant. Label the moves (\`CUT … @name\` → \`PUT … @name\`), or keep at most one unlabeled §
\`CUT\` before each unlabeled paste.`,
	);
}

/** Clipboard ops in a same-path section merged across another file's section. */
export const CLIPBOARD_INTERLEAVED_SECTIONS = cont(
	`\`CUT\`/register-\`PUT\` ops cannot be used in a file whose sections are interleaved with another §
file's: same-path sections merge into the first occurrence, which would reorder the register §
sequence. Keep each file's ops under ONE \`[path#TAG]\` header.`,
);

/** Gap `PUT` with `:` but no body. */
export const EMPTY_INSERT = cont(
	`\`PUT <N:\` / \`PUT >N:\` promises body rows and got none. Write §
\`+TEXT\` rows, or drop the \`:\` to paste a register (\`PUT >N\` = §
anonymous, \`PUT >N @name\` = named).`,
);

/** `insert after` body indented shallower than the anchor. */
export function afterInsertLandingShiftWarning(anchorLine: number, landingLine: number, crossed: number): string {
	const s = crossed === 1 ? "" : "s";
	return cont(
		`PUT >${anchorLine}: body indented shallower than the anchor, so the landing moved past §
${crossed} closing line${s} to after line ${landingLine}. For the deeper position inside the §
block, re-issue with the body indented to match.`,
	);
}

/** `PUT >N*:` body indented deeper than the block's closer. */
export function blockInsertLandingShiftWarning(blockStart: number, closerLine: number, landingLine: number): string {
	return cont(
		`PUT >${blockStart}*: body indented deeper than closing line ${closerLine}, so it was §
placed inside the block, after line ${landingLine}. \`PUT >N*\` lands AFTER the block at §
sibling depth — if inside was intended, use plain \`PUT >${closerLine}:\`.`,
	);
}

/** Plain `PUT >N:` anchored on a block-opener line with a shallower body. */
export function afterInsertOpenerEscapeWarning(anchorLine: number, landingLine: number): string {
	return cont(
		`PUT >${anchorLine}: line ${anchorLine} opens a block, and the body's indentation claims a §
position outside it, so the body was landed after line ${landingLine} (verified by the §
syntax probe). To insert after a whole construct, anchor on its closing line or use \`PUT §
>N*:\`.`,
	);
}

/** `Recovery`: an external write matched a cached snapshot. */
export const RECOVERY_EXTERNAL_WARNING = cont(
	`Recovered from a stale file hash using a previous §
read snapshot (file changed externally between read §
and edit).`,
);

/** `Recovery`: a prior in-session edit advanced the hash. */
export const RECOVERY_SESSION_CHAIN_WARNING = cont(
	`Recovered from a stale file hash using an §
earlier in-session snapshot (a prior edit in §
this session advanced the hash).`,
);

/** `Recovery`: stale anchors were relocated to unchanged live lines after drift. */
export const RECOVERY_LINE_REMAP_WARNING = cont(
	`Recovered by remapping stale line anchors to §
unchanged current lines (file changed since the §
tagged read). Verify the diff matches your intent.`,
);

/** `insert head:`/`insert tail:` applied despite a stale snapshot tag. */
export const HEADTAIL_DRIFT_WARNING = cont(
	`Applied the \`PUT <1:\`/\`PUT >$:\` edit despite a stale snapshot tag (file changed since your §
read) — head/tail position is content-independent. Re-read if the drift was unexpected.`,
);

/** Disk content after write differs from what was sent. */
export function writeDriftWarning(path: string): string {
	return cont(
		`${path}: the file on disk after this write differs from what was sent — the client §
(editor/IDE) likely reformatted it on save (e.g. format-on-save, tab/space settings). The §
returned snapshot reflects the actual file; re-read before further edits if the extra §
changes were unexpected.`,
	);
}

/** Section omitted the mandatory snapshot tag. */
export function missingSnapshotTagMessage(sectionPath: string): string {
	return cont(
		`Missing hashline snapshot tag for ${sectionPath}; use §
\`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX}\` from your latest §
read/search output. To create a new file, use the write tool.`,
	);
}

/** Section named a nonexistent path matching an earlier snapshot's name and tag. */
export function pathRecoveredFromTagMessage(authoredPath: string, resolvedPath: string, tag: string): string {
	return cont(
		`Path "${authoredPath}" does not exist; matched its filename and snapshot tag §
${HL_FILE_HASH_SEP}${tag} to ${resolvedPath} (read earlier this session). Anchor future §
edits on \`${HL_FILE_PREFIX}${resolvedPath}${HL_FILE_HASH_SEP}TAG${HL_FILE_SUFFIX}\`.`,
	);
}

/** Compress a line list into a sorted `1-4, 7, 10-12` range string. */
export function formatLineRanges(lines: number[]): string {
	const set = [...new Set(lines)].sort((a, b) => a - b);
	if (set.length === 0) return "";
	const parts: string[] = [];
	let start = set[0];
	let prev = set[0];
	for (const current of set.slice(1)) {
		if (current === prev + 1) {
			prev = current;
			continue;
		}
		parts.push(start === prev ? `${start}` : `${start}-${prev}`);
		start = current;
		prev = current;
	}
	parts.push(start === prev ? `${start}` : `${start}-${prev}`);
	return parts.join(", ");
}

export interface RevealedLine {
	line: number;
	text: string;
}

/** Content preview handed to [`unseenLinesMessage`]. */
export interface UnseenLinesReveal {
	lines: RevealedLine[];
	truncated: boolean;
}

/** Edit referenced lines never displayed by the cited tag's read. */
export function unseenLinesMessage(
	sectionPath: string,
	unseenLines: number[],
	tag: string,
	reveal: UnseenLinesReveal,
): string {
	const ranges = formatLineRanges(unseenLines);
	const selector = ranges.replace(/, /g, ",");
	const header = cont(
		`This edit anchors to lines ${ranges} of ${sectionPath} that §
${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}${tag}${HL_FILE_SUFFIX} never displayed (it §
showed a partial range, a search hit, or a folded summary).`,
	);
	if (reveal.lines.length === 0) {
		return cont(
			`${header} Re-read them in full first with a ranged read like \`${sectionPath}:${selector}\` §
— it skips summarization and mints a fresh tag (a plain re-read just re-folds them) — §
then re-issue the edit.`,
		);
	}
	const preview = reveal.lines
		.map(r => `  ${formatNumberedLine(r.line, r.text)}`)
		.join("\n");
	if (reveal.truncated) {
		return cont(
			`${header} Preview of the actual file content at the first ${reveal.lines.length} unseen §
line(s):\n${preview}\nThe range exceeds the inline preview cap — re-read the remainder §
with \`${sectionPath}:${selector}\` before re-issuing the edit.`,
		);
	}
	return cont(
		`${header} Actual file content at those lines:\n${preview}\nVerify the content matches what §
you intend to touch, then re-issue the edit with the same §
${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX} header — a straight retry now §
succeeds without a re-read. If the content does NOT match, fix your line numbers.`,
	);
}

export type BlockOp = "replace" | "insertAfter" | "cut" | "pasteAfter";

function blockOpForm(op: BlockOp, line: number): string {
	switch (op) {
		case "replace":
			return `PUT ${line}*:`;
		case "insertAfter":
			return `PUT >${line}*:`;
		case "cut":
			return `CUT ${line}*`;
		case "pasteAfter":
			return `PUT >${line}*`;
	}
}

function blockOpPlain(op: BlockOp, line: number): string {
	switch (op) {
		case "replace":
			return `PUT ${line}:`;
		case "insertAfter":
			return `PUT >${line}:`;
		case "cut":
			return `CUT ${line}`;
		case "pasteAfter":
			return `PUT >${line}`;
	}
}

/** A block-op anchor resolved to a single line. */
export function blockSingleLineMessage(line: number, op: BlockOp, enclosingBlock: BlockSpan | null): string {
	const form = blockOpForm(op, line);
	const plainForm = blockOpPlain(op, line);
	let message = cont(
		`\`${form}\` resolved a single-line block — line ${line} is a bare statement, not the opening §
line of a multi-line construct. For only this statement use \`${plainForm}\`.`,
	);
	if (enclosingBlock) {
		const enclosingForm = blockOpForm(op, enclosingBlock.start);
		message += cont(
			` The nearest enclosing multi-line block begins at line ${enclosingBlock.start} and ends at line ${enclosingBlock.end}; use §
\`${enclosingForm}\` to target it.`,
		);
	}
	return message;
}

// -- snapshot-tag mismatch ---------------------------------------------------

/** Context needed to explain a stale or unrecognized snapshot tag. */
export interface MismatchDetails {
	sectionPath: string | null;
	expectedFileHash: string;
	actualFileHash: string;
	fileLines: string[];
	anchorLines: number[];
	/** True when this session minted the expected tag for this path. */
	hashRecognized: boolean;
	/** Paths this session issued `expectedFileHash` for (other than the target). */
	tagOriginPaths: string[];
}

/** Format the complete model-facing snapshot mismatch diagnostic. */
export function mismatchMessage(details: MismatchDetails): string {
	const path = details.sectionPath === null ? "" : ` for ${details.sectionPath}`;
	const lines: string[] = [];
	if (details.hashRecognized) {
		lines.push(cont(`Edit rejected${path}: file changed between read and edit.`));
		lines.push(
			cont(
				`Section is bound to #${details.expectedFileHash}, but the current file hashes to §
#${details.actualFileHash}. If a prior edit in this session modified this file, copy the §
[path#newhash] header from that edit's response; otherwise re-read the file with \`read\` to §
refresh the tag before retrying.`,
			),
		);
	} else {
		lines.push(cont(`Edit rejected${path}: hash #${details.expectedFileHash} is not from this session.`));
		for (const origin of details.tagOriginPaths) {
			lines.push(
				cont(`Hash #${details.expectedFileHash} was issued in this session for ${origin}.`),
			);
		}
		lines.push(
			cont(
				`The current file hashes to #${details.actualFileHash}. Re-read the file with \`read\` to §
copy a current [path#tag] header — never invent the tag and never reuse one from a prior §
session.`,
			),
		);
	}
	const context = formatAnchoredContext(details.anchorLines, details.fileLines);
	if (context.length > 0) {
		lines.push("");
		lines.push(...context);
	}
	return lines.join("\n");
}

// -- no-op diagnostics (port of patcher.rs) ----------------------------------

/** Diagnostic for a clean, byte-identical hashline apply. */
export function noChangeDiagnostic(sectionPath: string): string {
	return cont(
		`Edits to ${sectionPath} parsed and applied cleanly, but produced no change: your body §
row(s) are byte-identical to the file at the targeted lines. The bug is somewhere else — §
re-read the file before issuing another edit. Do NOT widen the payload or add lines; verify §
the anchor first.`,
	);
}

/** Escalated diagnostic for a repeated identical no-op payload. */
export function noChangeLoopDiagnostic(sectionPath: string, count: number): string {
	return cont(
		`STOP. Edits to ${sectionPath} have been a byte-identical no-op ${count} times in a row — §
the patch body matches the file at the targeted lines and the soft hint did not break the §
cycle. Cease re-issuing this payload. Either the intended change is already on disk (move on), §
or your anchor is wrong (re-read the file with \`read\` to observe the current line numbers and §
tag, then author a different edit). This exact payload will keep being rejected until it §
changes.`,
	);
}
