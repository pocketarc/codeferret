/**
 * Read one file out of a zip archive held in memory.
 *
 * GitHub hands an artifact over as a zip, and bun has no reader for one. `unzip` would do
 * this in a line, but the binary is not on every runner and is rarely inside a container
 * carrying only a repository's own toolchain, which is what `command-prefix` points at. A
 * missing binary there would look exactly like a pull request with no previous run, which
 * is the one failure this whole path is not allowed to have.
 *
 * A zip is read from its end: the record below carries the offset of the central
 * directory, and the central directory carries the offset of each file. Reading forward
 * from the start instead means trusting the local headers, whose sizes a streaming writer
 * is allowed to leave at zero.
 */

import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;

/** The archive comment, which sits after the record and can be this long. */
const MAX_COMMENT = 0xffff;

/** Written in a size or an offset field by a zip64 archive, which keeps the real value elsewhere. */
const ZIP64 = 0xffffffff;

/**
 * What one entry may come to once it is decompressed.
 *
 * The compressed size bounds nothing on its own: deflate reaches past 1000:1, so an
 * archive small enough to download holds an entry that inflates to tens of gigabytes and
 * takes the runner with it. This whole path is built to fail soft, and an out-of-memory
 * kill is the one failure that does not. The only file read out of an artifact here is a
 * findings file, and the largest run so far wrote well under a megabyte.
 */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

/**
 * The bytes of the first entry whose name `wanted` accepts, or null when there is none.
 *
 * Throws when the archive itself cannot be read, so that a malformed download is
 * distinguishable from an artifact that does not hold the file.
 */
export function readFromZip(
    zip: Uint8Array,
    wanted: (name: string) => boolean,
    limit = MAX_ENTRY_BYTES,
): Uint8Array | null {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const names = new TextDecoder();

    let record = -1;

    for (let i = zip.length - EOCD_SIZE; i >= Math.max(0, zip.length - EOCD_SIZE - MAX_COMMENT); i -= 1) {
        if (view.getUint32(i, true) === EOCD_SIGNATURE) {
            record = i;
            break;
        }
    }

    if (record === -1) throw new Error("no end-of-central-directory record: this is not a zip");

    const entries = view.getUint16(record + 10, true);
    const directory = view.getUint32(record + 16, true);

    if (directory === ZIP64) throw new Error("a zip64 archive, which this cannot read");

    let at = directory;

    for (let i = 0; i < entries; i += 1) {
        if (at + CENTRAL_SIZE > zip.length) throw new Error("the central directory runs past the end of the archive");
        if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw new Error(`entry ${i} is not a directory entry`);

        const method = view.getUint16(at + 10, true);
        const compressed = view.getUint32(at + 20, true);
        const uncompressed = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const local = view.getUint32(at + 42, true);
        const name = names.decode(zip.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength));

        if (wanted(name)) {
            if (compressed === ZIP64) throw new Error(`'${name}' is a zip64 entry, which this cannot read`);
            if (local + LOCAL_SIZE > zip.length || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
                throw new Error(`'${name}' has no local header where the directory says it is`);
            }

            // The declared size first, for the message it gives an honest archive. A
            // writer is free to understate it, which is what `maxOutputLength` below is
            // for.
            if (uncompressed > limit) {
                throw new Error(`'${name}' says it holds ${uncompressed} bytes, more than the ${limit} this reads`);
            }

            // The local header repeats the name and the extra field at its own lengths,
            // which need not be the central directory's: a writer is free to put an extra
            // field in one and not in the other, and the data starts after whichever this
            // header declares.
            const start =
                local + LOCAL_SIZE + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);

            if (start + compressed > zip.length) throw new Error(`'${name}' runs past the end of the archive`);

            const data = zip.subarray(start, start + compressed);

            if (method === 0) {
                if (data.length > limit) {
                    throw new Error(`'${name}' is ${data.length} bytes, more than the ${limit} this reads`);
                }

                return data;
            }

            if (method === 8) return new Uint8Array(inflateRawSync(data, { maxOutputLength: limit }));

            throw new Error(`'${name}' uses compression method ${method}, which this cannot read`);
        }

        at += CENTRAL_SIZE + nameLength + extraLength + commentLength;
    }

    return null;
}
