/**
 * Smoke tests for the pi-omp-tools extension (read, write, edit, search,
 * find), run with `node --test`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	executeEdit,
	executeFind,
	executeRead,
	executeSearch,
	executeWrite,
	registerAll,
} from "../index.ts";
import piOmpToolsExtension from "../index.ts";
import { buildZip, unzipMember, zipCliAvailable } from "./zip-shim.ts";
import { resetBinaryCache } from "../src/shared/util.ts";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-test-"));
}

function tagOf(output: string): string {
	const match = /#([0-9A-F]{4})\]/.exec(output);
	assert.ok(match, `expected a #TAG in output:\n${output}`);
	return match[1] as string;
}

test("read: numbered lines with hashline tag", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "hello.txt");
	await fs.writeFile(file, "alpha\nbeta\ngamma\n");
	const result = await executeRead(file, { cwd: dir });
	const output = text(result);
	assert.match(output, /\[hello\.txt#[0-9A-F]{4}\]/);
	assert.match(output, /1:alpha/);
	assert.match(output, /3:gamma/);
});

test("read: OMP-aligned selector semantics", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "nums.txt");
	await fs.writeFile(file, Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n"));

	// `:10-12` — OMP shows the range plus bracket context (1 before, 3 after)
	// and a continuation footer naming the exact next offset.
	const ranged = text(await executeRead(`${file}:10-12`, { cwd: dir }));
	assert.match(ranged, /9:line-9/);
	assert.match(ranged, /12:line-12/);
	assert.match(ranged, /15:line-15/);
	assert.match(ranged, /\[Showing lines 9-15 of 50\. Use :16 to continue\]/);

	// `:45` — a bare number is "from line 45 ONWARD" (OMP), not a single line.
	const fromEnd = text(await executeRead(`${file}:45`, { cwd: dir }));
	assert.match(fromEnd, /44:line-44/); // leading context
	assert.match(fromEnd, /50:line-50/);
	assert.ok(!fromEnd.includes("to continue"), "reaches EOF, no footer");

	// `:-60` — tail selector (last 60 lines); file is only 50, so all of it.
	const tail = text(await executeRead(`${file}:-60`, { cwd: dir }));
	assert.match(tail, /1:line-1/);
	assert.match(tail, /50:line-50/);

	// Multi-range — exact lines, no context, blocks joined by `…`.
	const multi = text(await executeRead(`${file}:2-3,40-41`, { cwd: dir }));
	assert.match(multi, /2:line-2/);
	assert.match(multi, /…/);
	assert.match(multi, /40:line-40/);
	assert.ok(!multi.includes("4:line-4"), "no context between/around multi ranges");

	// `:raw` — verbatim, no line numbers, no header, no footer under 300 lines.
	const raw = text(await executeRead(`${file}:raw`, { cwd: dir }));
	assert.ok(raw.includes("line-1\nline-2"));
	assert.ok(!raw.includes("1:line-1"));
	assert.ok(!raw.includes("to continue"));
});

test("read: default window is 300 lines (OMP read.defaultLimit)", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "big.txt");
	await fs.writeFile(file, Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}`).join("\n"));
	const output = text(await executeRead(file, { cwd: dir }));
	assert.match(output, /1:Line 1/);
	assert.match(output, /300:Line 300/);
	assert.ok(!output.includes("301:Line 301"));
	assert.match(output, /\[Showing lines 1-300 of 1000\. Use :301 to continue\]/);

	// Continuation read resumes where the footer pointed (plus 1 leading context line, OMP-style).
	const page2 = text(await executeRead(`${file}:301`, { cwd: dir }));
	assert.match(page2, /300:Line 300/);
	assert.match(page2, /600:Line 600/);
	assert.match(page2, /\[Showing lines 300-600 of 1000\. Use :601 to continue\]/);
});

test("read: explicit range is capped at 3000 lines (OMP DEFAULT_MAX_LINES)", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "huge.txt");
	await fs.writeFile(file, Array.from({ length: 5000 }, (_, i) => `L${i + 1}`).join("\n"));
	const output = text(await executeRead(`${file}:1-5000`, { cwd: dir }));
	assert.match(output, /3000:L3000/);
	assert.ok(!output.includes("3001:L3001"));
	assert.match(output, /\[Showing lines 1-3000 of 5000\. Use :3001 to continue\]/);
});

test("read: out-of-range is a graceful result, not an error", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "small.txt");
	await fs.writeFile(file, "one\ntwo\n");
	// Single range past EOF → OMP's one-liner with recovery hints.
	const out = text(await executeRead(`${file}:100`, { cwd: dir }));
	assert.match(out, /Line 100 is beyond end of file \(2 lines total\)\. Use :1 to read from the start, or :2 to read the last line\./);
	// Multi-range with an out-of-bounds span → inline notice, in-range spans still shown.
	const multi = text(await executeRead(`${file}:1-1,50-60`, { cwd: dir }));
	assert.match(multi, /1:one/);
	assert.match(multi, /\[Range 50-60 is beyond end of file \(2 lines total\); skipped\]/);
});

test("read: invalid selectors throw OMP's exact messages", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "s.txt");
	await fs.writeFile(file, "a\nb\nc\n");
	await assert.rejects(executeRead(`${file}:0`, { cwd: dir }), /Line selector 0 is invalid; lines are 1-indexed\. Use :1\./);
	await assert.rejects(executeRead(`${file}:5-3`, { cwd: dir }), /Invalid range 5-3: end must be >= start\./);
	await assert.rejects(executeRead(`${file}:5+0`, { cwd: dir }), /Invalid range 5\+0: count must be >= 1\./);
	await assert.rejects(executeRead(`${file}:-0`, { cwd: dir }), /Tail selector -0 is invalid; use :-N with N >= 1/);
	await assert.rejects(executeRead(`${file}:banana`, { cwd: dir }), /Invalid selector ':banana'\. Use :N, :N-M, :N\+K, :N- \(open-ended\), :-N \(last N lines\)/);
});

test("read: OMP range aliases (L-prefix, ..) and comma-list bare numbers", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "alias.txt");
	await fs.writeFile(file, Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n"));
	// `:L5..7` — L prefix + `..` alias == `:5-7`.
	const aliased = text(await executeRead(`${file}:L5..7`, { cwd: dir }));
	assert.match(aliased, /5:l5/);
	assert.match(aliased, /7:l7/);
	// `:5,7` — bare numbers inside a comma list are individual lines (not ranges).
	const singles = text(await executeRead(`${file}:5,7`, { cwd: dir }));
	assert.match(singles, /5:l5/);
	assert.match(singles, /7:l7/);
	assert.ok(!singles.includes("6:l6"), "bare N in a list is that one line only");
	// Overlapping/adjacent ranges merge: `:4-6,5-8` == `:4-8`.
	const merged = text(await executeRead(`${file}:4-6,5-8`, { cwd: dir }));
	assert.match(merged, /4:l4/);
	assert.match(merged, /8:l8/);
	assert.ok(!merged.includes("…"), "merged range is one contiguous block");
});

test("read: directory listing", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "sub"));
	await fs.writeFile(path.join(dir, "a.txt"), "hi");
	const result = await executeRead(dir, { cwd: dir });
	const output = text(result);
	assert.match(output, /sub\//);
	assert.match(output, /a\.txt/);
	// Structured entries for the tree renderer, alongside the flat text body.
	const details = result.details as { kind?: string; total?: number; entries?: Array<Record<string, unknown>> };
	assert.equal(details.kind, "dir");
	assert.equal(details.total, 2);
	assert.deepEqual(
		details.entries?.map(entry => entry.name),
		["sub", "a.txt"],
	);
	assert.equal(details.entries?.[0]?.dir, true);
	assert.equal(details.entries?.[0]?.count, 0);
	assert.equal(typeof details.entries?.[1]?.size, "string");
});

test("read: directory paging via :N-M and :N (OMP)", async () => {
	const dir = await makeTempDir();
	for (let i = 0; i < 30; i++) await fs.writeFile(path.join(dir, `f${String(i).padStart(2, "0")}.txt`), "x");
	// `:1-3` — the header line plus two entries.
	const paged = text(await executeRead(`${dir}:1-3`, { cwd: dir }));
	assert.match(paged, /entries/);
	assert.match(paged, /\[28 more lines in listing\. Use :4 to continue\]/);
	// `:-2` — last two listing lines.
	const tail = text(await executeRead(`${dir}:-2`, { cwd: dir }));
	assert.match(tail, /f29\.txt/);
	assert.ok(!tail.includes("more lines in listing"), "reached end of listing");
	// Out-of-range → OMP's graceful listing message.
	const beyond = text(await executeRead(`${dir}:999`, { cwd: dir }));
	assert.match(beyond, /Line 999 is beyond end of listing \(31 lines total\)\./);
	// Multi-range on a directory listing is rejected.
	await assert.rejects(executeRead(`${dir}:1-2,5-6`, { cwd: dir }), /Multi-range line selectors are not supported for directory listings\./);
});

test("write then edit: hashline replace, insert, cut", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "greet.py");
	const written = text(await executeWrite(file, 'def greet(name):\n    msg = "Hello, " + name\n    print(msg)\ngreet("world")\n', { cwd: dir }));
	const tag = tagOf(written);

	const edited = text(
		await executeEdit(
			`[greet.py#${tag}]\nPUT 2.=3:\n+    print(f"Hi, {name}")\nPUT >4:\n+print("done")`,
			{ cwd: dir },
		),
	);
	assert.match(edited, /\[greet\.py#[0-9A-Fa-f]{4}\]/);
	const content = await fs.readFile(file, "utf8");
	assert.equal(content, 'def greet(name):\n    print(f"Hi, {name}")\ngreet("world")\nprint("done")\n');
	// Response carries the new tag + fresh numbers for chaining.
	const newTag = tagOf(edited);
	const cutResult = text(await executeEdit(`[greet.py#${newTag}]\nCUT 4.=4`, { cwd: dir }));
	assert.match(cutResult, /\[greet\.py#[0-9A-Fa-f]{4}\]/);
	assert.equal(await fs.readFile(file, "utf8"), 'def greet(name):\n    print(f"Hi, {name}")\ngreet("world")\n');
});

test("edit: block op via tree-sitter, registers move code across files", async () => {
	const dir = await makeTempDir();
	const src = path.join(dir, "util.ts");
	await fs.writeFile(src, "export function keep(): number {\n\treturn 1;\n}\nexport function move(): number {\n\treturn 2;\n}\n");
	await fs.writeFile(path.join(dir, "other.ts"), "// target\n");
	const readOut = text(await executeRead(src, { cwd: dir }));
	const tag = tagOf(readOut);
	const otherOut = text(await executeRead(path.join(dir, "other.ts"), { cwd: dir }));
	const otherTag = tagOf(otherOut);

	const patch = `[util.ts#${tag}]\nCUT 4* @fn\n[other.ts#${otherTag}]\nPUT >1 @fn`;
	const result = text(await executeEdit(patch, { cwd: dir }));
	assert.match(result, /CUT 4\* → resolved lines 4-6 \(3 lines\)/);
	assert.equal(await fs.readFile(src, "utf8"), "export function keep(): number {\n\treturn 1;\n}\n");
	assert.equal(await fs.readFile(path.join(dir, "other.ts"), "utf8"), "// target\nexport function move(): number {\n\treturn 2;\n}\n");
});

test("edit: markdown heading block replace", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "doc.md");
	await fs.writeFile(file, "# Title\n\n## One\nbody one\n\n## Two\nbody two\n");
	const tag = tagOf(text(await executeRead(file, { cwd: dir })));
	await executeEdit(`[doc.md#${tag}]\nPUT 3*:\n+## One\n+new body`, { cwd: dir });
	const content = await fs.readFile(file, "utf8");
	assert.match(content, /## One\nnew body\n## Two/);
});

test("edit: stale-anchor recovery after unrelated change", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "list.txt");
	await fs.writeFile(file, "one\ntwo\nthree\nfour\nfive\n");
	const tag = tagOf(text(await executeRead(file, { cwd: dir })));
	// External change ABOVE the anchor: prepend a line (shifts everything down).
	await fs.writeFile(file, "zero\none\ntwo\nthree\nfour\nfive\n");
	const result = text(await executeEdit(`[list.txt#${tag}]\nPUT 4.=4:\n+FOUR`, { cwd: dir }));
	assert.match(result, /Recovered by remapping stale line anchors/);
	assert.equal(await fs.readFile(file, "utf8"), "zero\none\ntwo\nthree\nFOUR\nfive\n");
});

test("edit: unknown tag is rejected with current tag hint", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "x.txt");
	await fs.writeFile(file, "a\nb\n");
	await assert.rejects(
		executeEdit("[x.txt#0000]\nPUT 1.=1:\n+z", { cwd: dir }),
		/hash #0000 is not from this session/,
	);
});

test("edit: overlap and colonless PUT are rejected; bodyless PUT auto-cuts; noop is diagnosed", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "y.txt");
	await fs.writeFile(file, "a\nb\nc\n");
	const tag = tagOf(text(await executeRead(file, { cwd: dir })));
	await assert.rejects(
		executeEdit(`[y.txt#${tag}]\nPUT 1.=2:\n+x\nCUT 2.=3`, { cwd: dir }),
		/already targeted by another hunk/,
	);
	await assert.rejects(executeEdit(`[y.txt#${tag}]\nPUT 1`, { cwd: dir }), /Colonless `PUT` is clipboard-backed/);
	// OMP: a bodyless PUT with a colon is an auto-cut with a warning, not an error.
	const autoCut = text(await executeEdit(`[y.txt#${tag}]\nPUT 2.=2:`, { cwd: dir }));
	assert.match(autoCut, /Interpreted an empty `PUT` body as deletion/);
	assert.equal(await fs.readFile(file, "utf8"), "a\nc\n");
	// Noop: body byte-identical to the targeted line.
	const freshTag = tagOf(text(await executeRead(file, { cwd: dir })));
	const noop = text(await executeEdit(`[y.txt#${freshTag}]\nPUT 1.=1:\n+a`, { cwd: dir }));
	assert.match(noop, /produced no change/);
});

test("edit: REM deletes and MV renames", async () => {
	const dir = await makeTempDir();
	const a = path.join(dir, "a.txt");
	await fs.writeFile(a, "hello\n");
	const tag = tagOf(text(await executeRead(a, { cwd: dir })));
	await executeEdit(`[a.txt#${tag}]\nPUT 1.=1:\n+hey\nMV b.txt`, { cwd: dir });
	assert.equal(await fs.readFile(path.join(dir, "b.txt"), "utf8"), "hey\n");
	const bTag = tagOf(text(await executeRead(path.join(dir, "b.txt"), { cwd: dir })));
	const removed = text(await executeEdit(`[b.txt#${bTag}]\nREM`, { cwd: dir }));
	assert.match(removed, /Deleted b\.txt/);
	await assert.rejects(fs.access(path.join(dir, "b.txt")));
});

test("edit: unseen line anchors are rejected with a reveal (OMP guard)", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "long.txt");
	await fs.writeFile(file, "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
	const out = text(await executeRead(`${file}:1-2`, { cwd: dir }));
	const tag = tagOf(out);
	// OMP bracket context: a :1-2 read of a 10-line file shows lines 1-5 only.
	await assert.rejects(
		executeEdit(`[long.txt#${tag}]\nPUT 8.=8:\n+EIGHT`, { cwd: dir }),
		/never displayed/,
	);
	// The rejection is atomic: the file is untouched.
	assert.equal(await fs.readFile(file, "utf8"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
});

test("edit: ranged re-read unlocks the elided range", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "long.txt");
	await fs.writeFile(file, "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
	const tag = tagOf(text(await executeRead(`${file}:1-2`, { cwd: dir })));
	await assert.rejects(
		executeEdit(`[long.txt#${tag}]\nPUT 8.=8:\n+EIGHT`, { cwd: dir }),
		/never displayed/,
	);
	const freshTag = tagOf(text(await executeRead(`${file}:7-8`, { cwd: dir })));
	const result = text(await executeEdit(`[long.txt#${freshTag}]\nPUT 8.=8:\n+EIGHT`, { cwd: dir }));
	assert.match(result, /\[long\.txt#[0-9A-Fa-f]{4}\]/);
	assert.equal(await fs.readFile(file, "utf8"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nEIGHT\nl9\nl10\n");
});

test("edit: stale tag with unmatchable content gives the structured mismatch", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "m.txt");
	await fs.writeFile(file, "alpha\nbeta\ngamma\n");
	const tag = tagOf(text(await executeRead(file, { cwd: dir })));
	await fs.writeFile(file, "delta\nbeta\ngamma\n"); // external change, no remappable anchors
	await assert.rejects(
		executeEdit(`[m.txt#${tag}]\nPUT 1.=1:\n+ALPHA`, { cwd: dir }),
		/but the current file hashes to #[0-9A-Fa-f]{4}\./,
	);
	assert.equal(await fs.readFile(file, "utf8"), "delta\nbeta\ngamma\n");
});

test("search: OMP grouped output with tags and match markers", async () => {
	const dir = await makeTempDir();
	await fs.writeFile(path.join(dir, "one.ts"), "const needleX = 1;\n");
	await fs.writeFile(path.join(dir, "two.ts"), "// no match here\nlet needleX = 2;\n");
	const output = text(await executeSearch({ pattern: "needleX" }, { cwd: dir }));
	assert.match(output, /# one\.ts#[0-9A-F]{4}/);
	assert.match(output, /# two\.ts#[0-9A-F]{4}/);
	assert.match(output, /\*1:const needleX = 1;/);
	assert.match(output, /\*2:let needleX = 2;/);
	assert.match(output, / 1:\/\/ no match here/); // context line (1 before)
	assert.ok(!output.includes("matches in")); // no summary line (OMP)
});

test("search: single-file flat header (no tree)", async () => {
	const dir = await makeTempDir();
	await fs.writeFile(path.join(dir, "one.ts"), "const flatX = 1;\n");
	const output = text(await executeSearch({ pattern: "flatX", path: "one.ts" }, { cwd: dir }));
	assert.match(output, /\[one\.ts#[0-9A-F]{4}\]/);
	assert.match(output, /\*1:const flatX = 1;/);
	assert.ok(!output.includes("# "));
});

test("search: case-sensitive default; case:false insens", async () => {
	const dir = await makeTempDir();
	await fs.writeFile(path.join(dir, "c.txt"), "Alpha beta\n");
	const sensitive = text(await executeSearch({ pattern: "alpha" }, { cwd: dir }));
	assert.match(sensitive, /No matches found/);
	const insens = await executeSearch({ pattern: "alpha", case: false }, { cwd: dir });
	assert.match(text(insens), /\*1:Alpha beta/);
	assert.equal(insens.details?.caseSensitive, false);
	const defaultDet = await executeSearch({ pattern: "Alpha" }, { cwd: dir });
	assert.equal(defaultDet.details?.caseSensitive, true);
});

test("search: skip paginates files (20 per page) and past-end message", async () => {
	const dir = await makeTempDir();
	for (let i = 1; i <= 21; i++) {
		await fs.writeFile(path.join(dir, `f${String(i).padStart(2, "0")}.txt`), `PAGE${i}\n`);
	}
	const first = await executeSearch({ pattern: "PAGE" }, { cwd: dir });
	assert.match(text(first), /Showing files 1-20 of 21\. Use skip=20 for the next page, or narrow paths\/pattern\./);
	assert.equal(first.details?.fileCount, 20);
	// the hidden file depends on encounter order (parallel walk, like OMP) —
	// assert the pagination mechanics, not which file lands where
	const allNames = Array.from({ length: 21 }, (_, i) => `f${String(i + 1).padStart(2, "0")}.txt`);
	const shown = ((first.details?.files ?? []) as any[]).map(f => f.path);
	assert.ok(shown.length === 20 && shown.every(p => allNames.includes(p)));
	const second = await executeSearch({ pattern: "PAGE", skip: 20 }, { cwd: dir });
	assert.equal(second.details?.fileCount, 1);
	assert.ok(allNames.includes((second.details?.files as any[])[0]?.path));
	assert.ok(!text(second).includes("Showing files"));
	const pastEnd = text(await executeSearch({ pattern: "PAGE", skip: 999 }, { cwd: dir }));
	assert.match(pastEnd, /No more results \(21 files total; skip=999 is past the end\)/);
});

test("search: line-range selectors filter and error like OMP", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await fs.writeFile(path.join(dir, "list.txt"), "a\nb NEEDLE\nc\nd\n");

	// exact single line (:2-2), context trimmed to the range
	const exact = await executeSearch({ pattern: "NEEDLE", path: "list.txt:2-2" }, { cwd: dir });
	assert.match(text(exact), /\[list\.txt#[0-9A-F]{4}\]/);
	assert.match(text(exact), /\*2:b NEEDLE/);
	assert.ok(!text(exact).includes(" 1:a"));

	// :2 is "from line 2" (open-ended) for a lone bare number
	const open = text(await executeSearch({ pattern: "a|c", path: "list.txt:2" }, { cwd: dir }));
	assert.match(open, /\*3:c/);
	assert.ok(!open.includes("*1:a"));

	// OMP error messages
	await assert.rejects(executeSearch({ pattern: "x", path: "list.txt:0" }, { cwd: dir }), /Line selector 0 is invalid/);
	await assert.rejects(executeSearch({ pattern: "x", path: "list.txt:5-2" }, { cwd: dir }), /Invalid range 5-2: end must be >= start/);
	await assert.rejects(executeSearch({ pattern: "x", path: "missing:1-2" }, { cwd: dir }), /Path not found for line-range selector: missing:1-2/);
	await assert.rejects(executeSearch({ pattern: "x", path: "src:1-2" }, { cwd: dir }), /Line-range selector requires a single file: src:1-2 is a directory/);
	await assert.rejects(executeSearch({ pattern: "x", path: "*.ts:1-2" }, { cwd: dir }), /Line-range selector requires a single file, not a glob: \*\.ts:1-2/);
});

test("search: multiline via literal \\n in pattern", async () => {
	const dir = await makeTempDir();
	await fs.writeFile(path.join(dir, "m.txt"), "foo\nbar\nbaz\n");
	const out = text(await executeSearch({ pattern: "foo\\nbar" }, { cwd: dir }));
	assert.match(out, /\*1:foo/);
});

test("search: glob anchoring (bare any-depth; slashed direct-children only)", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "dir", "sub"), { recursive: true });
	await fs.writeFile(path.join(dir, "dir", "a.ts"), "GLOBTEST\n");
	await fs.writeFile(path.join(dir, "dir", "sub", "b.ts"), "GLOBTEST\n");
	const children = await executeSearch({ pattern: "GLOBTEST", path: "dir/*.ts" }, { cwd: dir });
	const childrenText = text(children);
	assert.match(childrenText, /a\.ts/);
	assert.ok(!childrenText.includes("b.ts"));
	assert.equal(children.details?.fileCount, 1);
	const anyDepth = await executeSearch({ pattern: "GLOBTEST", path: "dir/**/*.ts" }, { cwd: dir });
	assert.equal(anyDepth.details?.fileCount, 2);
});

