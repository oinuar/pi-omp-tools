/**
 * Shared tool registry + system-prompt contract, split out of register.ts so
 * every tool module can participate without touching a shared file:
 *
 *  - `registeredTools` — process-global set of OMP Tools tool names
 *    registered so far (anchored on globalThis).
 *  - `ensurePromptContract(pi)` — wires the before_agent_start /
 *    session_start / tool_call handlers exactly once per process.
 */
import { type PiApi, sessionId } from "./host.ts";

/** Names of OMP Tools registered in this process. */
const REGISTERED_KEY = Symbol.for("omp-tools.registered.v1");
const CONTRACT_KEY = Symbol.for("omp-tools.contract.v1");
const globalRegistry = globalThis as Record<PropertyKey, unknown>;
globalRegistry[REGISTERED_KEY] ??= new Set<string>();
export const registeredTools = globalRegistry[REGISTERED_KEY] as Set<string>;

/**
 * Read-group tracker: consecutive `read` tool calls (no other tool, no
 * assistant prose, no user message in between) share one group id, so the
 * renderer can collapse them into a single `• Read (N)` tree.
 *
 * Group ids are stamped into each read result's details at execute time
 * (persisted with the session), so replayed transcripts group exactly like
 * the live session did. The boot prefix keeps ids from a previous process
 * from colliding with this one's counters, and the per-session counter map
 * keeps concurrent sessions in one process (daemon hosts) from either
 * splitting each other's groups or colliding into the same group id.
 */
const READ_GROUPS_KEY = Symbol.for("omp-tools.read-groups.v2");
interface ReadGroupTracker {
	boot: string;
	/** Per-session break counter; sessions are never removed (one number each). */
	counters: Map<string, number>;
	byCall: Map<string, string>;
}
globalRegistry[READ_GROUPS_KEY] ??= {
	boot: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
	counters: new Map<string, number>(),
	byCall: new Map<string, string>(),
} satisfies ReadGroupTracker;
const readGroups = globalRegistry[READ_GROUPS_KEY] as ReadGroupTracker;

/** Session bucket for group ids; hosts without a session ctx share "". */
function sessionKeyOf(ctx: unknown): string {
	return sessionId(ctx) ?? "";
}

/** Live group id for a read tool call, if the tracker saw its tool_call event. */
export function readGroupOf(toolCallId: string | undefined): string | undefined {
	return toolCallId ? readGroups.byCall.get(toolCallId) : undefined;
}

/** Stamp the group id into a read result's details so replays group identically. */
export function stampReadGroup(toolCallId: string, result: unknown): void {
	const group = readGroups.byCall.get(toolCallId);
	if (!group || !result || typeof result !== "object") return;
	const details = (result as { details?: Record<string, unknown> }).details;
	if (details && typeof details === "object") details.readGroup = group;
}

function breakReadGroup(sessionKey: string): void {
	readGroups.counters.set(sessionKey, (readGroups.counters.get(sessionKey) ?? 0) + 1);
}

function trackReadGroup(toolName: string | undefined, toolCallId: string | undefined, sessionKey: string): void {
	if (toolName !== "read") {
		breakReadGroup(sessionKey);
		return;
	}
	if (!toolCallId) {
		// A read we cannot track must fence the group: otherwise its solo
		// panel would sit between its neighbours' collapsed slots and the
		// group widget, visually reordering the transcript.
		breakReadGroup(sessionKey);
		return;
	}
	const scope = sessionKey ? `${sessionKey}:` : "";
	readGroups.byCall.set(toolCallId, `${readGroups.boot}:${scope}${readGroups.counters.get(sessionKey) ?? 0}`);
	if (readGroups.byCall.size > 1024) {
		for (const key of readGroups.byCall.keys()) {
			if (readGroups.byCall.size <= 512) break;
			readGroups.byCall.delete(key);
		}
	}
}

/** True when a finished message contains visible text (assistant prose / user prompt). */
function messageHasProse(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const { role, content } = message as { role?: unknown; content?: unknown };
	// Allowlist visible roles: hosts also finish invisible bookkeeping
	// messages (e.g. custom/display:false context notes) whose text must not
	// split a group, and unknown fork-specific roles must not disable
	// grouping wholesale by breaking after every read.
	if (role !== "assistant" && role !== "user") return false;
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some(part => {
		if (!part || typeof part !== "object") return false;
		const { type, text } = part as { type?: unknown; text?: unknown };
		return type === "text" && typeof text === "string" && text.trim().length > 0;
	});
}

