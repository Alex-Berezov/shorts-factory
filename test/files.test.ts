import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isGone, readIfFile } from "../scripts/lib/files.mjs";

/**
 * The one answer of the root scripts to "is that path gone"
 * (`scripts/lib/files.mjs`), each branch on its own: the gates that walk a
 * tree, run a binary or read a file that may be absent take it from there.
 */
const scratch = mkdtempSync(join(tmpdir(), "sf-files-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const failed = (code: string): Error =>
  Object.assign(new Error(`${code}: injected`), { code });

describe("isGone", () => {
  it.each([
    ["ENOENT", true, failed("ENOENT")],
    ["EPERM", false, failed("EPERM")],
    ["EBUSY", false, failed("EBUSY")],
    ["EACCES", false, failed("EACCES")],
    ["an error without a code", false, new Error("ENOENT")],
    ["a value that is not an error", false, { code: "ENOENT" }],
  ] as const)("takes %s for gone: %s", (_what, gone, error) => {
    expect(isGone(error)).toBe(gone);
  });
});

describe("readIfFile", () => {
  it("reads a file, and gives null for nothing or a directory there", () => {
    writeFileSync(join(scratch, "file"), "text\n");
    mkdirSync(join(scratch, "directory"));

    expect(readIfFile(join(scratch, "file"))).toBe("text\n");
    expect(readIfFile(join(scratch, "missing"))).toBeNull();
    expect(readIfFile(join(scratch, "directory"))).toBeNull();
  });

  it("throws what is not a missing file", () => {
    // A path node refuses outright: not an absent file, an error to report.
    expect(() => readIfFile("compose\0.yaml")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
  });
});
