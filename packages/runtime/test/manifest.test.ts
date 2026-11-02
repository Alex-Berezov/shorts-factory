import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { readPackageManifest } from "../test-support/manifest.js";
import { packageWith, removePackageDirs } from "./package-fixture.js";

describe("readPackageManifest", () => {
  afterEach(removePackageDirs);

  const NameSchema = z.object({ name: z.string().min(1) });

  it("reads the manifest through the schema it is given", () => {
    const dir = packageWith(JSON.stringify({ name: "x", version: "1.0.0" }));

    expect(readPackageManifest(dir, NameSchema)).toEqual({ name: "x" });
  });

  it.each([
    ["that is no JSON", "{ name:"],
    ["that the schema refuses", JSON.stringify({ name: "" })],
  ])("refuses a manifest %s, naming the file", (_case, text) => {
    const dir = packageWith(text);

    expect(() => readPackageManifest(dir, NameSchema)).toThrow(
      join(dir, "package.json"),
    );
  });

  it("refuses a directory with no manifest, naming the file, with the missing file as the cause", () => {
    const dir = packageWith("{}");
    const file = join(dir, "package.json");
    rmSync(file);

    expect(() => readPackageManifest(dir, NameSchema)).toThrow(
      expect.objectContaining({
        message: `${file} is not a readable JSON manifest`,
        cause: expect.objectContaining({ code: "ENOENT" }),
      }),
    );
  });
});
