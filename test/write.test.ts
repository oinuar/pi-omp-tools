/**
 * Tests for the OMP-aligned `write` tool (src/tools/write.ts):
 * plain files, hashline prefix stripping, read-misfire/truncation guards,
 * archive whole-rewrite semantics, and SQLite row writes (messages aligned to
 * OMP). Zip tests auto-shim a python3-based `zip`/`unzip` when the real CLI is
 * missing; they skip if neither is available.
 */
import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { executeWrite } from "../src/tools/write.ts";
import { unzipMember, zipCliAvailable } from "./zip-shim.ts";

const pexec = promisify(execFile);
/** Extract the text part of a tool result (the write tool emits text only). */
const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");

/** Typed view of the write tool's result details. */
const detailsOf = (result: { details?: Record<string, unknown> }): { tag?: string; existed?: boolean } =>
	(result.details ?? {}) as { tag?: string; existed?: boolean };

async function makeCwd(): Promise<{ dir: string; ctx: { cwd: string } }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-write-test-"));
	return { dir, ctx: { cwd: dir } };
}

const unzipP = (dir: string, archive: string, member: string) => unzipMember(path.join(dir, archive), member);

const tarExtract = (dir: string, archive: string, member: string) =>
	pexec("tar", ["-xOf", path.join(dir, archive), member]).then(r => r.stdout);

const zstExtract = async (dir: string, archive: string, member: string): Promise<string> => {
	const inner = path.join(dir, "zst-inner-" + Math.random().toString(36).slice(2) + ".tar");
	await fs.writeFile(inner, zlib.zstdDecompressSync(await fs.readFile(path.join(dir, archive))));
	return pexec("tar", ["-xOf", inner, member]).then(r => r.stdout);
};

/** Skip the zip tests when neither the zip CLI nor a python3 shim is available. */
const ensureZipCli = zipCliAvailable;

// ── plain files ─────────────────────────────────────────────────────────────

