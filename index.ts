/**
 * pi-omp-tools — one standalone pi extension registering the five
 * file/search tools: `read`, `write`, `edit` (hashline patches),
 * `search`, and `find`.
 */
import type { PiApi } from "./src/host.ts";
import { registerEdit, registerFind, registerRead, registerSearch, registerWrite } from "./src/register.ts";

export default async function (pi: PiApi): Promise<void> {
	await registerRead(pi);
	await registerWrite(pi);
	await registerEdit(pi);
	await registerSearch(pi);
	await registerFind(pi);
}

export { registerAll, registerEdit, registerFind, registerRead, registerSearch, registerWrite } from "./src/register.ts";
export { executeEdit } from "./src/tools/edit.ts";
export { executeFind } from "./src/tools/find.ts";
export { executeRead } from "./src/tools/read.ts";
export { executeSearch, type SearchParams } from "./src/tools/search.ts";
export { executeWrite } from "./src/tools/write.ts";
export {
	ToolError,
	type ContentPart,
	type ImagePart,
	type PiApi,
	type TextPart,
	type ToolCtx,
	type ToolResult,
	type ToolUpdate,
} from "./src/host.ts";