test("search: per-file cap 20 (multi-scope) trims silently", async () => {
	const dir = await makeTempDir();
	await fs.writeFile(path.join(dir, "hot.txt"), Array.from({ length: 25 }, (_, i) => `N${i}`).join("\n") + "\n");
	await fs.writeFile(path.join(dir, "cold.txt"), "N99\n");
	const result = await executeSearch({ pattern: "^N" }, { cwd: dir });
	assert.match(text(result), /hot\.txt/);
	assert.ok(!text(result).includes("more matches")); // silent cap in model text
	const hot = ((result.details?.files as Array<{ path?: string; rows?: unknown[]; more?: number }> | undefined) ?? []).find(f => f.path === "hot.txt");
	const hotMatches = ((hot?.rows ?? []) as any[]).filter((r: any) => r.isMatch).length;
	assert.equal(hotMatches, 20);
	assert.ok((hot?.more ?? 0) >= 1, `more should report at least one trimmed match, got ${hot?.more}`);
	assert.equal(result.details?.matchCount, 21);
});

test("search: 4MiB window (explicit target note, no tag over cap)", async () => {
	const dir = await makeTempDir();
	const big = path.join(dir, "big.txt");
	await fs.writeFile(big, `NEEDLE\n${"x".repeat(4 * 1024 * 1024)}\n`);
	const result = await executeSearch({ pattern: "NEEDLE", path: "big.txt" }, { cwd: dir });
	const out = text(result);
	assert.match(out, /\*1:NEEDLE/);
	assert.match(out, /Searched only the first 4MB of large files/);
	assert.ok(!/[Bb]ig\.txt#[0-9A-F]{4}/.test(out)); // no tag over the cap
});

test("search: input validation (empty pattern, negative skip, invalid regex)", async () => {
	const dir = await makeTempDir();
	await fs.writeFile(path.join(dir, "v.txt"), "x\n");
	await assert.rejects(executeSearch({ pattern: "" }, { cwd: dir }), /Pattern must not be empty/);
	await assert.rejects(executeSearch({ pattern: "x", skip: -1 }, { cwd: dir }), /Skip must be a non-negative number/);
	await assert.rejects(executeSearch({ pattern: "(unclosed" }, { cwd: dir }), /Invalid regex/);
});

test("find: glob lookup (OMP grouped tree)", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await fs.writeFile(path.join(dir, "src", "a.ts"), "");
	await fs.writeFile(path.join(dir, "src", "b.js"), "");
	const result = await executeFind({ path: "src/**/*.ts", gitignore: false }, { cwd: dir });
	const output = text(result);
	assert.match(output, /# src/);
	assert.match(output, /a\.ts/);
	assert.ok(!output.includes("b.js"));
	assert.deepEqual((result.details as { files?: string[] })?.files, ["src/a.ts"]);
	assert.equal((result.details as { fileCount?: number })?.fileCount, 1);
});

test("sqlite: read tables, rows, and write rows", async () => {
	const dir = await makeTempDir();
	const db = path.join(dir, "data.sqlite");
	const { DatabaseSync } = await import("node:sqlite");
	const handle = new DatabaseSync(db);
	handle.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES ('ada'), ('bob');");
	handle.close();

	const tables = text(await executeRead(db, { cwd: dir }));
	assert.match(tables, /users \(table, 2 rows\)/);
	const rows = text(await executeRead(`${db}:users`, { cwd: dir }));
	assert.match(rows, /"name":"ada"/);
	const byKey = text(await executeRead(`${db}:users:2`, { cwd: dir }));
	assert.match(byKey, /"name":"bob"/);

	const inserted = text(await executeWrite(`${db}:users`, '{"name":"eve"}', { cwd: dir }));
	assert.match(inserted, /^Inserted row into users$/);
	const updated = text(await executeWrite(`${db}:users:3`, '{"name":"EVE"}', { cwd: dir }));
	assert.match(updated, /^Updated row '3' in users$/);
	const deleted = text(await executeWrite(`${db}:users:3`, "", { cwd: dir }));
	assert.match(deleted, /^Deleted row '3' from users$/);
});

test("archives: zip list, member read, member write", async t => {
	if (!(await zipCliAvailable())) {
		t.skip("no zip CLI (or python3) available");
		return;
	}
	const dir = await makeTempDir();
	// Build the fixture hermetically (python3 zipfile); the tool's read/write
	// still drive the standard `unzip`/`zip` CLIs.
	await buildZip(path.join(dir, "bundle.zip"), { "payload/inner.txt": "zipped content\nline two\n" });

	const listing = text(await executeRead(path.join(dir, "bundle.zip"), { cwd: dir }));
	assert.match(listing, /payload\/inner\.txt/);
	const member = text(await executeRead(path.join(dir, "bundle.zip") + ":payload/inner.txt", { cwd: dir }));
	assert.match(member, /1:zipped content/);
	const writeResult = text(await executeWrite(path.join(dir, "bundle.zip") + ":payload/new.txt", "fresh\n", { cwd: dir }));
	assert.match(writeResult, /Successfully wrote 6 bytes to bundle\.zip:payload\/new\.txt/);
	const reread = text(await executeRead(path.join(dir, "bundle.zip") + ":payload/new.txt", { cwd: dir }));
	assert.match(reread, /1:fresh/);
	// Sibling member preserved by the whole-archive rewrite.
	assert.strictEqual(await unzipMember(path.join(dir, "bundle.zip"), "payload/inner.txt"), "zipped content\nline two\n");
});

test("notebook rendering", async () => {
	const dir = await makeTempDir();
	const nb = {
		cells: [
			{ cell_type: "markdown", source: ["# Heading\n"], outputs: [] },
			{ cell_type: "code", source: ["print(1)\n"], outputs: [{ output_type: "stream", text: ["1\n"] }] },
		],
	};
	await fs.writeFile(path.join(dir, "nb.ipynb"), JSON.stringify(nb));
	const output = text(await executeRead(path.join(dir, "nb.ipynb"), { cwd: dir }));
	assert.match(output, /cell 1 \[markdown\]/);
	assert.match(output, /print\(1\)/);
	assert.match(output, /output: 1/);
});

test("registration: all five tools register with prompt integration", async () => {
	const tools: Array<{ name: string; promptGuidelines?: string[] }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const fakePi = {
		registerTool: (def: { name: string }) => tools.push(def as never),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	await registerAll(fakePi as never);
	const names = tools.map(tool => tool.name).sort();
	assert.deepEqual(names, ["edit", "find", "read", "search", "write"]);
	assert.ok(tools.every(tool => (tool.promptGuidelines?.length ?? 0) > 0));

	const beforeAgentStart = handlers.get("before_agent_start");
	assert.ok(beforeAgentStart && beforeAgentStart.length > 0, "before_agent_start handler registered");
	const outcome = (await beforeAgentStart[0]?.({ systemPrompt: "BASE PROMPT" }, {})) as { systemPrompt: string };
	assert.match(outcome.systemPrompt, /^BASE PROMPT/);
	assert.match(outcome.systemPrompt, /## OMP Tools/);
	assert.match(outcome.systemPrompt, /Anchor loop/);

	// The merged extension entry registers all five tools (contract already wired).
	const moreTools: Array<{ name: string }> = [];
	await piOmpToolsExtension({ registerTool: (def: { name: string }) => moreTools.push(def as never), on: () => {} } as never);
	assert.deepEqual(moreTools.map(tool => tool.name).sort(), ["edit", "find", "read", "search", "write"]);
});

test("read: url selector parsing stays local-safe (missing file error)", async () => {
	const dir = await makeTempDir();
	await assert.rejects(executeRead(path.join(dir, "nope.txt"), { cwd: dir }), /Not found/);
});

test("register.ts source contains no control characters (0x08 regression)", async () => {
	const source = await fs.readFile(new URL("../src/register.ts", import.meta.url), "utf8");
	for (let i = 0; i < source.length; i++) {
		const codePoint = source.charCodeAt(i);
		assert.ok(codePoint >= 0x20 || codePoint === 0x0a || codePoint === 0x09, `control char ${codePoint} at index ${i}`);
	}
});

test("edit details carry builtin-format diff for daemon replay rendering", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "replay.txt");
	await fs.writeFile(file, "one\ntwo\nthree\n");
	const tag = tagOf(text(await executeRead(file, { cwd: dir })));
	const result = await executeEdit(`[replay.txt#${tag}]\nPUT 2.=2:\n+TWO`, { cwd: dir });
	const details = result.details as { diff?: string; firstChangedLine?: number; sections?: unknown[] };
	assert.ok(typeof details.diff === "string" && details.diff.length > 0, "details.diff present");
	assert.match(details.diff as string, /^-\s*2 two$/m);
	assert.match(details.diff as string, /^\+\s*2 TWO$/m);
	assert.equal(details.firstChangedLine, 2);
	assert.ok(Array.isArray(details.sections));
});

test("edit registration carries replayBuiltInToolName and display path arg", async () => {
	const { registerEdit } = await import("../src/register.ts");
	const defs: Array<Record<string, unknown>> = [];
	await registerEdit({ registerTool: (def: Record<string, unknown>) => defs.push(def), on: () => {} } as never);
	const def = defs[0] as { replayBuiltInToolName?: string; prepareArguments?: (a: unknown) => unknown };
	assert.equal(def.replayBuiltInToolName, "edit");
	const prepared = def.prepareArguments?.({ input: "[src/a.ts#AAAA]\nPUT 1.=1:\n+x" }) as { path?: string };
	assert.equal(prepared?.path, "src/a.ts");
});

test("renderers: OMP Tools-style boxes, gutters, and tree bodies", async () => {
	const { editRenderers, searchRenderers, readRenderers } = await import("../src/render.ts");
	class FakeText {
		text: string;
		constructor(text: string) {
			this.text = text;
		}
	}
	const R = {
		Text: FakeText as never,
		Container: FakeText as never,
	} as never;
	const theme = {
		fg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => `<${text}>`,
	};
	const renderLines = (component: unknown): string => {
		const boxLike = component as { render?: (width: number) => string[]; text?: string };
		return boxLike.render ? boxLike.render(80).join("\n") : (boxLike.text ?? "");
	};

	const edit = editRenderers(R);
	const editComponent = edit.renderResult(
		{
			details: {
				sections: [
					{ path: "old.ts", op: "delete" },
					{ path: "a.ts", tag: "AAAA", op: "update", diff: "-1 old\n+1 new", warnings: ["careful"], blockResolutions: [] },
				],
			},
		},
		{ expanded: false },
		theme,
		{},
	) as { render: (width: number) => string[] };
	const editLines = editComponent.render(80);
	const editOut = editLines.join("\n");
	assert.match(editOut, /╭─── ✎ Edit: 🟦 a\.ts#AAAA ⟦\+1\/-1⟧/);
	assert.match(editOut, / {2}-1│<old>/);
	assert.match(editOut, /! careful/);
	assert.equal(editLines[0], "");
	assert.match(editLines[1] as string, /✘ Delete: old\.ts/);
	assert.match(editLines[2] as string, /^╭/);
	assert.match(editLines.at(-1) as string, /^╰/);
	assert.match(editOut, /╰─+╯/);

	const search = searchRenderers(R);
	const searchOut = renderLines(
		search.renderResult(
			{
				details: {
					pattern: "needle",
					files: [{ path: "b.ts", tag: "BBBB", rows: [{ n: 3, text: "a needle here", isMatch: true }], more: 0 }],
					summary: "1 matches in 1 files",
				},
			},
			{ expanded: false },
			theme,
			{},
		),
	);
	assert.match(searchOut, /⌕ Search: needle 1 match · 1 file/);
	assert.match(searchOut, /└─ b\.ts#BBBB/);
	assert.match(searchOut, /\*3│a <needle> here/);

	const read = readRenderers(R);
	const readOut = renderLines(
		read.renderResult(
			{ details: { kind: "text", path: "c.ts", tag: "CCCC", rows: [{ n: 1, text: "const x = 1;" }] } },
			{ expanded: false },
			theme,
			{},
		),
	);
	assert.match(readOut, /╭─── 🟦 • Read: c\.ts#CCCC · 1 line /);
	assert.match(readOut, / 1 const x = 1;/);
	assert.match(readOut, /╰─+╯/);
});

test("BUG1 regression: absolute and ~ globs work in find/search", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await fs.mkdir(path.join(dir, "docs"), { recursive: true });
	await fs.writeFile(path.join(dir, "app.py"), "print(1)\n");
	await fs.writeFile(path.join(dir, "src", "a.ts"), "const needleZ = 1;\n");
	await fs.writeFile(path.join(dir, "docs", "d.md"), "# needleZ doc\n");

	// find: absolute glob, from an UNRELATED cwd
	const otherCwd = await makeTempDir();
	const absFind = text(await executeFind({ path: `${dir}/*.py`, gitignore: false }, { cwd: otherCwd }));
	assert.match(absFind, /app\.py/);
	const absDeep = text(await executeFind({ path: `${dir}/**/*.ts`, gitignore: false }, { cwd: otherCwd }));
	assert.match(absDeep, /a\.ts/);
	const absDocs = text(await executeFind({ path: `${dir}/docs/*.md`, gitignore: false }, { cwd: otherCwd }));
	assert.match(absDocs, /d\.md/);

	// search: absolute glob from unrelated cwd
	const absSearch = text(await executeSearch({ pattern: "needleZ", path: `${dir}/*.ts; ${dir}/**/*.ts` }, { cwd: otherCwd }));
	assert.match(absSearch, /a\.ts/);

	// glob with a missing base dir is a hard `Path not found` error (OMP: a
	// single missing path errors loudly)
	await assert.rejects(executeFind({ path: `${dir}/nonexistent/*.py` }, { cwd: otherCwd }), /Path not found/);
});

test("find/search: missing targets (OMP semantics)", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await fs.writeFile(path.join(dir, "src", "a.ts"), "const needleQ = 1;\n");

	// one missing target in a multi-target list: find continues and names it
	const findOut = text(
		await executeFind({ path: `${dir}/nonexistent/**; ${dir}/src/**/*.ts`, gitignore: false }, { cwd: dir }),
	);
	assert.match(findOut, /a\.ts/);
	assert.match(findOut, /Skipped missing paths: /);
	const searchOut = text(
		await executeSearch({ pattern: "needleQ", path: `${dir}/nonexistent/**; ${dir}/src/**/*.ts` }, { cwd: dir }),
	);
	assert.match(searchOut, /a\.ts/);
	assert.match(searchOut, /Skipped missing paths: /);

	// every target missing → Path not found error (both tools)
	await assert.rejects(
		executeFind({ path: `${dir}/nope/**; ${dir}/also-nope/**` }, { cwd: dir }),
		/Path not found/,
	);
	await assert.rejects(
		executeSearch({ pattern: "needleQ", path: `${dir}/nope/**; ${dir}/also-nope/**` }, { cwd: dir }),
		/Path not found/,
	);

	// plain (non-glob) missing paths error loudly
	await assert.rejects(executeFind({ path: `${dir}/also-nope` }, { cwd: dir }), /Path not found/);
	await assert.rejects(
		executeSearch({ pattern: "needleQ", path: `${dir}/also-nope` }, { cwd: dir }),
		/Path not found/,
	);
});

test("find: OMP glob semantics (bare recursive, scoped single-level, inputs)", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "src", "sub"), { recursive: true });
	await fs.writeFile(path.join(dir, "src", "a.ts"), "");
	await fs.writeFile(path.join(dir, "src", "sub", "nested.ts"), "");
	await fs.writeFile(path.join(dir, "top.ts"), "");

	// Bare top-level glob is recursive: `*.ts` matches at any depth.
	const bareOut = text(await executeFind({ path: "*.ts", gitignore: false }, { cwd: dir }));
	assert.match(bareOut, /a\.ts/);
	assert.match(bareOut, /nested\.ts/);
	assert.match(bareOut, /top\.ts/);

	// Scoped glob is single-level: `src/*.ts` never matches `src/sub/nested.ts`.
	const scoped = text(await executeFind({ path: "src/*.ts", gitignore: false }, { cwd: dir }));
	assert.match(scoped, /a\.ts/);
	assert.ok(!scoped.includes("nested.ts"), scoped);

	// Directories appear as `#` headers with a trailing slash; files bare.
	const dirList = text(await executeFind({ path: "src", gitignore: false }, { cwd: dir }));
	assert.match(dirList, /# src\/\n/);
	assert.match(dirList, /sub\/\n/);
	assert.match(dirList, /a\.ts/);

	// An exact file input returns exactly that file.
	const single = await executeFind({ path: "src/a.ts", gitignore: false }, { cwd: dir });
	assert.deepEqual((single.details as { files?: string[] })?.files, ["src/a.ts"]);

	// A non-directory target without a glob is rejected.
	await assert.rejects(executeFind({ path: "src/a.ts/*.ts", gitignore: false }, { cwd: dir }), /Path not found|not a directory/);

	// A slash-only path means the session cwd (OMP rootPathAlias, as used by
	// OMP's pi shim); `//` normalizes the same way.
	const alias = text(await executeFind({ path: "/", gitignore: false }, { cwd: dir }));
	assert.match(alias, /top\.ts/);
	assert.match(alias, /nested\.ts/);
	const alias2 = text(await executeFind({ path: "//" }, { cwd: dir }));
	assert.match(alias2, /top\.ts/);

	// An explicit empty path is rejected.
	await assert.rejects(executeFind({ path: "" }, { cwd: dir }), /non-empty/);
});

