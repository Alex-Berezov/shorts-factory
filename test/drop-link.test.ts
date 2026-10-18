import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dropLink } from "./drop-link.js";

describe("dropLink", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "sf-drop-link-test-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("does nothing for a path that does not exist", () => {
    expect(() => dropLink(join(sandbox, "missing"))).not.toThrow();
  });

  it("rethrows for a plain directory and leaves it in place", () => {
    const dir = join(sandbox, "plain");
    mkdirSync(dir);
    writeFileSync(join(dir, "keep.txt"), "x");

    expect(() => dropLink(dir)).toThrow();
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);
  });

  it("takes a link off and keeps its target", () => {
    const target = join(sandbox, "target");
    const link = join(sandbox, "link");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "x");
    symlinkSync(target, link, "junction");

    dropLink(link);

    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });
});