const TOOL_SUMMARIES: Record<string, string> = {
	read: "read — files, dirs, archives, SQLite, PDFs, notebooks, URLs through one path; mints [path#TAG] anchors",
	write: "write — create/overwrite a file, archive entry, or SQLite row",
	edit: "edit — hashline patches anchored on [path#TAG] + original line numbers from read/search",
	search: "search — regex over files/globs; output rows are valid edit anchors",
	find: "find — glob path lookup (newest-first)",
};

const TOOL_ORDER = [
	"read",
	"write",
	"edit",
	"search",
	"find",
];

function buildContractBlock(): string {
	if (registeredTools.size === 0) return "";
	const lines: string[] = ["## OMP Tools"];
	for (const name of TOOL_ORDER) {
		if (registeredTools.has(name)) lines.push(`- ${TOOL_SUMMARIES[name]}`);
	}
	if (registeredTools.has("edit")) {
		lines.push(
			"",
			"Anchor loop: `read`/`search` output `[path#TAG]` headers with `N:text` rows; `edit` sections copy that exact tag and name ORIGINAL line numbers. " +
				"After an edit, the response shows fresh line numbers and the new tag — use those (or re-read) before the next edit on the same file.",
		);
	}
	return lines.join("\n");
}

/** Wire prompt-contract + builtin-retirement handlers exactly once per process. */
export function ensurePromptContract(pi: PiApi): void {
	if (globalRegistry[CONTRACT_KEY]) return;
	globalRegistry[CONTRACT_KEY] = true;
	if (typeof pi.on !== "function") return;

	pi.on("before_agent_start", async (event: unknown) => {
		const block = buildContractBlock();
		if (!block) return undefined;
		if (!event || typeof event !== "object" || !("systemPrompt" in event)) return undefined;
		const systemPrompt = event.systemPrompt;
		if (typeof systemPrompt !== "string" || systemPrompt.includes("## OMP Tools")) return undefined;
		return { systemPrompt: `${systemPrompt}\n\n${block}` };
	});

	pi.on("session_start", async (_event: unknown, ctx?: unknown) => {
		// A new (or resumed) session starts fresh: never continue a group
		// across a session boundary in the same process.
		breakReadGroup(sessionKeyOf(ctx));
		retireOverlappingBuiltins(pi);
	});

	pi.on("tool_call", async (event: unknown, ctx?: unknown) => {
		if (!event || typeof event !== "object") return undefined;
		const toolName = "toolName" in event && typeof event.toolName === "string" ? event.toolName : undefined;
		const toolCallId = "toolCallId" in event && typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		trackReadGroup(toolName, toolCallId, sessionKeyOf(ctx));
		return undefined;
	});

	// Visible text between reads (assistant prose or a new user prompt)
	// separates their panels in the transcript, so it must break the group.
	pi.on("message_end", async (event: unknown, ctx?: unknown) => {
		if (!event || typeof event !== "object" || !("message" in event)) return undefined;
		if (messageHasProse((event as { message?: unknown }).message)) breakReadGroup(sessionKeyOf(ctx));
		return undefined;
	});
}

/**
 * Deactivate built-in tools that duplicate an installed OMP Tools tool's purpose.
 * Same-name tools (read/write/edit/...) are replaced by registration
 * already; this handles differently-named ones (pi's grep/glob/ls vs
 * search/find).
 */
function retireOverlappingBuiltins(pi: PiApi): void {
	if (process.env.OMP_TOOLS_KEEP_BUILTINS === "1") return;
	try {
		// tool management is a host extra outside the minimal PiApi surface
		const host = pi as { getActiveTools?: () => unknown[]; setActiveTools?: (names: string[]) => void };
		if (typeof host.getActiveTools !== "function" || typeof host.setActiveTools !== "function") return;
		const active: string[] = [];
		for (const tool of host.getActiveTools.call(pi)) {
			if (typeof tool === "string") active.push(tool);
			else if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") active.push(tool.name);
		}
		const retire = new Set<string>();
		if (registeredTools.has("search")) {
			retire.add("grep");
			retire.add("rg");
		}
		if (registeredTools.has("find")) {
			retire.add("glob");
			retire.add("ls");
		}
		const next = active.filter(name => !retire.has(name));
		if (next.length !== active.length) host.setActiveTools.call(pi, next);
	} catch {
		/* host without tool management — fine */
	}
}
