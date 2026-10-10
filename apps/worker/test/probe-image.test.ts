import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  CONTAINER_SCRIPT,
  CONTROL,
  type ImageCheck,
  PROBES,
  type ProbeRun,
  WORKSPACE_OF,
  checksOf,
  dockerArgs,
  isEntry,
  main,
  workspaceChecks,
} from "../../../scripts/probe-image.mjs";
import { imagesOf } from "./dockerfile.js";

/**
 * The probe the `docker-build` job runs on every image
 * (`scripts/probe-image.mjs`). Its program runs under the node of this test
 * in a temporary directory that stands in for the WORKDIR of an image, so
 * nothing depends on how pnpm laid out the repository; `main` gets that run
 * in place of `docker run`.
 */
const scratch = mkdtempSync(join(tmpdir(), "sf-probe-image-"));
const scriptsLink = join(scratch, "scripts-link");
afterAll(() => {
  // The link goes first on its own: a recursive remove must never walk through
  // it into the real scripts/ directory.
  try {
    unlinkSync(scriptsLink);
  } catch {
    // never created when the entry-guard case did not run
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** A directory holding the given files (path -> contents). */
function fakeImage(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

/** A package that resolves: a manifest with `main` and that file. */
function pkg(path: string): Record<string, string> {
  return {
    [`${path}/package.json`]: JSON.stringify({ main: "index.js" }),
    [`${path}/index.js`]: "",
  };
}

// NODE_PATH: pnpm sets it for its scripts, and resolution would find packages
// the stand-in WORKDIR does not hold.
function runIn(dir: string, checks: ImageCheck[]): ProbeRun {
  return spawnSync(
    process.execPath,
    ["-e", CONTAINER_SCRIPT, JSON.stringify(checks)],
    { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
  );
}

const apiImage = fakeImage("api", {
  ...pkg("node_modules/fastify"),
  ...pkg("node_modules/tsx"),
  ...pkg("node_modules/@sf/config"),
});
const nested = fakeImage("nested", {
  "server.js": "",
  ...pkg("app/node_modules/present"),
});
const API_MANIFEST = {
  dependencies: { "@sf/config": "workspace:*", fastify: "^5.0.0" },
};

describe("image probe program", () => {
  it("passes for files and packages that are there", () => {
    const result = runIn(nested, [
      { file: "server.js" },
      { pkg: "present", from: "app" },
    ]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails and names a package that is not installed", () => {
    const result = runIn(nested, [{ pkg: "present", from: "app" }, CONTROL]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(CONTROL.pkg);
  });

  it("fails and names a file that is not there", () => {
    const result = runIn(nested, [{ file: "apps/web/server.js" }]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apps/web/server.js");
  });

  it("resolves a package from the directory given, not from the WORKDIR", () => {
    expect(runIn(nested, [{ pkg: "present" }]).status).toBe(1);
    expect(runIn(nested, [{ pkg: "present", from: "app" }]).status).toBe(0);
  });
});

describe("image probe table", () => {
  it("has checks for every image the repository builds, and for no other", () => {
    expect(Object.keys(PROBES).sort()).toEqual(imagesOf());
    for (const checks of Object.values(PROBES)) {
      expect(checks.length).toBeGreaterThan(0);
    }
  });

  it("checks the workspace links of the services that run from their package", () => {
    expect(Object.keys(WORKSPACE_OF).sort()).toEqual(
      imagesOf().filter((image) => image !== "web"),
    );
    expect(checksOf("worker")).toEqual(
      expect.arrayContaining([
        { file: "node_modules/@sf/config/package.json" },
        { file: "node_modules/@sf/db/package.json" },
      ]),
    );
  });

  it("takes one file check per workspace dependency and nothing else", () => {
    expect(workspaceChecks(API_MANIFEST)).toEqual([
      { file: "node_modules/@sf/config/package.json" },
    ]);
    expect(workspaceChecks({})).toEqual([]);
  });
});

describe("image probe docker run", () => {
  it("runs the image just built and never pulls one from a registry", () => {
    const args = dockerArgs("sf-api:ci", [{ pkg: "fastify" }]);

    expect(args.slice(0, 3)).toEqual(["run", "--rm", "--pull=never"]);
    expect(args).toContain("sf-api:ci");
  });
});

describe("image probe main", () => {
  const lines: string[] = [];
  const deps = (run: (tag: string, checks: ImageCheck[]) => ProbeRun) => ({
    run,
    read: () => API_MANIFEST,
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  });
  const inDir = (dir: string) => (_tag: string, checks: ImageCheck[]) =>
    runIn(dir, checks);

  it("passes an image that has everything and whose control run fails", () => {
    lines.length = 0;

    expect(main(["api", "sf-api:test"], deps(inDir(apiImage)))).toBe(0);
    expect(lines.join("\n")).toContain(
      "sf-api:test ok (3 checks, control red)",
    );
  });

  it("fails an image without a workspace link of its service", () => {
    const unlinked = fakeImage("unlinked", {
      ...pkg("node_modules/fastify"),
      ...pkg("node_modules/tsx"),
    });
    lines.length = 0;

    expect(main(["api"], deps(inDir(unlinked)))).toBe(1);
    expect(lines.join("\n")).toContain(
      "missing node_modules/@sf/config/package.json",
    );
  });

  it("fails when the control run cannot turn red", () => {
    const controlled = fakeImage("controlled", {
      ...pkg("node_modules/fastify"),
      ...pkg("node_modules/tsx"),
      ...pkg("node_modules/@sf/config"),
      ...pkg(`node_modules/${CONTROL.pkg}`),
    });
    lines.length = 0;

    expect(main(["api"], deps(inDir(controlled)))).toBe(1);
    expect(lines.join("\n")).toContain("the control check did not fail");
  });

  it("tells a docker failure from a missing package", () => {
    const noDocker = (): ProbeRun => ({
      status: 125,
      stderr: "Unable to find image 'sf-api:ci' locally",
    });
    lines.length = 0;

    expect(main(["api"], deps(noDocker))).toBe(2);
    expect(lines.join("\n")).toContain("could not run the probe in sf-api:ci");
  });

  it("tells a docker failure on the control run from a missing package", () => {
    const run = vi.fn(
      (_tag: string, checks: ImageCheck[]): ProbeRun =>
        checks.includes(CONTROL)
          ? { status: 125, stderr: "docker: Error response from daemon" }
          : { status: 0, stderr: "" },
    );
    lines.length = 0;

    expect(main(["api"], deps(run))).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).toContain(
      "could not run the control probe in sf-api:ci",
    );
  });

  it("tells a manifest that cannot be read from a missing package", () => {
    const run = vi.fn((): ProbeRun => ({ status: 0, stderr: "" }));
    lines.length = 0;

    expect(
      main(["api"], {
        ...deps(run),
        read: () => {
          throw new Error("ENOENT: no such file");
        },
      }),
    ).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("could not work out the checks of api");
    expect(lines.join("\n")).toContain("ENOENT");
  });

  it("names the cause of a failure that is not a missing manifest", () => {
    lines.length = 0;

    expect(
      main(["api"], {
        ...deps(() => ({ status: 0, stderr: "" })),
        read: () => JSON.parse("{ not json"),
      }),
    ).toBe(2);
    expect(lines.join("\n")).not.toContain("undefined");
    expect(lines.join("\n")).toMatch(/checks of api: .*JSON/);
  });

  it("reports status and signal when docker prints nothing", () => {
    const killed = (): ProbeRun => ({
      status: null,
      stderr: "",
      signal: "SIGKILL",
    });
    lines.length = 0;

    expect(main(["api"], deps(killed))).toBe(2);
    expect(lines.join("\n")).toContain("signal SIGKILL");
    expect(lines.join("\n")).not.toContain("undefined");

    const controlKilled = (_tag: string, checks: ImageCheck[]): ProbeRun =>
      checks.includes(CONTROL)
        ? { status: 137, stderr: "", signal: null }
        : { status: 0, stderr: "" };
    lines.length = 0;

    expect(main(["api"], deps(controlKilled))).toBe(2);
    expect(lines.join("\n")).toContain("exit status 137");
  });

  it("refuses an unknown image, including names of Object.prototype", () => {
    for (const image of ["nginx", "constructor", "toString"]) {
      lines.length = 0;
      expect(main([image], deps(inDir(apiImage)))).toBe(2);
      expect(lines.join("\n")).toContain(`unknown image "${image}"`);
    }
  });

  it("refuses a tag that docker would read as a flag", () => {
    const calls: string[] = [];
    lines.length = 0;

    expect(
      main(
        ["api", "--privileged"],
        deps((tag, checks) => {
          calls.push(tag);
          return runIn(apiImage, checks);
        }),
      ),
    ).toBe(2);
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toContain('"--privileged" is not an image tag');
  });
});

describe("image probe entry guard", () => {
  const script = resolve(__dirname, "../../../scripts/probe-image.mjs");

  it("runs main when started through a link to the script's directory", () => {
    const link = scriptsLink;
    symlinkSync(resolve(script, ".."), link, "junction");

    const result = spawnSync(
      process.execPath,
      [join(link, "probe-image.mjs"), "no-such-image"],
      { encoding: "utf8" },
    );

    expect(result.stderr).toContain('unknown image "no-such-image"');
    expect(result.status).toBe(2);
  });

  it("is the entry when both paths lead to the same file, however written", () => {
    const real = (path: string) =>
      /[\\/]a\.mjs$/.test(path) ? "target" : path;

    expect(
      isEntry(pathToFileURL("/real/a.mjs").href, "/link/a.mjs", real),
    ).toBe(true);
    expect(
      isEntry(pathToFileURL("/real/a.mjs").href, "/link/b.mjs", real),
    ).toBe(false);
  });

  it("is not the entry without a script, or when a path cannot be resolved", () => {
    const url = pathToFileURL(script).href;
    const broken = () => {
      throw new Error("ENOENT");
    };

    expect(isEntry(url, undefined)).toBe(false);
    expect(isEntry(url, "")).toBe(false);
    expect(isEntry(url, script, broken)).toBe(false);
    expect(isEntry(url, script)).toBe(true);
  });
});