test("find: limit clamp and reached notices (OMP)", async () => {
	const dir = await makeTempDir();
	for (let i = 0; i < 230; i++) await fs.writeFile(path.join(dir, `file-${String(i).padStart(3, "0")}.txt`), "");

	// Requesting above the hard cap: clamp notice, no doomed advice.
	const clamped = text(await executeFind({ path: "*", gitignore: false, limit: 1000 }, { cwd: dir }));
	assert.match(clamped, /Requested limit 1000 clamped to the max of 200/);
	assert.match(clamped, /\[200 results limit reached\]/);
	assert.ok(!clamped.includes("Use limit="), clamped);

	// Default limit sitting on the cap: reached notice without advice.
	const def = text(await executeFind({ path: "*", gitignore: false }, { cwd: dir }));
	assert.ok(!def.includes("clamped"), def);
	assert.match(def, /\[200 results limit reached\]/);

	// Below the cap: doubled suggestion capped at the hard limit.
	const half = text(await executeFind({ path: "*", gitignore: false, limit: 50 }, { cwd: dir }));
	assert.match(half, /\[50 results limit reached\. Use limit=100 for more\]/);

	// Non-positive limits are rejected.
	await assert.rejects(executeFind({ path: "*", limit: 0 }, { cwd: dir }), /positive number/);
	await assert.rejects(executeFind({ path: "*", limit: -3 }, { cwd: dir }), /positive number/);
});

