import { describe, expect, it } from "vitest";
import { fileLineRefs } from "./file-line-refs.js";

const FILES = [
  "package.json",
  "turbo.json",
  "compose.yaml",
  ".nvmrc",
  "apps/api/package.json",
  "apps/worker/src/runtime.ts",
  ".github/workflows/ci.yml",
  "infra/docker/app.Dockerfile",
  "packages/db/src/cli/migrate.ts",
  "tools/new-top/check.mjs",
];

describe("fileLineRefs", () => {
  it.each([
    [
      "a path from the root",
      "(`apps/api/package.json:7`)",
      "apps/api/package.json:7",
    ],
    [
      "a range",
      "`apps/worker/src/runtime.ts:193-200`",
      "apps/worker/src/runtime.ts:193-200",
    ],
    [
      "a hidden top directory",
      "(`.github/workflows/ci.yml:82-83`)",
      ".github/workflows/ci.yml:82-83",
    ],
    [
      "a Dockerfile",
      "`infra/docker/app.Dockerfile:56`",
      "infra/docker/app.Dockerfile:56",
    ],
    ["a file at the root", "see `turbo.json:12`", "turbo.json:12"],
    ["a file at the root without an extension", "`.nvmrc:1`", ".nvmrc:1"],
    [
      "a path from the root of a package",
      "(`src/cli/migrate.ts:12`)",
      "src/cli/migrate.ts:12",
    ],
    ["a bare file name of the repository", "`migrate.ts:12`", "migrate.ts:12"],
    [
      "a path from the root behind ./",
      "(`./apps/api/package.json:7`)",
      "./apps/api/package.json:7",
    ],
    [
      "a path behind ../",
      "`../../packages/db/src/cli/migrate.ts:12`",
      "../../packages/db/src/cli/migrate.ts:12",
    ],
    [
      "a path under a top directory no list names",
      "`tools/new-top/check.mjs:3`",
      "tools/new-top/check.mjs:3",
    ],
  ])("refuses %s", (_what, text, ref) => {
    expect(fileLineRefs(text, FILES)).toEqual([ref]);
  });

  it.each([
    ["a reference by symbol", "(`scripts.dev` в `apps/api/package.json`)"],
    [
      "a file of a library",
      "(`bodyless` в `fastify.js:134`, `lib/handle-request.js:35`)",
    ],
    [
      "a host and port",
      "`postgres://sf:sf@localhost:5432/sf`, `x@localhost:5442`, `127.0.0.1:5432`",
    ],
    ["a url", "`http://api:3001/health`"],
    [
      "a path under a directory that is not of the repository",
      "`node_modules/fastify/lib/route.js:480`",
    ],
    ["a tail that is not a whole name", "`ate.ts:12`, `json:7`"],
  ])("passes %s", (_what, text) => {
    expect(fileLineRefs(text, FILES)).toEqual([]);
  });
});
