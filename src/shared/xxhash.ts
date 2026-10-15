/**
 * XXH32 (seed 0) in pure JS, matching xxhash_rust::xxh32. Used for
 * hashline snapshot tags (low 16 bits, 4-digit uppercase hex) so tags are
 * byte-identical to OMP's `file_hash`.
 */

const P1 = 2654435761;
const P2 = 2246822519;
const P3 = 3266489917;
const P4 = 668265263;
const P5 = 374761393;

function rotl(x: number, r: number): number {
	return ((x << r) | (x >>> (32 - r))) >>> 0;
}

function addU32(...values: number[]): number {
	let sum = 0;
	for (const v of values) sum = (sum + v) >>> 0;
	return sum;
}

function mulU32(a: number, b: number): number {
	return Math.imul(a, b) >>> 0;
}

function round(acc: number, input: number): number {
	let h = addU32(acc, mulU32(input, P2));
	h = rotl(h, 13);
	return mulU32(h, P1);
}

function readU32LE(data: Uint8Array, offset: number): number {
	return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

export function xxh32(input: Uint8Array, seed = 0): number {
	const n = input.length;
	let i = 0;
	let h: number;

	if (n >= 16) {
		let v1 = addU32(seed, P1, P2);
		let v2 = addU32(seed, P2);
		let v3 = seed >>> 0;
		let v4 = (seed - P1) >>> 0;
		while (i <= n - 16) {
			v1 = round(v1, readU32LE(input, i));
			v2 = round(v2, readU32LE(input, i + 4));
			v3 = round(v3, readU32LE(input, i + 8));
			v4 = round(v4, readU32LE(input, i + 12));
			i += 16;
		}
		h = addU32(rotl(v1, 1), rotl(v2, 7), rotl(v3, 12), rotl(v4, 18));
	} else {
		h = addU32(seed, P5);
	}

	h = addU32(h, n);

	while (i <= n - 4) {
		h = addU32(h, mulU32(readU32LE(input, i), P3));
		h = mulU32(rotl(h, 17), P4);
		i += 4;
	}
	while (i < n) {
		h = addU32(h, mulU32(input[i], P5));
		h = mulU32(rotl(h, 11), P1);
		i += 1;
	}

	h ^= h >>> 15;
	h = mulU32(h, P2);
	h ^= h >>> 13;
	h = mulU32(h, P3);
	h ^= h >>> 16;
	return h >>> 0;
}
