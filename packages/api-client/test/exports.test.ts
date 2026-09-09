import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * What the package promises a bundler, checked where it is written down.
 *
 * This package exists to take `ADMIN_PASSWORD` and put it into a header, so a
 * `"use client"` component that imported it would ship the password in a
 * static chunk. `@sf/config` answers that with two entries and the
 * `server-only` marker, and this file holds `@sf/api-client` to the same
 * shape, under the same name as its neighbour
 * (`packages/config/test/exports.test.ts`): a `browser` condition that
 * resolves to the marker module rather than to the client, and `default`
 * after it.
 *
 * What it does not do is run a bundler - no consumer imports this package
 * until E0-10, where the web build is the check. It fails when the entries,
 * their order or the marker are dropped, which is the way they would be lost.
 */
const ManifestSchema = z.object({
  main: z.string(),
  exports: z.object({
    // A record rather than an object: `z.object` returns its own keys in the
    // order the schema declares them, and the order of the file is what the
    // case below is about.
    ".": z.record(z.string()),
    "./server": z.string(),
  }),
  dependencies: z.record(z.string()),
});

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/**
 * The manifest, parsed inside the test that reads it: a parse in the body of
 * the suite would fail the file before any case ran, and a suite that cannot
 * name what broke is a worse report than a failing assertion.
 */
function manifestOf(): z.infer<typeof ManifestSchema> {
  // `JSON.parse` gives back a value of no type at all; the shape this file is
  // about is what the schema states.
  const declared: unknown = JSON.parse(read("../package.json"));
  return ManifestSchema.parse(declared);
}

describe("package exports", () => {
  it("sends a browser bundle to the server-only module", () => {
    const manifest = manifestOf();

    expect(manifest.exports["."].browser).toBe("./src/server.ts");
    expect(manifest.exports["./server"]).toBe("./src/server.ts");
  });

  it("keeps `default` last so node, tsx and tsc get the plain module", () => {
    const rootEntry = manifestOf().exports["."];

    // Conditions are matched in the order they are written and `default`
    // matches everything: with `default` first, `browser` is dead and the
    // marker is gone - a resolver under `--conditions=browser` lands on the
    // client, and nothing else in this package would say so.
    expect(Object.keys(rootEntry)).toEqual(["browser", "default"]);
    // The same module both ways, so a resolver that reads `main` and one that
    // reads `exports` land on the same file.
    expect(rootEntry.default).toBe(`./${manifestOf().main}`);
  });

  it("puts the marker in that module and nowhere else", () => {
    const manifest = manifestOf();

    // In `index.ts` the marker would throw under every resolve condition but
    // `react-server` and take down every test and every server of this
    // repository with it.
    expect(read("../src/server.ts")).toContain('import "server-only"');
    expect(read("../src/index.ts")).not.toContain("server-only");
    expect(manifest.dependencies["server-only"]).toBeDefined();
  });

  it("offers through the server entry exactly what the root entry offers", () => {
    // web reaches this package only through `./server` (ADR-0001), so a
    // hand-written list there would hide from web whatever a later epic adds
    // to the client. Re-exporting the root entry leaves one list.
    expect(read("../src/server.ts")).toContain('export * from "./index.js"');
  });
});
