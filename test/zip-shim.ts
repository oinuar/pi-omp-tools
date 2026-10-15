/**
 * Shared test helper: ensure a usable `zip`/`unzip` on PATH. The write tool
 * spawns the standard CLIs; on machines without them (this one) a small
 * python3-based shim is installed in a temp dir and prepended to PATH.
 * `zipCliAvailable()` is false — and dependent tests skip — when neither the
 * real CLI nor python3 is available.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { resetBinaryCache } from "../src/shared/util.ts";

const pexec = promisify(execFile);

export const ZIP_SHIM_DIR = path.join("/tmp", "omp-tools-zipshim");

let ready: boolean | undefined;

/** Ensure a usable `zip`/`unzip` on PATH (real CLI or python3 shim). */
export async function zipCliAvailable(): Promise<boolean> {
	if (ready !== undefined) return ready;
	try {
		await pexec("which", ["zip"]);
		ready = true;
		return true;
	} catch {
		/* no zip CLI; try the python shim below */
	}
	try {
		await pexec("python3", ["--version"]);
	} catch {
		ready = false;
		return false;
	}
	await fs.mkdir(ZIP_SHIM_DIR, { recursive: true });
	await fs.writeFile(
		path.join(ZIP_SHIM_DIR, "zip"),
		[
			"#!/usr/bin/env python3",
			"import sys, os, zipfile",
			"args = [a for a in sys.argv[1:] if a not in ('-q', '-X')]",
			"archive, members = args[0], args[1:]",
			"data = {}",
			"if os.path.exists(archive):",
			"    with zipfile.ZipFile(archive) as z:",
			"        data = {n: z.read(n) for n in z.namelist()}",
			"for m in members:",
			"    p = os.path.abspath(m)",
			"    if not os.path.isfile(p):",
			"        print('zip error: cannot find ' + m, file=sys.stderr); sys.exit(11)",
			"    data[m] = open(p, 'rb').read()",
			"with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:",
			"    for name, b in data.items():",
			"        z.writestr(name, b)",
			"",
		].join("\n"),
	);
	await fs.writeFile(
		path.join(ZIP_SHIM_DIR, "unzip"),
		[
			"#!/usr/bin/env python3",
			"import sys, zipfile",
			"args = sys.argv[1:]",
			"if args and args[0] == '-p':",
			"    archive, member = args[1], args[2]",
			"    with zipfile.ZipFile(archive) as z:",
			"        if member in z.namelist():",
			"            sys.stdout.buffer.write(z.read(member)); sys.exit(0)",
			"    print('unzip: cannot find ' + member, file=sys.stderr); sys.exit(11)",
			"if args and args[0] == '-l':",
			"    archive = args[1]",
			"    with zipfile.ZipFile(archive) as z:",
			"        for i in z.infolist():",
			"            print(f'{i.file_size:>12}  {i.filename}')",
			"    sys.exit(0)",
			"sys.exit(0)",
			"",
		].join("\n"),
	);
	await fs.chmod(path.join(ZIP_SHIM_DIR, "zip"), 0o755);
	await fs.chmod(path.join(ZIP_SHIM_DIR, "unzip"), 0o755);
	process.env.PATH = `${ZIP_SHIM_DIR}${path.delimiter}${process.env.PATH}`;
	resetBinaryCache(); // the tools cache binary lookups; re-probe with the new PATH
	ready = true;
	return true;
}

/** Read a zip member with the shim's unzip (hermetic verification helper). */
export const unzipMember = (archive: string, member: string) =>
	pexec(path.join(ZIP_SHIM_DIR, "unzip"), ["-p", archive, member]).then(r => r.stdout);

/** Build a zip at `archive` containing `entries` (name → content), hermetically. */
export async function buildZip(archive: string, entries: Record<string, string>): Promise<void> {
	const lines = [
		"import sys, zipfile",
		"archive, data = sys.argv[1], eval(sys.argv[2])",
		"with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:",
		"    for name, b in data.items():",
		"        z.writestr(name, b)",
	];
	await pexec("python3", ["-c", lines.join("\n"), archive, JSON.stringify(entries)]);
}