test("find: gitignore honored by default (OMP)", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "ignored"), { recursive: true });
	await fs.writeFile(path.join(dir, "keep.txt"), "");
	await fs.writeFile(path.join(dir, "ignored", "skip.txt"), "");
	await fs.writeFile(path.join(dir, ".gitignore"), "ignored/\n");

	const on = text(await executeFind({ path: "*" }, { cwd: dir }));
	assert.ok(!on.includes("skip.txt"), on);
	assert.match(on, /keep\.txt/);

	const off = text(await executeFind({ path: "*", gitignore: false }, { cwd: dir }));
	assert.match(off, /skip\.txt/);
});

test("find: results include directories and symlinks (OMP walker parity)", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "src", "deep"), { recursive: true });
	await fs.mkdir(path.join(dir, ".git"), { recursive: true });
	await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
	await fs.writeFile(path.join(dir, "keep.txt"), "");
	await fs.writeFile(path.join(dir, "src", "mid.txt"), "");
	await fs.writeFile(path.join(dir, "src", "deep", "leaf.txt"), "");
	await fs.writeFile(path.join(dir, ".git", "config"), "");
	await fs.writeFile(path.join(dir, "node_modules", "pkg", "n.js"), "");
	await fs.symlink(path.join(dir, "keep.txt"), path.join(dir, "filelink"));
	await fs.symlink(path.join(dir, "src"), path.join(dir, "dirlink"));
	await fs.symlink("/nonexistent-target", path.join(dir, "brokenlink"));

	// The OMP native walker emits files + directories + symlinks: directories
	// get a trailing slash, symlinks render bare, and are never followed.
	const out = text(await executeFind({ path: "." }, { cwd: dir }));
	assert.match(out, /keep\.txt/);
	assert.match(out, /# src\/\n/, "directories end with a slash");
	assert.match(out, /## deep\/\n/, "nested directories are listed");
	assert.match(out, /leaf\.txt/);
	assert.match(out, /(^|\n)filelink(\n|$)/, "file symlinks are listed bare");
	assert.match(out, /(^|\n)dirlink(\n|$)/, "directory symlinks are listed, not followed");
	assert.match(out, /(^|\n)brokenlink(\n|$)/, "broken symlinks are listed");
	assert.ok(!out.includes(".git"), out);
	assert.ok(!out.includes("node_modules"), out);
});

