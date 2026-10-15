/**
 * Hashline engine error type. The host tool layer converts these into
 * `ToolError` for the model.
 */
export class HashlineError extends Error {
	/** Optional 1-indexed patch line the error was raised at. */
	lineNum?: number;

	constructor(message: string, lineNum?: number) {
		super(message);
		this.name = "HashlineError";
		this.lineNum = lineNum;
	}
}
