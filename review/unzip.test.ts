import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { readFromZip } from "./unzip.ts";

interface Entry {
    name: string;
    body: string;
    /** Stored entries are legal zip, and GitHub emits them for anything that will not shrink. */
    deflate?: boolean;
    /** Bytes of extra field in the local header alone, which a real writer uses for alignment. */
    localExtra?: number;
}

/**
 * A zip built to the spec's field offsets, so that the reader is checked against the
 * layout rather than against a mirror of its own arithmetic.
 */
function zip(entries: Entry[]): Uint8Array {
    const bytes = new TextEncoder();
    const files: Uint8Array[] = [];
    const directory: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
        const raw = bytes.encode(entry.body);
        const data = entry.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
        const name = bytes.encode(entry.name);
        const extra = entry.localExtra ?? 0;
        const method = entry.deflate ? 8 : 0;

        const local = new Uint8Array(30 + name.length + extra);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(8, method, true);
        localView.setUint32(18, data.length, true);
        localView.setUint32(22, raw.length, true);
        localView.setUint16(26, name.length, true);
        localView.setUint16(28, extra, true);
        local.set(name, 30);

        const central = new Uint8Array(46 + name.length);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(10, method, true);
        centralView.setUint32(20, data.length, true);
        centralView.setUint32(24, raw.length, true);
        centralView.setUint16(28, name.length, true);
        centralView.setUint32(42, offset, true);
        central.set(name, 46);

        files.push(local, data);
        directory.push(central);
        offset += local.length + data.length;
    }

    const directorySize = directory.reduce((total, entry) => total + entry.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, directorySize, true);
    endView.setUint32(16, offset, true);

    return Buffer.concat([...files, ...directory, end]);
}

const text = (bytes: Uint8Array | null): string | null =>
    bytes === null ? null : new TextDecoder().decode(bytes);

describe("readFromZip", () => {
    test("reads a deflated entry", () => {
        const archive = zip([
            { name: "run.json", body: "{}" },
            { name: "findings.json", body: '{"findings": [1, 2, 3]}'.repeat(20), deflate: true },
        ]);

        expect(text(readFromZip(archive, (name) => name === "findings.json"))).toBe(
            '{"findings": [1, 2, 3]}'.repeat(20),
        );
    });

    test("reads a stored entry", () => {
        expect(text(readFromZip(zip([{ name: "findings.json", body: "{}" }]), () => true))).toBe("{}");
    });

    test("finds an entry inside a directory, which is how a whole build directory is uploaded", () => {
        const archive = zip([{ name: "build/findings.json", body: "{}", deflate: true }]);

        expect(text(readFromZip(archive, (name) => name.endsWith("/findings.json")))).toBe("{}");
    });

    test("reads past a local extra field the central directory does not carry", () => {
        const archive = zip([
            { name: "a.txt", body: "first", localExtra: 11 },
            { name: "findings.json", body: "second", deflate: true, localExtra: 7 },
        ]);

        expect(text(readFromZip(archive, (name) => name === "findings.json"))).toBe("second");
    });

    test("is null when the archive holds no such entry", () => {
        expect(readFromZip(zip([{ name: "run.json", body: "{}" }]), (name) => name === "findings.json")).toBeNull();
    });

    test("throws on something that is not a zip at all", () => {
        expect(() => readFromZip(new TextEncoder().encode("<html>404</html>"), () => true)).toThrow(
            /not a zip/,
        );
    });

    test("refuses an entry that says it holds more than the limit", () => {
        const archive = zip([{ name: "findings.json", body: "x".repeat(4096), deflate: true }]);

        expect(() => readFromZip(archive, () => true, 1024)).toThrow(/more than the 1024/);
    });

    test("refuses an entry that inflates past the limit having understated itself", () => {
        const archive = zip([{ name: "findings.json", body: "x".repeat(4096), deflate: true }]);
        const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);

        // The declared size is what a zip bomb lies about. Overwritten with one under the
        // limit, so that the inflate has to be what stops this. The end record is the last
        // 22 bytes, because this writer adds no archive comment, and it carries the offset
        // of the central directory.
        const central = view.getUint32(archive.length - 22 + 16, true);
        view.setUint32(central + 24, 8, true);

        expect(() => readFromZip(archive, () => true, 1024)).toThrow(/buffer|memory|size/i);
    });

    test("refuses a stored entry longer than the limit", () => {
        const archive = zip([{ name: "findings.json", body: "x".repeat(4096) }]);

        expect(() => readFromZip(archive, () => true, 1024)).toThrow(/more than the 1024/);
    });
});