test("find: gitignored directories are pruned, nested gitignore applies (OMP)", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "ignored", "inner"), { recursive: true });
	await fs.mkdir(path.join(dir, "src", "cache"), { recursive: true });
	await fs.writeFile(path.join(dir, "keep.txt"), "");
	await fs.writeFile(path.join(dir, "ignored", "skip.txt"), "");
	await fs.writeFile(path.join(dir, "src", "app.ts"), "");
	await fs.writeFile(path.join(dir, "src", "cache", "stale.bin"), "");
	await fs.writeFile(path.join(dir, ".gitignore"), "ignored/\n");
	await fs.writeFile(path.join(dir, "src", ".gitignore"), "cache/\n");

	// An ignored directory node is pruned wholesale (not just its files), and
	// a nested .gitignore prunes its own subtree the same way.
	const out = text(await executeFind({ path: "." }, { cwd: dir }));
	assert.ok(!out.includes("ignored"), out);
	assert.ok(!out.includes("skip.txt"), out);
	assert.ok(!out.includes("cache"), out);
	assert.ok(!out.includes("stale.bin"), out);
	assert.match(out, /keep\.txt/);
	assert.match(out, /app\.ts/);

	const off = text(await executeFind({ path: ".", gitignore: false }, { cwd: dir }));
	assert.match(off, /ignored\//);
	assert.match(off, /cache\//);
});

