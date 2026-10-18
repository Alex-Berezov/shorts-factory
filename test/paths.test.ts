import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { canonical, isEntry, repoRoot, rootOf } from "../scripts/lib/paths.mjs";

describe("rootOf", () => {
  it.each(["checkout", "a b", "ж", join("a b", "ж")])(
    "finds the root of a checkout under a path %s",
    (folder) => {
      const root = join(tmpdir(), folder);
      const module = pathToFileURL(join(root, "scripts", "lib", "paths.mjs"));

      expect(rootOf(module.href, 2)).toBe(root);
    },
  );

  it("stays in the module's directory for zero levels", () => {
    const module = pathToFileURL(join(tmpdir(), "a b", "x.mjs"));

    expect(rootOf(module.href, 0)).toBe(join(tmpdir(), "a b"));
  });
});

describe("repoRoot", () => {
  it("is the directory of the workspace manifest", () => {
    expect(existsSync(join(repoRoot, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(join(repoRoot, "scripts", "lib", "paths.mjs"))).toBe(
      true,
    );
  });
});

describe("isEntry", () => {
  it("canonicalizes both sides with the native realpath, as the compose gate does", () => {
    // The JS realpath keeps the case of a Windows path as given; the gate
    // compares paths of the native one (scripts/check-compose.mjs).
    const script = join(repoRoot, "scripts", "lib", "paths.mjs");
    const native = vi.spyOn(realpathSync, "native");
    try {
      expect(isEntry(pathToFileURL(script).href, script)).toBe(true);
      expect(native).toHaveBeenCalledTimes(2);
    } finally {
      native.mockRestore();
    }
  });

  it("is false for another script, and only then", () => {
    const script = join(repoRoot, "scripts", "lib", "paths.mjs");
    const other = join(repoRoot, "scripts", "lib", "files.mjs");

    expect(isEntry(pathToFileURL(script).href, other)).toBe(false);
    expect(isEntry(pathToFileURL(script).href, undefined)).toBe(false);
    expect(isEntry(pathToFileURL(script).href, "")).toBe(false);
  });

  it("is the entry when both paths lead to the same file, however written", () => {
    // Two files of the repository a link-resolving realpath takes to one:
    // `argv[1]` must name a file on disk to be compared at all.
    const module = join(repoRoot, "scripts", "lib", "paths.mjs");
    const script = join(repoRoot, "scripts", "probe-image.mjs");
    const other = join(repoRoot, "scripts", "lib", "files.mjs");
    const real = (path: string) =>
      path === module || path === script ? "target" : path;

    expect(isEntry(pathToFileURL(module).href, script, real)).toBe(true);
    expect(isEntry(pathToFileURL(module).href, other, real)).toBe(false);
  });

  it("is false for a path through a file, whatever the platform reports for it", () => {
    // POSIX answers ENOTDIR for `file/x`, Windows ENOENT; the ENOTDIR branch
    // is held by the error itself, not by the disk the test runs on.
    const script = join(repoRoot, "scripts", "lib", "paths.mjs");
    const entry = join(script, "x");
    const resolvePath = vi.fn((path: string) => path);
    const stat = vi.fn((path: string): undefined => {
      throw Object.assign(new Error(`ENOTDIR: not a directory, ${path}`), {
        code: "ENOTDIR",
      });
    });

    expect(isEntry(pathToFileURL(script).href, entry, resolvePath, stat)).toBe(
      false,
    );
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith(entry);
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it("throws with the path and the cause for an argv[1] it cannot stat, not false", () => {
    // Fail-closed: an unreadable `argv[1]` is not "another script".
    const script = join(repoRoot, "scripts", "lib", "paths.mjs");
    const failure = Object.assign(new Error(`EACCES: ${script}`), {
      code: "EACCES",
    });
    const resolvePath = vi.fn((path: string) => path);
    const stat = (): undefined => {
      throw failure;
    };

    let thrown: unknown;
    try {
      isEntry(pathToFileURL(script).href, script, resolvePath, stat);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      message: `cannot stat ${script}`,
      cause: failure,
    });
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it("throws with the path for a stat failure that is not an Error, not false", () => {
    // A thrown value that is not an Error is no failed system call, whatever
    // `code` it carries: it says nothing about the path being gone.
    const script = join(repoRoot, "scripts", "lib", "paths.mjs");
    const failure = { code: "ENOTDIR" };
    const resolvePath = vi.fn((path: string) => path);
    const stat = (): undefined => {
      throw failure;
    };

    let thrown: unknown;
    try {
      isEntry(pathToFileURL(script).href, script, resolvePath, stat);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      message: `cannot stat ${script}`,
      cause: failure,
    });
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it.each([
    ["-", "a script read from stdin"],
    [join(repoRoot, "scripts", "no-such-script.mjs"), "a path to no file"],
    [
      join(repoRoot, "scripts", "lib", "paths.mjs", "x"),
      "a path through a file",
    ],
    [join(repoRoot, "scripts", "lib"), "a directory"],
  ])("is false for %s (%s), without resolving it", (entry) => {
    // Importing a gate from a script run as `node -` or under a wrapper must
    // not throw at the top of the module.
    const script = join(repoRoot, "scripts", "lib", "paths.mjs");
    const resolvePath = vi.fn((path: string) => path);

    expect(isEntry(pathToFileURL(script).href, entry, resolvePath)).toBe(false);
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it("throws with the path and the cause for a file it cannot resolve, not false", () => {
    // A guard that answered false here would let a gate exit 0 having
    // checked nothing.
    const script = join(repoRoot, "scripts", "lib", "paths.mjs");
    const other = join(repoRoot, "scripts", "lib", "files.mjs");
    const failure = new Error(`EACCES: ${other}`);
    const failing = (path: string): string => {
      if (path === other) throw failure;
      return path;
    };

    let thrown: unknown;
    try {
      isEntry(pathToFileURL(script).href, other, failing);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      message: `cannot resolve ${other}`,
      cause: failure,
    });
    expect(() => isEntry(pathToFileURL(other).href, script, failing)).toThrow(
      `cannot resolve ${other}`,
    );
  });
});

describe("canonical", () => {
  it("is the native realpath", () => {
    const script = join(repoRoot, "scripts", "lib", "paths.mjs");

    expect(canonical(script)).toBe(realpathSync.native(script));
  });

  it("throws with the path and the failure in cause", () => {
    const gone = join(repoRoot, "scripts", "no-such-script.mjs");

    let thrown: unknown;
    try {
      canonical(gone);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ message: `cannot resolve ${gone}` });
    expect(thrown).toHaveProperty("cause.code", "ENOENT");
  });
});
