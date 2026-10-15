/**
 * Session snapshot store binding hashline section tags to the exact file
 * content that minted them (port of OMP's
 * `pi-edit::store::EditStore`).
 *
 * A tag is the lower 16 bits of XXH32 over per-line trailing-whitespace
 * stripped file text, rendered as 4 uppercase hex chars — byte-identical to
 * OMP's `file_hash`. Per (path, tag) the lines that read/search displayed
 * are tracked (`seenLines`); the unseen-lines guard and its inline reveal
 * build on that provenance.
 */
import { xxh32 } from "./xxhash.ts";

// --- limits (mirroring pi-edit::store) ---
export const MAX_PATHS = 256;
export const MAX_VERSIONS_PER_PATH = 4;
/** Global ceiling on retained snapshot text, measured in UTF-16 code units. */
export const MAX_TOTAL_UNITS = 64 * 1024 * 1024;
/** Files larger than this are never snapshotted from disk. */
export const MAX_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024;
/** Consecutive identical no-ops before the guard escalates. */
export const NOOP_HARD_LIMIT = 3;

export interface Snapshot {
	/** Canonical (session-cwd-relative) path this version belongs to. */
	path: string;
	/** Full LF-normalized text. */
	text: string;
	/** Four-character content tag. */
	hash: string;
	/** Lines displayed from this version, when provenance was recorded. */
	seenLines?: Set<number>;
}

interface StoredSnapshot {
	snapshot: Snapshot;
	units: number;
}

interface PathHistory {
	versions: StoredSnapshot[];
	touched: number;
}

interface StoreState {
	histories: Map<string, PathHistory>;
	noop: Map<string, { hash: number; count: number }>;
	clock: number;
	maxPaths: number;
	maxVersions: number;
	maxTotalUnits: number;
	retainedUnits: number;
}

const utf16Len = (s: string) => [...s].length;
const retainedUnitsOf = (history: PathHistory) => 1 + history.versions.reduce((sum, v) => sum + v.units, 0);

/** Per-LF-segment trailing `[ \t\r]` stripping (OMP `file_hash` normalization;
 * lone `\r` line separators are kept). */
export function normalizeForHash(text: string): string {
	return text
		.split("\n")
		.map(segment => segment.replace(/[ \t\r]+$/, ""))
		.join("\n");
}

/**
 * Normalize file text for snapshot hashing / comparison: strip a leading BOM
 * and unify line endings to `\n` (OMP `strip_bom` + `normalize_to_lf`).
 */
export function normalizeForSnapshot(text: string): string {
	let out = text;
	if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
	return out.replace(/\r\n?/g, "\n");
}

function mergeSeen(snapshot: Snapshot, lines?: number[] | Set<number>): void {
	if (!lines) return;
	if (!snapshot.seenLines) snapshot.seenLines = new Set();
	for (const line of lines) snapshot.seenLines.add(line);
}

class SnapshotStore {
	private state: StoreState;

	constructor() {
		this.state = {
			histories: new Map(),
			noop: new Map(),
			clock: 0,
			maxPaths: MAX_PATHS,
			maxVersions: MAX_VERSIONS_PER_PATH,
			maxTotalUnits: MAX_TOTAL_UNITS,
			retainedUnits: 0,
		};
	}

	/** Lower-16-bit XXH32 tag of the trailing-whitespace-stripped text. */
	computeHash(text: string): string {
		const normalized = normalizeForHash(text);
		return (xxh32(new TextEncoder().encode(normalized), 0) & 0xffff)
			.toString(16)
			.toUpperCase()
			.padStart(4, "0");
	}

	/** Record normalized text under a canonical path and return its tag. */
	record(path: string, text: string, seenLines?: number[] | Set<number>): string {
		const hash = this.computeHash(text);
		const state = this.state;
		state.clock += 1;
		let previousUnits = 0;
		let history = state.histories.get(path);
		if (history) {
			previousUnits = retainedUnitsOf(history);
			history.touched = state.clock;
		} else {
			history = { versions: [], touched: state.clock };
			state.histories.set(path, history);
		}
		const existingIndex = history.versions.findIndex(
			v => v.snapshot.hash === hash && v.snapshot.text === text,
		);
		if (existingIndex >= 0) {
			const stored = history.versions.splice(existingIndex, 1)[0];
			mergeSeen(stored.snapshot, seenLines);
			history.versions.unshift(stored);
		} else if (state.maxVersions > 0) {
			const snapshot: Snapshot = { path, text, hash };
			mergeSeen(snapshot, seenLines);
			history.versions.unshift({ snapshot, units: utf16Len(text) });
			if (history.versions.length > state.maxVersions) {
				history.versions.length = state.maxVersions;
			}
		}
		state.retainedUnits = state.retainedUnits - previousUnits + retainedUnitsOf(history);
		this.evict(state);
		return hash;
	}

	/** Union displayed lines into the most recent version matching a tag. */
	recordSeenLines(path: string, hash: string, lines: number[]): void {
		const state = this.state;
		state.clock += 1;
		const history = state.histories.get(path);
		if (!history) return;
		history.touched = state.clock;
		const version = history.versions.find(v => v.snapshot.hash === hash);
		if (version) mergeSeen(version.snapshot, lines);
	}

	/** Latest recorded version for a path (refreshes recency). */
	head(path: string): Snapshot | null {
		return this.touchAndGet(path, h => h.versions[0]?.snapshot ?? null);
	}

	/** Any recorded version whose hash matches (refreshes recency). */
	byHash(path: string, hash: string): Snapshot | null {
		return this.touchAndGet(path, h => h.versions.find(v => v.snapshot.hash === hash)?.snapshot ?? null);
	}