test("find: hidden=false excludes dot entries (OMP)", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, ".hsecret"), { recursive: true });
	await fs.writeFile(path.join(dir, ".dotfile"), "");
	await fs.writeFile(path.join(dir, ".hsecret", "s.txt"), "");
	await fs.writeFile(path.join(dir, "visible.txt"), "");
	await fs.symlink(path.join(dir, "visible.txt"), path.join(dir, "link"));

	const hidden = text(await executeFind({ path: ".", hidden: true }, { cwd: dir }));
	assert.match(hidden, /\.dotfile/);
	assert.match(hidden, /\.hsecret\//);
	assert.match(hidden, /(^|\n)link(\n|$)/);

	const visible = text(await executeFind({ path: ".", hidden: false }, { cwd: dir }));
	assert.ok(!visible.includes(".dotfile"), visible);
	assert.ok(!visible.includes(".hsecret"), visible);
	assert.match(visible, /visible\.txt/);
	assert.match(visible, /(^|\n)link(\n|$)/, "non-hidden symlinks stay");
});

test("find: scoped pattern is depth-bounded for directories (OMP walk_depth_bound)", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "src", "sub", "inner"), { recursive: true });
	await fs.writeFile(path.join(dir, "src", "a.ts"), "");
	await fs.writeFile(path.join(dir, "src", "sub", "nested.ts"), "");
	await fs.writeFile(path.join(dir, "src", "sub", "inner", "leaf.ts"), "");

	// `src/*` covers direct children only: the sub/ directory appears but its
	// descendants never do (the walker bounds the walk to the pattern's
	// segment count, like OMP).
	const out = text(await executeFind({ path: "src/*", gitignore: false }, { cwd: dir }));
	assert.match(out, /a\.ts/);
	assert.match(out, /## sub\/(\n|$)/, "the scoped directory itself is listed");
	assert.ok(!out.includes("nested.ts"), out);
	assert.ok(!out.includes("inner"), out);
});

