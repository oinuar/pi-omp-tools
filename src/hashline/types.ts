/**
 * Pure data types shared across the hashline tokenizer, parser, applier, and
 * patcher (port of OMP's `modes/hashline/types.rs`; nothing here touches a
 * filesystem).
 */
import type { Clipboard } from "./clipboard.ts";

export type { Clipboard };

/** A 1-indexed line anchor. */
export interface Anchor {
	line: number;
}

/** Where an `insert` edit lands relative to existing content. */
export type Cursor =
	| { kind: "bof" }
	| { kind: "eof" }
	| { kind: "before"; line: number }
	| { kind: "after"; line: number };

/** A parsed `A-B` inclusive line range. */
export interface ParsedRange {
	start: Anchor;
	end: Anchor;
}

/** Where a `paste` edit lands: an insertion gap, or a span it replaces. */
export type PasteTarget = { kind: "gap"; cursor: Cursor } | { kind: "span"; range: ParsedRange };

/** Deferred block-op mode (`undefined` = block replacement). */
export type BlockMode = "insertAfter" | "cut" | "pasteAfter";

interface EditBase {
	/** Payload line number the edit was parsed from. */
	lineNum: number;
	/** Position in the section's op list. */
	index: number;
}

/** One low-level edit produced by the parser and consumed by the applier. */
export type Edit =
	| (EditBase & {
			kind: "insert";
			cursor: Cursor;
			text: string;
			/** True for replacement-payload inserts (vs. literal insertion). */
			replacement: boolean;
			/** Resolved block's first line for inserts lowered from
			 * `insert_after_block`; bounds landing correction. */
			blockStart?: number;
	  })
	| (EditBase & {
			kind: "delete";
			anchor: Anchor;
		/** Expected old content (`-` assertion row) when the payload carried one. */
		oldAssertion: string | null;
	  })
	| (EditBase & {
			kind: "cut";
			range: ParsedRange;
			register?: string;
	  })
	| (EditBase & {
			kind: "paste";
			at: PasteTarget;
			register?: string;
			blockStart?: number;
	  })
	| (EditBase & {
			/** Deferred block edit (`PUT N*:`, `PUT >N*:`, `CUT N*`, `@register`
			 * forms); resolved to concrete edits once file text is available. */
			kind: "block";
			anchor: Anchor;
			payloads: string[];
			mode?: BlockMode;
			register?: string;
	  });

/** File-level operation parsed from a section body (`REM` / `MV`). */
export type FileOp = { kind: "rem" } | { kind: "move"; dest: string };

/** Which block op produced a [`BlockResolution`]. */
export type BlockOpKind = "replace" | "insertAfter" | "cut" | "pasteAfter";

/** One block-op anchor resolved to its concrete line span. */
export interface BlockResolution {
	/** The 1-indexed line the block op was anchored on (the `N`). */
	anchorLine: number;
	start: number;
	end: number;
	op: BlockOpKind;
}

/** Resolved 1-indexed inclusive line span of a block target. */
export interface BlockSpan {
	start: number;
	end: number;
}

/** Result of applying a parsed set of edits to a text body. */
export interface ApplyResult {
	text: string;
	/** 1-indexed first changed line; `undefined` for a no-op apply. */
	firstChangedLine?: number;
	warnings: string[];
	/** Resolved spans for each block op, in patch order (only when the apply
	 * matched the tagged content). */
	blockResolutions: BlockResolution[];
}
