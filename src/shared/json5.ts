/**
 * JSON5 parser (json5.org) used for SQLite row content so payloads like
 * `{name: 'Ada', active: true}` work exactly as in OMP's
 * `Bun.JSON5.parse(...)`. Node has no built-in JSON5, so this is a compact
 * spec-complete parser: unquoted identifier keys, single-quoted strings,
 * trailing commas, comments, hex numbers, `Infinity`/`NaN`, line
 * continuations.
 */

const WS_RE = /[\t\n\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
const IDENT_START_RE = /[A-Za-z_$]/;
const IDENT_PART_RE = /[A-Za-z0-9_$]/;
const HEX_DIGIT_RE = /[0-9A-Fa-f]/;

class Json5Error extends SyntaxError {}

class Parser {
	private readonly text: string;
	private pos = 0;

	constructor(text: string) {
		this.text = text;
	}


	parse(): unknown {
		this.skipWs();
		const value = this.value();
		this.skipWs();
		if (this.pos < this.text.length) throw this.error(`Unexpected token '${this.text[this.pos]}'`);
		return value;
	}

	private error(message: string): Json5Error {
		return new Json5Error(`${message} at position ${this.pos}`);
	}

	private skipWs(): void {
		const text = this.text;
		while (this.pos < text.length) {
			const ch = text[this.pos]!;
			if (WS_RE.test(ch)) {
				this.pos += 1;
			} else if (ch === "/" && text[this.pos + 1] === "/") {
				while (this.pos < text.length && text[this.pos] !== "\n") this.pos += 1;
			} else if (ch === "/" && text[this.pos + 1] === "*") {
				const end = text.indexOf("*/", this.pos + 2);
				if (end === -1) throw this.error("Unterminated comment");
				this.pos = end + 2;
			} else {
				break;
			}
		}
	}

	private value(): unknown {
		this.skipWs();
		const ch = this.peek();
		if (ch === undefined) throw this.error("Unexpected end of input");
		if (ch === "{") return this.object();
		if (ch === "[") return this.array();
		if (ch === '"' || ch === "'") return this.string(ch);
		if (ch === "-" || ch === "+" || ch === "." || (ch >= "0" && ch <= "9")) return this.number();
		if (IDENT_START_RE.test(ch)) return this.literal();
		throw this.error(`Unexpected token '${ch}'`);
	}

	private peek(): string | undefined {
		return this.text[this.pos];
	}

	private object(): Record<string, unknown> {
		this.pos += 1; // {
		const result: Record<string, unknown> = {};
		for (;;) {
			this.skipWs();
			let ch = this.peek();
			if (ch === undefined) throw this.error("Unexpected end of input");
			if (ch === "}") {
				this.pos += 1;
				return result;
			}
			let key: string;
			if (ch === '"' || ch === "'") {
				key = this.string(ch);
			} else if (IDENT_START_RE.test(ch)) {
				key = this.identifier();
			} else {
				throw this.error(`Unexpected token '${ch}'`);
			}
			this.skipWs();
			if (this.peek() !== ":") throw this.error("Expected ':'");
			this.pos += 1;
			result[key] = this.value();
			this.skipWs();
			ch = this.peek();
			if (ch === ",") {
				this.pos += 1;
			} else if (ch === "}") {
				this.pos += 1;
				return result;
			} else {
				throw this.error(ch === undefined ? "Unexpected end of input" : `Unexpected token '${ch}'`);
			}
		}
	}

	private array(): unknown[] {
		this.pos += 1; // [
		const result: unknown[] = [];
		for (;;) {
			this.skipWs();
			const ch = this.peek();
			if (ch === undefined) throw this.error("Unexpected end of input");
			if (ch === "]") {
				this.pos += 1;
				return result;
			}
			result.push(this.value());
			this.skipWs();
			const next = this.peek();
			if (next === ",") {
				this.pos += 1;
			} else if (next === "]") {
				this.pos += 1;
				return result;
			} else {
				throw this.error(next === undefined ? "Unexpected end of input" : `Unexpected token '${next}'`);
			}
		}
	}

	private string(quote: string): string {
		this.pos += 1; // opening quote
		let out = "";
		const text = this.text;
		while (this.pos < text.length) {
			const ch = text[this.pos]!;
			if (ch === quote) {
				this.pos += 1;
				return out;
			}
			if (ch === "\n" || ch === "\r") throw this.error("Unterminated string");
			if (ch === "\\") {
				const esc = text[this.pos + 1];
				if (esc === "n") {
					out += "\n";
					this.pos += 2;
				} else if (esc === "t") {
					out += "\t";
					this.pos += 2;
				} else if (esc === "r") {
					out += "\r";
					this.pos += 2;
				} else if (esc === "b") {
					out += "\b";
					this.pos += 2;
				} else if (esc === "x") {
					out += String.fromCharCode(this.hexDigits(2, "hex escape"));
					this.pos += 4;
				} else if (esc === "u") {
					out += String.fromCharCode(this.hexDigits(4, "unicode escape"));
					this.pos += 6;
				} else if (esc === "\n") {
					this.pos += 2; // line continuation
				} else if (esc === "\r" && text[this.pos + 2] === "\n") {
					this.pos += 3; // line continuation (CRLF)
				} else if (esc === "'" || esc === '"' || esc === "\\" || esc === "/") {
					out += esc;
					this.pos += 2;
				} else {
					throw this.error(`Invalid escape: '\\${esc}'`);
				}
			} else {
				out += ch;
				this.pos += 1;
			}
		}
		throw this.error("Unterminated string");
	}

	private hexDigits(count: number, label: string): number {
		let value = 0;
		for (let i = 0; i < count; i += 1) {
			const ch = this.text[this.pos + 2 + i];
			if (!HEX_DIGIT_RE.test(ch ?? "")) throw this.error(`Invalid ${label}`);
			value = value * 16 + parseInt(ch!, 16);
		}
		return value;
	}

	private number(): unknown {
		const start = this.pos;
		const text = this.text;
		let sign = 1;
		if (text[this.pos] === "-") {
			sign = -1;
			this.pos += 1;
		} else if (text[this.pos] === "+") {
			this.pos += 1;
		}

		if (text.startsWith("Infinity", this.pos)) {
			this.pos += 8;
			return sign * Infinity;
		}
		if (text.startsWith("NaN", this.pos)) {
			this.pos += 3;
			return NaN;
		}

		if (text[this.pos] === "0" && (text[this.pos + 1] === "x" || text[this.pos + 1] === "X")) {
			this.pos += 2;
			const hexStart = this.pos;
			while (this.pos < text.length && HEX_DIGIT_RE.test(text[this.pos]!)) this.pos += 1;
			if (this.pos === hexStart) throw this.error("Invalid number");
			return parseInt(text.slice(hexStart, this.pos), 16);
		}

		let hasDigits = false;
		let hasDot = false;
		while (this.pos < text.length) {
			const ch = text[this.pos]!;
			if (ch >= "0" && ch <= "9") {
				hasDigits = true;
				this.pos += 1;
			} else if (ch === "." && !hasDot) {
				hasDot = true;
				this.pos += 1;
			} else {
				break;
			}
		}
		if (!hasDigits) throw this.error("Invalid number");
		// JSON5 forbids leading zeros (01 is a syntax error, not octal).
		const body = text.slice(start, this.pos).replace(/^[+-]/, "");
		if (/^0\d/.test(body)) throw this.error("Invalid number: leading zeros are not allowed");

		if (text[this.pos] === "e" || text[this.pos] === "E") {
			const expStart = this.pos;
			this.pos += 1;
			if (text[this.pos] === "+" || text[this.pos] === "-") this.pos += 1;
			let expDigits = false;
			while (this.pos < text.length && text[this.pos] >= "0" && text[this.pos] <= "9") {
				expDigits = true;
				this.pos += 1;
			}
			if (!expDigits) {
				this.pos = expStart;
			}
		}
		return sign * Number(text.slice(start, this.pos));
	}

	private identifier(): string {
		const start = this.pos;
		while (this.pos < this.text.length && IDENT_PART_RE.test(this.text[this.pos]!)) this.pos += 1;
		return this.text.slice(start, this.pos);
	}

	private literal(): unknown {
		const word = this.identifier();
		switch (word) {
			case "true":
				return true;
			case "false":
				return false;
			case "null":
			case "undefined":
				return null;
			case "Infinity":
				return Infinity;
			case "NaN":
				return NaN;
			default:
				throw this.error(`Unexpected identifier '${word}'`);
		}
	}
}

/** Parse JSON5 text; throws SyntaxError on invalid input. */
export function json5Parse(text: string): unknown {
	return new Parser(text).parse();
}