/**
 * Put a hanging fake `rg` first on PATH (prints `lines`, then sleeps until
 * killed) so the 5s scan timeout fires hermetically; restores PATH and the
 * binary cache afterwards. Skipped on win32 (the fake is a /bin/sh script).
 */
async function withFakeRg(
	lines: string[],
	fn: () => Promise<void>,
): Promise<void> {
	if (process.platform === "win32") throw new Error("unsupported");
	const originalPath = process.env.PATH;
	const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-fakebin-"));
	const script = `#!/bin/sh\n${lines.map(line => `printf '%s\\n' "${line}"`).join("\n")}\nexec sleep 30\n`;
	await fs.writeFile(path.join(binDir, "rg"), script, { mode: 0o755 });
	process.env.PATH = `${binDir}:${originalPath ?? ""}`;
	resetBinaryCache(); // force hasBinary to re-probe against the fake rg
	try {
		await fn();
	} finally {
		process.env.PATH = originalPath;
		resetBinaryCache();
	}
}

test("find: timeout salvages partial matches (OMP incomplete-scan notice)", async t => {
	if (process.platform === "win32") {
		t.skip("fake rg is a /bin/sh script");
		return;
	}
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "sub"), { recursive: true });
	await fs.writeFile(path.join(dir, "a.txt"), "");
	await fs.writeFile(path.join(dir, "sub", "b.txt"), "");

	// The fake rg prints two real paths and then hangs: the 5s deadline kills
	// it, the partial stdout is salvaged, and the result is an incomplete-scan
	// notice — never an error, never "No files found".
	await withFakeRg(["a.txt", "sub/b.txt"], async () => {
		const result = await executeFind({ path: "." }, { cwd: dir });
		const out = text(result);
		assert.match(out, /glob timed out after 5s; returning \d+ partial matches — results are incomplete/);
		assert.match(out, /a\.txt/);
		assert.match(out, /b\.txt/);
		assert.ok(!out.includes("No files found"), out);
		assert.equal((result.details as { truncated?: boolean })?.truncated, true);
	});
});

test("find: empty timeout says incomplete, not absent (OMP)", async t => {
	if (process.platform === "win32") {
		t.skip("fake rg is a /bin/sh script");
		return;
	}
	const dir = await makeTempDir();
	await withFakeRg([], async () => {
		const out = text(await executeFind({ path: "." }, { cwd: dir }));
		assert.match(out, /Glob timed out after 5s before finding any matches — the scan is incomplete, NOT proof of absence/);
		assert.ok(!out.includes("No files found"), out);
	});
});

test("find: multi-path merge, JSON list input, missing-entry note (OMP)", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await fs.mkdir(path.join(dir, "docs"), { recursive: true });
	await fs.writeFile(path.join(dir, "src", "a.ts"), "");
	await fs.writeFile(path.join(dir, "docs", "d.md"), "");

	const multi = text(await executeFind({ path: "src/*.ts; docs/*.md", gitignore: false }, { cwd: dir }));
	assert.match(multi, /a\.ts/);
	assert.match(multi, /d\.md/);

	// A JSON-encoded array string is accepted (OMP toPathList).
	const json = text(await executeFind({ path: JSON.stringify(["src/*.ts"]), gitignore: false }, { cwd: dir }));
	assert.match(json, /a\.ts/);

	// Missing entries in a multi-path call are skipped and named.
	const partial = text(await executeFind({ path: "nope-xyz/**; src/*.ts", gitignore: false }, { cwd: dir }));
	assert.match(partial, /a\.ts/);
	assert.match(partial, /Skipped missing paths: nope-xyz\/\*\*/);
});

test("BUG2 regression: URL selector parsing (bare domain, trailing slash, port)", async () => {
	const { parseUrlTarget } = await import("../src/tools/read.ts");
	// bare domain :raw
	const bare = parseUrlTarget("https://example.com:raw");
	assert.equal(bare.url, "https://example.com");
	assert.equal(bare.selector?.raw, true);
	// trailing slash :raw
	const slash = parseUrlTarget("https://example.com/:raw");
	assert.equal(slash.url, "https://example.com/");
	assert.equal(slash.selector?.raw, true);
	// port stays a port
	const port = parseUrlTarget("https://host:8080");
	assert.equal(port.url, "https://host:8080");
	assert.equal(port.selector, null);
	// port + trailing slash + bare number = "from line 50 onward" (OMP open-ended)
	const portRange = parseUrlTarget("https://host:8080/:50");
	assert.equal(portRange.url, "https://host:8080/");
	assert.deepEqual(portRange.selector?.ranges, [{ start: 50, end: Number.POSITIVE_INFINITY }]);
	// path + range
	const ranged = parseUrlTarget("https://x.com/docs/page:10-20");
	assert.equal(ranged.url, "https://x.com/docs/page");
	assert.deepEqual(ranged.selector?.ranges, [{ start: 10, end: 20 }]);
	// bare domain numeric — ambiguous, stays port-ish (documented)
	const ambiguous = parseUrlTarget("https://example.com:50");
	assert.equal(ambiguous.selector, null);
});