	/** The version with exactly equal text and refresh path recency. */
	byContent(path: string, text: string): Snapshot | null {
		return this.touchAndGet(path, h => h.versions.find(v => v.snapshot.text === text)?.snapshot ?? null);
	}

	/** All retained versions for a path, newest first (refreshes recency). */
	versions(path: string): Snapshot[] {
		const state = this.state;
		state.clock += 1;
		const history = state.histories.get(path);
		if (!history) return [];
		history.touched = state.clock;
		return history.versions.map(v => v.snapshot);
	}

	/** All retained snapshots (any path) whose tag matches, most recent first. */
	findByHash(hash: string): Snapshot[] {
		const normalized = hash.toUpperCase();
		const state = this.state;
		const matches: Snapshot[] = [];
		for (const history of [...state.histories.values()].sort((a, b) => b.touched - a.touched)) {
			for (const stored of history.versions) {
				if (stored.snapshot.hash === normalized) matches.push(stored.snapshot);
			}
		}
		return matches;
	}

	/** Remove all recorded state for a path. */
	invalidate(path: string): void {
		const state = this.state;
		const history = state.histories.get(path);
		if (history) {
			state.retainedUnits -= retainedUnitsOf(history);
			state.histories.delete(path);
		}
	}

	/** Move source history and provenance to a destination path. */
	relocate(from: string, to: string): void {
		const state = this.state;
		state.clock += 1;
		const touched = state.clock;
		const source = state.histories.get(from);
		if (!source) return;
		state.histories.delete(from);
		state.retainedUnits -= retainedUnitsOf(source);
		let dest = state.histories.get(to);
		if (dest) {
			state.retainedUnits -= retainedUnitsOf(dest);
		} else {
			dest = { versions: [], touched };
			state.histories.set(to, dest);
		}
		for (const stored of source.versions) {
			stored.snapshot.path = to;
			const existingIndex = dest.versions.findIndex(
				v => v.snapshot.hash === stored.snapshot.hash && v.snapshot.text === stored.snapshot.text,
			);
			if (existingIndex >= 0) {
				const keep = dest.versions.splice(existingIndex, 1)[0];
				mergeSeen(keep.snapshot, stored.snapshot.seenLines);
				dest.versions.unshift(keep);
			} else {
				dest.versions.unshift(stored);
			}
		}
		dest.touched = touched;
		if (dest.versions.length > state.maxVersions) dest.versions.length = state.maxVersions;
		state.retainedUnits += retainedUnitsOf(dest);
		this.evict(state);
	}

	/** Record an identical no-op; returns [count, escalated]. */
	recordNoop(path: string, payloadHash: number): [number, boolean] {
		const state = this.state;
		const existing = state.noop.get(path);
		const count = existing && existing.hash === payloadHash ? existing.count + 1 : 1;
		state.noop.set(path, { hash: payloadHash, count });
		return [count, count >= NOOP_HARD_LIMIT];
	}

	/** Clear one path's no-op counter. */
	resetNoop(path: string): void {
		this.state.noop.delete(path);
	}

	/** Stable numeric key for raw patch payloads (64-bit FNV-1a, low 32 bits). */
	payloadHash(payload: string): number {
		let h = 0xcbf29ce484222325n;
		for (const byte of new TextEncoder().encode(payload)) {
			h ^= BigInt(byte);
			h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
		}
		return Number(h & 0xffffffffn);
	}

	private touchAndGet(path: string, pick: (history: PathHistory) => Snapshot | null): Snapshot | null {
		const state = this.state;
		state.clock += 1;
		const history = state.histories.get(path);
		if (!history) return null;
		history.touched = state.clock;
		return pick(history);
	}

	private evict(state: StoreState): void {
		let guard = 0;
		while (
			(state.histories.size > state.maxPaths || state.retainedUnits > state.maxTotalUnits) &&
			guard++ < 4096
		) {
			let oldest: string | null = null;
			let oldestTouched = Infinity;
			for (const [path, history] of state.histories) {
				if (history.touched < oldestTouched) {
					oldestTouched = history.touched;
					oldest = path;
				}
			}
			if (!oldest) break;
			const history = state.histories.get(oldest)!;
			state.retainedUnits -= retainedUnitsOf(history);
			state.histories.delete(oldest);
		}
	}
}

// One store per agent process, anchored on `globalThis` so all five tools
// (read/search/write/edit/find) share the same tag minting and validation.
const SNAPSHOT_KEY = Symbol.for("omp-tools.snapshots.v2");

const globalRegistry = globalThis as Record<PropertyKey, unknown>;
export const snapshots = (globalRegistry[SNAPSHOT_KEY] ??= new SnapshotStore()) as SnapshotStore;

/** OMP `file_hash` over snapshot-normalized text. */
export function computeFileTag(text: string): string {
	return snapshots.computeHash(normalizeForSnapshot(text));
}

const SEEN_LINE_PREFIX_RE = /^[ *]?(\d+)(?:-(\d+))?:(.*)$/;

/**
 * Displayed boundary line numbers parsed from a hashline-formatted response
 * body (port of OMP's `store::seen_lines_from_body`).
 */
export function seenLinesFromBody(body: string): number[] {
	const seen: number[] = [];
	for (const row of body.split("\n")) {
		const match = SEEN_LINE_PREFIX_RE.exec(row);
		if (!match) continue;
		const start = Number.parseInt(match[1] as string, 10);
		if (Number.isFinite(start)) seen.push(start);
		if (match[2]) {
			const end = Number.parseInt(match[2] as string, 10);
			if (Number.isFinite(end)) seen.push(end);
		}
	}
	return seen;
}
