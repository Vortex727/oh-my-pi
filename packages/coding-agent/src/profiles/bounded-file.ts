import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";

export interface BoundedRegularTextFileMessages {
	invalid: string;
	notFound: string;
	failed: string;
	tooLarge: string;
}

type ReadFailureKind = keyof BoundedRegularTextFileMessages;

class BoundedReadFailure extends Error {
	constructor(readonly kind: ReadFailureKind) {
		super(kind);
	}
}

function sameIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameGeneration(left: Stats, right: Stats): boolean {
	return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertRegularIdentity(reference: Stats, candidate: Stats): void {
	if (!candidate.isFile() || candidate.isSymbolicLink() || !sameIdentity(reference, candidate)) {
		throw new BoundedReadFailure("invalid");
	}
}

/**
 * Read at most `maxBytes` from one verified regular-file handle.
 * The path and open descriptor must retain the same identity and generation for the whole read.
 */
export async function readBoundedRegularTextFile(
	filePath: string,
	maxBytes: number,
	messages: BoundedRegularTextFileMessages,
): Promise<string> {
	let before: Stats;
	try {
		before = await fs.lstat(filePath);
	} catch (error) {
		throw new Error(isEnoent(error) ? messages.notFound : messages.failed);
	}
	if (!before.isFile() || before.isSymbolicLink()) throw new Error(messages.invalid);
	if (before.size > maxBytes) throw new Error(messages.tooLarge);

	let handle: fs.FileHandle;
	try {
		handle = await fs.open(filePath, "r");
	} catch (error) {
		throw new Error(isEnoent(error) ? messages.notFound : messages.failed);
	}
	try {
		const opened = await handle.stat();
		assertRegularIdentity(before, opened);
		if (!sameGeneration(before, opened)) throw new BoundedReadFailure("invalid");
		if (opened.size > maxBytes) throw new BoundedReadFailure("tooLarge");

		const buffer = Buffer.allocUnsafe(Math.min(before.size, maxBytes) + 1);
		let length = 0;
		while (length < buffer.byteLength) {
			const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, null);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > maxBytes) throw new BoundedReadFailure("tooLarge");

		const afterHandle = await handle.stat();
		assertRegularIdentity(opened, afterHandle);
		if (!sameGeneration(opened, afterHandle)) throw new BoundedReadFailure("invalid");
		let afterPath: Stats;
		try {
			afterPath = await fs.lstat(filePath);
		} catch {
			throw new BoundedReadFailure("invalid");
		}
		assertRegularIdentity(opened, afterPath);
		if (!sameGeneration(opened, afterPath)) throw new BoundedReadFailure("invalid");
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
		} catch {
			throw new BoundedReadFailure("invalid");
		}
	} catch (error) {
		if (error instanceof BoundedReadFailure) throw new Error(messages[error.kind]);
		throw new Error(messages.failed);
	} finally {
		await handle.close().catch(() => {});
	}
}