test("read-group tracker: stamping, breaks, and session scoping", async () => {
	// Re-wire the contract handlers onto this test's fakePi: an earlier test
	// already consumed the once-per-process guard.
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("omp-tools.contract.v1")];
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const tools: Array<{ name: string }> = [];
	const fakePi = {
		registerTool: (def: { name: string }) => tools.push(def),
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	const { registerRead } = await import("../src/register.ts");
	await registerRead(fakePi as never);
	const readTool = tools.find(tool => tool.name === "read") as
		| { execute: (id: string, params: object, s?: unknown, u?: unknown, ctx?: object) => Promise<{ details?: object }> }
		| undefined;
	assert.ok(readTool, "read tool registered");
	const emit = async (event: string, payload: unknown, ctx: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	const dir = await makeTempDir();
	const file = path.join(dir, "g.txt");
	await fs.writeFile(file, "hello\n");
	const readGroup = async (toolCallId: string) => {
		const result = await readTool.execute(toolCallId, { path: file }, undefined, undefined, { cwd: dir });
		return (result.details as { readGroup?: string }).readGroup;
	};

	// Consecutive reads share one stamped group id.
	await emit("tool_call", { toolName: "read", toolCallId: "rg-1" });
	await emit("tool_call", { toolName: "read", toolCallId: "rg-2" });
	const g1 = await readGroup("rg-1");
	assert.ok(typeof g1 === "string" && g1.length > 0, "group id stamped into details");
	assert.equal(await readGroup("rg-2"), g1);

	// A different tool call breaks the group.
	await emit("tool_call", { toolName: "bash", toolCallId: "b-1" });
	await emit("tool_call", { toolName: "read", toolCallId: "rg-3" });
	const g3 = await readGroup("rg-3");
	assert.notEqual(g3, g1);

	// toolResult and invisible bookkeeping messages don't break; prose does.
	await emit("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "output" }] } });
	await emit("message_end", { message: { role: "custom", content: "invisible bookkeeping" } });
	await emit("tool_call", { toolName: "read", toolCallId: "rg-4" });
	assert.equal(await readGroup("rg-4"), g3);
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Here is what I found." }] } });
	await emit("tool_call", { toolName: "read", toolCallId: "rg-5" });
	const g5 = await readGroup("rg-5");
	assert.notEqual(g5, g3);

	// Session-scoped: another session's tool calls neither break nor join.
	const ctxA = { sessionManager: { getSessionId: () => "session-A" } };
	const ctxB = { sessionManager: { getSessionId: () => "session-B" } };
	await emit("tool_call", { toolName: "read", toolCallId: "sa-1" }, ctxA);
	const a1 = await readGroup("sa-1");
	await emit("tool_call", { toolName: "bash", toolCallId: "sb-x" }, ctxB);
	await emit("tool_call", { toolName: "read", toolCallId: "sb-1" }, ctxB);
	const b1 = await readGroup("sb-1");
	await emit("tool_call", { toolName: "read", toolCallId: "sa-2" }, ctxA);
	assert.equal(await readGroup("sa-2"), a1, "other session's tool must not split this session's group");
	assert.notEqual(b1, a1, "concurrent sessions must never share a group id");

	// A new session in the same process starts a fresh group.
	await emit("session_start", {}, ctxA);
	await emit("tool_call", { toolName: "read", toolCallId: "sa-3" }, ctxA);
	assert.notEqual(await readGroup("sa-3"), a1);

	// A read without a toolCallId fences the group instead of being hopped over.
	await emit("tool_call", { toolName: "read", toolCallId: "f-1" });
	const f1 = await readGroup("f-1");
	await emit("tool_call", { toolName: "read" });
	await emit("tool_call", { toolName: "read", toolCallId: "f-2" });
	assert.notEqual(await readGroup("f-2"), f1);
});

test("renderers: reads collapse into one Read (N) widget without invalidate recursion", async () => {
	const { readRenderers } = await import("../src/render.ts");
	class FakeText {
		text: string;
		constructor(text: string) {
			this.text = text;
		}
		render(): string[] {
			return this.text.split("\n");
		}
	}
	const R = { Text: FakeText as never, Container: FakeText as never } as never;
	const theme = {
		fg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => text,
	};
	const read = readRenderers(R);
	const groupId = `test-render:${Date.now().toString(36)}`;
	const result1 = { content: [], details: { kind: "text", path: "a.ts", tag: "AAAA", rows: [{ n: 1, text: "x" }], readGroup: groupId } };
	const result2 = { content: [], details: { kind: "text", path: "b.ts", tag: "BBBB", rows: [{ n: 1, text: "y" }], readGroup: groupId } };

	// Host-faithful contexts: invalidate() synchronously re-runs renderResult
	// (pi/prime updateDisplay) — exactly what mutually recursed before the fix.
	let renders1 = 0;
	let renders2 = 0;
	let component1: { render: (w: number) => string[] } | undefined;
	let component2: { render: (w: number) => string[] } | undefined;
	const render1 = (): void => {
		renders1++;
		assert.ok(renders1 < 20, "unbounded re-render of member 1");
		component1 = read.renderResult(result1 as never, { expanded: false }, theme, ctx1 as never) as never;
	};
	const render2 = (): void => {
		renders2++;
		assert.ok(renders2 < 20, "unbounded re-render of member 2");
		component2 = read.renderResult(result2 as never, { expanded: false }, theme, ctx2 as never) as never;
	};
	const ctx1 = { toolCallId: "grw-1", state: {}, invalidate: render1 };
	const ctx2 = { toolCallId: "grw-2", state: {}, invalidate: render2 };

	render1();
	const soloOut = component1?.render(80).join("\n") ?? "";
	assert.match(soloOut, /Read: a\.ts#AAAA/); // single member renders solo

	render2(); // second member joins; must NOT synchronously recurse
	assert.equal(renders2, 1, "joining member must not re-render synchronously");
	await Promise.resolve(); // deferred cross-member invalidate runs as a microtask
	assert.ok(renders1 >= 2, "older member re-rendered once the group formed");
	assert.ok(renders1 < 5 && renders2 < 5, `re-renders stay bounded, got ${renders1}/${renders2}`);

	assert.deepEqual(component1?.render(80), [], "older slot collapses");
	const groupOut = component2?.render(80).join("\n") ?? "";
	assert.match(groupOut, /• Read \(2\)/);
	assert.match(groupOut, /a\.ts#AAAA · 1 line/);
	assert.match(groupOut, /b\.ts#BBBB · 1 line/);

	// A failed member (stamped id, as on replay) renders a failed row with the reason.
	const ctx3 = { toolCallId: "grw-3", state: {}, isError: true, args: { path: "/tmp/missing.txt" }, invalidate: () => {} };
	const result3 = { content: [{ type: "text", text: "Not found: /tmp/missing.txt" }], details: { readGroup: groupId } };
	const component3 = read.renderResult(result3 as never, { expanded: false }, theme, ctx3 as never) as {
		render: (w: number) => string[];
	};
	const errOut = component3.render(80).join("\n");
	assert.match(errOut, /• Read \(3\)/);
	assert.match(errOut, /missing\.txt · failed · Not found: \/tmp\/missing\.txt/);
});
