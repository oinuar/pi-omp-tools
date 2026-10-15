/**
 * Tool registration for the pi-omp-tools extension.
 *
 * Each `register*` function registers one tool AND wires the shared prompt
 * contract (see src/registry.ts), so the host's system prompt actively
 * steers the model toward these tools instead of shell/ipython equivalents.
 */
import { Type } from "typebox";
import {
	EDIT_DESCRIPTION,
	FIND_DESCRIPTION,
	READ_DESCRIPTION,
	SEARCH_DESCRIPTION,
	WRITE_DESCRIPTION,
} from "./descriptions.ts";
import type { PiApi, ToolUpdate } from "./host.ts";
import { ensurePromptContract, registeredTools, stampReadGroup } from "./registry.ts";
import {
	editRenderers,
	findRenderers,
	loadRenderSupport,
	readRenderers,
	searchRenderers,
	writeRenderers,
} from "./render.ts";
import { executeEdit } from "./tools/edit.ts";
import { executeFind } from "./tools/find.ts";
import { executeRead } from "./tools/read.ts";
import { executeSearch, type SearchParams } from "./tools/search.ts";
import { executeWrite } from "./tools/write.ts";


export async function registerRead(pi: PiApi): Promise<void> {
	registeredTools.add("read");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? { renderShell: "self", ...readRenderers(support) } : {}),
		name: "read",
		label: "Read",
		description: READ_DESCRIPTION,
		promptSnippet: "Read files, dirs, archives, SQLite, PDFs, notebooks, and URLs through one path",
		promptGuidelines: [
			"Use read (never cat/head/sed or python file reads) for file, directory, archive, SQLite, PDF, notebook, and URL content; it returns the [path#TAG] anchors that edit requires.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "file/dir/archive/sqlite/pdf/notebook path or URL, with optional :selectors" }),
		}),
		async execute(toolCallId: string, params: { path: string }, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
			const result = await executeRead(params.path, ctx, signal);
			// Group id persists in details so replayed sessions collapse
			// consecutive reads exactly like the live render did.
			stampReadGroup(toolCallId, result);
			return result;
		},
	});
}

export async function registerWrite(pi: PiApi): Promise<void> {
	registeredTools.add("write");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? { renderShell: "self", ...writeRenderers(support) } : {}),
		name: "write",
		label: "Write",
		description: WRITE_DESCRIPTION,
		promptSnippet: "Create or overwrite a file, archive entry, or SQLite row",
		promptGuidelines: [
			"Use write (never shell redirection or python file writes) to create files or fully rewrite them; prefer edit for modifying existing files.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "file path, archive.ext:member, or db.sqlite:table[:key]" }),
			content: Type.String({ description: "file content (JSON5 for sqlite rows; empty string deletes a keyed sqlite row)" }),
		}),
		async execute(_id: string, params: { path: string; content: string }, signal?: AbortSignal, onUpdate?: unknown, ctx?: { cwd?: string }) {
			return executeWrite(params.path, params.content, ctx, onUpdate as ToolUpdate | undefined, signal);
		},
	});
}

export async function registerEdit(pi: PiApi): Promise<void> {
	registeredTools.add("edit");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? { renderShell: "self", ...editRenderers(support) } : {}),
		// Daemon-attached prime TUIs cannot receive render functions; this string
		// survives serialization and activates the TUI's built-in edit renderer
		// (red/green diff from details.diff). In-process hosts (pi) use our own
		// renderers above, which take precedence over replay.
		replayBuiltInToolName: "edit",
		name: "edit",
		label: "edit",
		description: EDIT_DESCRIPTION,
		promptSnippet: "Hashline patches with content-hash anchors and stale-anchor recovery",
		promptGuidelines: [
			"Use edit (hashline patches) for every modification to an existing file instead of sed/awk/python rewrites; anchor each [path#TAG] section with the tag from your latest read or search of that file.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "primary file being edited (display metadata; the patch sections name the real targets)" }),
			input: Type.String({ description: "hashline patch text ([PATH#TAG] sections with PUT/CUT/REM/MV ops and +body rows)" }),
		}),
		prepareArguments(args: unknown) {
			// Older sessions (and forgetful models) may omit `path`; derive it from
			// the first section header so validation passes.
			if (!args || typeof args !== "object") return args;
			const input = args as { path?: unknown; input?: unknown };
			if (typeof input.path === "string" || typeof input.input !== "string") return args;
			const header = /^\[([^\]#]+)/m.exec(input.input);
			return { ...input, path: header?.[1] ?? "" };
		},
		async execute(_id: string, params: { path?: string; input: string }, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
			return executeEdit(params.input, ctx);
		},
	});
}

export async function registerSearch(pi: PiApi): Promise<void> {
	registeredTools.add("search");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? { renderShell: "self", ...searchRenderers(support) } : {}),
		name: "search",
		label: "Search",
		description: SEARCH_DESCRIPTION,
		promptSnippet: "Regex search over files, globs, and directories",
		promptGuidelines: [
			"Use search instead of shell grep/rg for content lookups; its *N:text rows and #TAG headers double as edit anchors.",
		],
		parameters: Type.Object({
			pattern: Type.String({ description: "regex pattern (ripgrep/Rust regex syntax)" }),
			path: Type.Optional(Type.String({ description: "file, directory, or glob; ; -separated list; a file may carry a :line-range selector. Default ." })),
			case: Type.Optional(Type.Boolean({ description: "case-sensitive (default true); false for case-insensitive" })),
			gitignore: Type.Optional(Type.Boolean({ description: "respect gitignore (default true)" })),
			skip: Type.Optional(Type.Number({ description: "files to skip (pagination, 20 per page)" })),
		}),
		async execute(_id: string, params: SearchParams, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
			return executeSearch(params, ctx, signal);
		},
	});
}

export async function registerFind(pi: PiApi): Promise<void> {
	registeredTools.add("find");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? { renderShell: "self", ...findRenderers(support) } : {}),
		name: "find",
		label: "Find",
		description: FIND_DESCRIPTION,
		promptSnippet: "Glob-based path lookup, newest-first",
		promptGuidelines: [
			"Use find instead of shell find/ls for path discovery by glob; use search when you need content matches.",
		],
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description:
						"Glob, file, or directory; semicolon-separated list (existing paths keep their delimiters). Omitted defaults to the workspace root; an explicit empty string is rejected; a lone / means the session cwd.",
				}),
			),
			hidden: Type.Optional(Type.Boolean({ description: "Include hidden files. Defaults to true." })),
			gitignore: Type.Optional(Type.Boolean({ description: "Respect .gitignore during local globbing. Defaults to true; set false to include ignored files." })),
			limit: Type.Optional(Type.Number({ description: "Max returned paths. Defaults to 200; floored then clamped to 1..200." })),
		}),
		async execute(
			_id: string,
			params: { path?: string; hidden?: boolean; gitignore?: boolean; limit?: number },
			signal?: AbortSignal,
			onUpdate?: unknown,
			ctx?: { cwd?: string },
		) {
			return executeFind(params, ctx, signal, onUpdate as ToolUpdate | undefined);
		},
	});
}


export async function registerAll(pi: PiApi): Promise<void> {
	await registerRead(pi);
	await registerWrite(pi);
	await registerEdit(pi);
	await registerSearch(pi);
	await registerFind(pi);
}