test("write: creates a file with [path#TAG] header and byte count", async () => {
	const { dir, ctx } = await makeCwd();
	const result = await executeWrite("sub/hello.ts", "export const x = 1;\n", ctx);
	assert.match(textOf(result), /^\[sub\/hello\.ts#[0-9A-F]{4}\]\nSuccessfully wrote 20 bytes to sub\/hello\.ts$/);
	assert.match(detailsOf(result).tag!, /^[0-9A-F]{4}$/);
	assert.strictEqual(detailsOf(result).existed, false);
	assert.strictEqual(await fs.readFile(path.join(dir, "sub/hello.ts"), "utf8"), "export const x = 1;\n");
});

test("write: overwrites an existing file and reports the new tag", async () => {
	const { dir, ctx } = await makeCwd();
	await fs.writeFile(path.join(dir, "file.txt"), "old\n");
	const result = await executeWrite("file.txt", "new\n", ctx);
	assert.strictEqual(detailsOf(result).existed, true);
	assert.match(textOf(result), /Successfully wrote 4 bytes to file\.txt/);
});

test("write: shebang content becomes executable and reports the notice", async () => {
	const { dir, ctx } = await makeCwd();
	const result = await executeWrite("run.sh", "#!/usr/bin/env bash\necho hi\n", ctx);
	assert.match(textOf(result), /Successfully wrote \d+ bytes to run\.sh\n\[Notice: Made executable via chmod \+x\]$/);
	const stat = await fs.stat(path.join(dir, "run.sh"));
	assert.strictEqual((stat.mode & 0o111) === 0o111, true);
});

test("write: strips copied [path#TAG] header + N: prefixes and notes it", async () => {
	const { dir, ctx } = await makeCwd();
	const result = await executeWrite("stripped.txt", "[stripped.txt#AAAA]\n1:line one\n2:line two", ctx);
	assert.strictEqual(await fs.readFile(path.join(dir, "stripped.txt"), "utf8"), "line one\nline two");
	assert.match(textOf(result), /Note: auto-stripped hashline display prefixes from content before writing\./);
});

test("write: loose header fallback (malformed first line) is stripped", async () => {
	const { dir, ctx } = await makeCwd();
	await executeWrite("loose.txt", "[loose.txt#]\n1:first\n2:second", ctx);
	assert.strictEqual(await fs.readFile(path.join(dir, "loose.txt"), "utf8"), "first\nsecond");
});

test("write: unwraps a copied [path#TAG] path wrapper", async () => {
	const { dir, ctx } = await makeCwd();
	await executeWrite("wrapper.txt", "v1\n", ctx);
	const result = await executeWrite("[wrapper.txt#DEAD]", "v2\n", ctx);
	assert.strictEqual(await fs.readFile(path.join(dir, "wrapper.txt"), "utf8"), "v2\n");
	assert.match(textOf(result), /^\[wrapper\.txt#[0-9A-F]{4}\]/);
});

test("write: unprefixed content is written verbatim (no re-join)", async () => {
	const { dir, ctx } = await makeCwd();
	await executeWrite("plain.txt", "a\nb\n\n  spaced", ctx);
	assert.strictEqual(await fs.readFile(path.join(dir, "plain.txt"), "utf8"), "a\nb\n\n  spaced");
});

// ── guards ──────────────────────────────────────────────────────────────────

test("write: rejects URI-like targets", async () => {
	const { ctx } = await makeCwd();
	await assert.rejects(() => executeWrite("agent:///x/y", "data", ctx), /Unknown URI-like write target 'agent:\/\/\/x\/y'/);
});

test("write: rejects empty write ending in a read selector", async () => {
	const { ctx } = await makeCwd();
	await assert.rejects(() => executeWrite("missing.txt:1-260", "", ctx), /read-tool selector ':1-260'/);
});

test("write: rejects semicolon-joined selector lists", async () => {
	const { ctx } = await makeCwd();
	await assert.rejects(() => executeWrite("a.ts:1-5; b.ts:raw", "", ctx), /semicolon-joined list of 2/);
});

test("write: non-empty content is never blocked by the selector guard", async () => {
	const { dir, ctx } = await makeCwd();
	await executeWrite("literal.txt:2", "ok\n", ctx);
	assert.strictEqual(await fs.readFile(path.join(dir, "literal.txt:2"), "utf8"), "ok\n");
});

test("write: rejects truncated read projections", async () => {
	const { dir, ctx } = await makeCwd();
	const big = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
	await fs.writeFile(path.join(dir, "big.txt"), big);
	const notice = "[Showing lines 1-3 of 100. Use :4 to continue]";
	// A notice marks the content a projection: a projection covering fewer
	// bytes than the current source is incomplete and is rejected.
	await assert.rejects(
		() => executeWrite("big.txt", "line1\nline2\nline3\n\n" + notice, ctx),
		/Refusing to overwrite 'big\.txt' with an incomplete read projection/,
	);
	// The same for prefixed (copied) projections: after stripping, the payload
	// is still shorter than the current source.
	await assert.rejects(
		() => executeWrite("big.txt", "[big.txt#1111]\n1:line1\n2:line2\n3:line3\n" + notice, ctx),
		/incomplete read projection/,
	);
});

test("write: a notice inside otherwise-complete content is written literally", async () => {
	// OMP parity (documentation.txt test): the payload is not shorter than the
	// current source, so the notice is treated as literal content.
	const { dir, ctx } = await makeCwd();
	const content = "Example read output:\n[Showing lines 1-20 of 60. Use :21 to continue]\n";
	await fs.writeFile(path.join(dir, "documentation.txt"), "old\n");
	const result = await executeWrite("documentation.txt", content, ctx);
	assert.match(textOf(result), /Successfully wrote \d+ bytes to documentation\.txt/);
	assert.strictEqual(await fs.readFile(path.join(dir, "documentation.txt"), "utf8"), content);
});

// ── archives ────────────────────────────────────────────────────────────────

test("write: zip entries (new container, replace, preserve others)", async t => {
	if (!(await ensureZipCli())) {
		t.skip("no zip CLI (or python3) available");
		return;
	}
	const { dir, ctx } = await makeCwd();
	const result = await executeWrite("bundle.zip:payload/new.txt", "hello zip", ctx);
	assert.strictEqual(textOf(result), "Successfully wrote 9 bytes to bundle.zip:payload/new.txt");
	assert.strictEqual(await unzipP(dir, "bundle.zip", "payload/new.txt"), "hello zip");
	await executeWrite("bundle.zip:other.bin", "second", ctx);
	const replaced = await executeWrite("bundle.zip:payload/new.txt", "replaced", ctx);
	assert.strictEqual(textOf(replaced), "Successfully wrote 8 bytes to bundle.zip:payload/new.txt");
	assert.strictEqual(await unzipP(dir, "bundle.zip", "payload/new.txt"), "replaced");
	assert.strictEqual(await unzipP(dir, "bundle.zip", "other.bin"), "second");
});

test("write: zip guards (selector misfire, '..', read-only formats)", async t => {
	if (!(await ensureZipCli())) {
		t.skip("no zip CLI (or python3) available");
		return;
	}
	const { dir, ctx } = await makeCwd();
	await executeWrite("bundle.zip:m.txt", "x", ctx);
	await assert.rejects(() => executeWrite("bundle.zip:1-260", "", ctx), /read-tool selector ':1-260'/);
	await assert.rejects(() => executeWrite("bundle.zip:../evil.txt", "x", ctx), /Archive path cannot contain '\.\.'/);
	await assert.rejects(() => executeWrite("archive.7z:member.txt", "x", ctx), /read-only format/);
	await assert.rejects(() => executeWrite("archive.rar:member.txt", "x", ctx), /read-only format/);
});

test("write: tar entries (new container, replace, preserve others)", async () => {
	const { dir, ctx } = await makeCwd();
	const result = await executeWrite("data.tar:files/a.txt", "alpha", ctx);
	assert.strictEqual(textOf(result), "Successfully wrote 5 bytes to data.tar:files/a.txt");
	assert.strictEqual(await tarExtract(dir, "data.tar", "files/a.txt"), "alpha");
	await executeWrite("data.tar:files/b.txt", "beta", ctx);
	await executeWrite("data.tar:files/a.txt", "ALPHA-v2", ctx);
	assert.strictEqual(await tarExtract(dir, "data.tar", "files/a.txt"), "ALPHA-v2");
	assert.strictEqual(await tarExtract(dir, "data.tar", "files/b.txt"), "beta");
});

test("write: tar.gz entries (replace preserves siblings)", async () => {
	const { dir, ctx } = await makeCwd();
	await executeWrite("gz.tgz:inner/c.txt", "gamma", ctx);
	await executeWrite("gz.tgz:inner/d.txt", "delta", ctx);
	await executeWrite("gz.tgz:inner/c.txt", "GAMMA-v2", ctx);
	assert.strictEqual(await tarExtract(dir, "gz.tgz", "inner/c.txt"), "GAMMA-v2");
	assert.strictEqual(await tarExtract(dir, "gz.tgz", "inner/d.txt"), "delta");
});

test("write: tar.zst entries (replace preserves siblings)", async () => {
	const { dir, ctx } = await makeCwd();
	await executeWrite("z.tar.zst:z.txt", "zeta", ctx);
	await executeWrite("z.tar.zst:k.txt", "keep", ctx);
	await executeWrite("z.tar.zst:z.txt", "ZETA-v2", ctx);
	assert.strictEqual(await zstExtract(dir, "z.tar.zst", "z.txt"), "ZETA-v2");
	assert.strictEqual(await zstExtract(dir, "z.tar.zst", "k.txt"), "keep");
});

test("write: tar read-only variants are rejected", async () => {
	const { ctx } = await makeCwd();
	await assert.rejects(() => executeWrite("bz.tar.bz2:m", "x", ctx), /read-only format/);
	await assert.rejects(() => executeWrite("xz.tar.xz:m", "x", ctx), /read-only format/);
});

test("write: tar guards (selector misfire, truncated member projection)", async () => {
	const { dir, ctx } = await makeCwd();
	await executeWrite("data.tar:m.txt", "x", ctx);
	await assert.rejects(() => executeWrite("data.tar:1-260", "", ctx), /read-tool selector ':1-260'/);
	const bigdir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-write-big-"));
	await fs.writeFile(
		path.join(bigdir, "bigfile.txt"),
		Array.from({ length: 50 }, (_, i) => "L" + (i + 1)).join("\n") + "\n",
	);
	await pexec("tar", ["-cf", path.join(dir, "big.tar"), "-C", bigdir, "bigfile.txt"]);
	const notice = "[Showing lines 1-2 of 50. Use :3 to continue]";
	await assert.rejects(
		() => executeWrite("big.tar:bigfile.txt", "L1\nL2\n\n" + notice, ctx),
		/Refusing to overwrite 'big\.tar:bigfile\.txt' with an incomplete read projection/,
	);
});

// ── SQLite ──────────────────────────────────────────────────────────────────

function makeDb(dir: string): string {
	const dbPath = path.join(dir, "data.sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active BOOLEAN, score REAL)");
	db.exec("CREATE TABLE pk (k TEXT PRIMARY KEY, v TEXT)");
	db.exec("CREATE TABLE comp (a INTEGER, b INTEGER, v TEXT, PRIMARY KEY (a, b))");
	db.exec("CREATE TABLE norowid (x INTEGER PRIMARY KEY, y TEXT) WITHOUT ROWID");
	db.close();
	return dbPath;
}

function allRows(dbPath: string, table: string): Record<string, unknown>[] {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
	db.close();
	return rows;
}

test("write: sqlite insert via JSON5 (unquoted keys, single quotes, trailing comma)", async () => {
	const { dir, ctx } = await makeCwd();
	const dbPath = makeDb(dir);
	const result = await executeWrite("data.sqlite:users", "{name: 'Ada', active: true, score: 4.5,}", ctx);
	assert.strictEqual(textOf(result), "Inserted row into users");
	const rows = allRows(dbPath, "users");
	assert.strictEqual(rows.length, 1);
	assert.strictEqual(rows[0]?.name, "Ada");
	assert.strictEqual(rows[0]?.active, 1); // boolean stored as 1
	assert.strictEqual(rows[0]?.score, 4.5);
});

test("write: sqlite empty object inserts DEFAULT VALUES", async () => {
	const { dir, ctx } = await makeCwd();
	const dbPath = makeDb(dir);
	const result = await executeWrite("data.sqlite:users", "{}", ctx);
	assert.strictEqual(textOf(result), "Inserted row into users");
	assert.strictEqual(allRows(dbPath, "users").length, 1);
});

test("write: sqlite update via integer primary key", async () => {
	const { dir, ctx } = await makeCwd();
	const dbPath = makeDb(dir);
	await executeWrite("data.sqlite:users", "{name: 'Ada'}", ctx);
	const result = await executeWrite("data.sqlite:users:1", '{name: "Bob"}', ctx);
	assert.strictEqual(textOf(result), "Updated row '1' in users");
	assert.strictEqual(allRows(dbPath, "users")[0]?.name, "Bob");
});

test("write: sqlite update via text primary key", async () => {
	const { dir, ctx } = await makeCwd();
	const dbPath = makeDb(dir);
	await executeWrite("data.sqlite:pk", '{k: "k1", v: "v1"}', ctx);
	const result = await executeWrite("data.sqlite:pk:k1", '{v: "v2"}', ctx);
	assert.strictEqual(textOf(result), "Updated row 'k1' in pk");
	assert.strictEqual(allRows(dbPath, "pk")[0]?.v, "v2");
});

test("write: sqlite WITHOUT ROWID single-PK table updates via the PK", async () => {
	// OMP parity: getPrimaryKeyColumns does not special-case WITHOUT ROWID;
	// the rowid fallback (and its error) only applies to PK-less tables.
	const { dir, ctx } = await makeCwd();
	const dbPath = makeDb(dir);
	await executeWrite("data.sqlite:norowid", '{x: 7, y: "seven"}', ctx);
	const result = await executeWrite("data.sqlite:norowid:7", '{y: "S"}', ctx);
	assert.strictEqual(textOf(result), "Updated row '7' in norowid");
	assert.strictEqual(allRows(dbPath, "norowid")[0]?.y, "S");
});

test("write: sqlite no-row / deleted messages", async () => {
	const { dir, ctx } = await makeCwd();
	const dbPath = makeDb(dir);
	const missing = await executeWrite("data.sqlite:users:999", '{name: "X"}', ctx);
	assert.strictEqual(textOf(missing), "No row updated in users for key '999'");
	const missingDelete = await executeWrite("data.sqlite:users:999", "", ctx);
	assert.strictEqual(textOf(missingDelete), "No row deleted from users for key '999'");
	await executeWrite("data.sqlite:users", "{name: 'X'}", ctx);
	const deleted = await executeWrite("data.sqlite:users:1", "", ctx);
	assert.strictEqual(textOf(deleted), "Deleted row '1' from users");
	assert.strictEqual(allRows(dbPath, "users").length, 0);
});

test("write: sqlite error messages (OMP parity)", async () => {
	const { dir, ctx } = await makeCwd();
	makeDb(dir);
	await assert.rejects(() => executeWrite("data.sqlite:missing", "{}", ctx), /SQLite table 'missing' not found/);
	await assert.rejects(() => executeWrite("data.sqlite?limit=5:users", "{}", ctx), /do not support query parameters/);
	await assert.rejects(() => executeWrite("data.sqlite:users:", "{}", ctx), /non-empty row key/);
	await assert.rejects(() => executeWrite("data.sqlite:users", "[1, 2]", ctx), /must be a JSON object/);
	await assert.rejects(() => executeWrite("data.sqlite:users", "'str'", ctx), /must be a JSON object/);
	await assert.rejects(() => executeWrite("data.sqlite:users", "{nope: 1}", ctx), /has no column named 'nope'/);
	await assert.rejects(() => executeWrite("data.sqlite:users", '{name: {nested: 1}}', ctx), /only accepts JSON scalar values/);
	await assert.rejects(() => executeWrite("data.sqlite:comp:1", '{v: "x"}', ctx), /composite primary key/);
	await assert.rejects(() => executeWrite("data.sqlite:users:abc", '{name: "X"}', ctx), /Primary key 'abc' must be an integer/);
	await assert.rejects(() => executeWrite("data.sqlite:users", "{bad json", ctx), /valid JSON5/);
	await assert.rejects(() => executeWrite("data.sqlite:users", "", ctx), /SQLite deletes require a row key/);
	await assert.rejects(() => executeWrite("data.sqlite:users:1", "{}", ctx), /updates require at least one column value/);
	await assert.rejects(() => executeWrite("nosuch.sqlite:users", "{}", ctx), /SQLite database 'nosuch.sqlite:users' not found/);
});

test("write: existing non-SQLite .db file falls back to a plain file write", async () => {
	const { dir, ctx } = await makeCwd();
	await fs.writeFile(path.join(dir, "notes.db"), "just text");
	const result = await executeWrite("notes.db:users", "plain file content", ctx);
	assert.match(textOf(result), /Successfully wrote \d+ bytes to notes\.db:users/);
	assert.strictEqual(await fs.readFile(path.join(dir, "notes.db:users"), "utf8"), "plain file content");
});
