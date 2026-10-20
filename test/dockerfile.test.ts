import { describe, expect, it } from "vitest";
import { parseDockerfile, stagesOfTarget, targetsOf } from "./dockerfile.js";

describe("parseDockerfile", () => {
  it("reads FROM with flags and names", () => {
    const stages = parseDockerfile(
      [
        "# syntax=docker/dockerfile:1",
        "FROM --platform=linux/amd64 node:22-alpine AS Base",
        "FROM base AS fetch",
        "FROM node:22-alpine",
      ].join("\n"),
    );

    expect(stages.map(({ name }) => name)).toEqual(["base", "fetch", "2"]);
  });

  it("joins continuation lines and drops comments, also inside them", () => {
    const [stage] = parseDockerfile(
      [
        "FROM node:22-alpine AS base",
        "# a comment line",
        "RUN pnpm install \\",
        "  # a comment between the lines",
        "  --offline",
      ].join("\n"),
    );

    expect(stage?.instructions).toEqual(["RUN pnpm install    --offline"]);
  });
});

/**
 * A Dockerfile of the shape of `infra/docker/app.Dockerfile`: shared stages,
 * a stage per target that installs, and targets that copy from them.
 */
const SYNTHETIC = parseDockerfile(
  [
    "FROM node:22-alpine AS base",
    "FROM base AS fetch",
    "FROM fetch AS one-deps",
    "FROM fetch AS two-deps",
    "FROM node:22-alpine AS one",
    "COPY --from=one-deps /repo/node_modules /repo/node_modules",
    "FROM node:22-alpine AS two",
    "COPY --chown=node:node --from=Two-Deps /repo /repo",
    "COPY --from=node:22-alpine /usr/local/bin/node /usr/local/bin/",
  ].join("\n"),
);

describe("targetsOf", () => {
  it("takes the stages nothing is built from, a stage only copied from included", () => {
    expect(targetsOf(SYNTHETIC)).toEqual(["one", "two"]);
  });

  it("refuses a target without an AS name", () => {
    const stages = parseDockerfile(
      ["FROM node:22-alpine AS base", "FROM base"].join("\n"),
    );

    expect(() => targetsOf(stages)).toThrow(/stage 1 is a target without/);
  });

  it("does not take a stage that a RUN mounts from for a target", () => {
    const stages = parseDockerfile(
      [
        "FROM node:22-alpine AS sources",
        "FROM node:22-alpine AS one",
        "RUN --mount=type=bind,from=Sources,target=/src --mount=type=cache,target=/c cp -r /src /app",
        "RUN --mount=type=bind,from=node:22-alpine,target=/n true",
      ].join("\n"),
    );

    expect(targetsOf(stages)).toEqual(["one"]);
    expect(stagesOfTarget(stages, "one").map(({ name }) => name)).toEqual([
      "sources",
      "one",
    ]);
  });

  it("reads COPY --from=<number> as the stage of that index", () => {
    const stages = parseDockerfile(
      [
        "FROM node:22-alpine AS deps",
        "FROM node:22-alpine AS one",
        "COPY --from=0 /repo /repo",
      ].join("\n"),
    );

    expect(targetsOf(stages)).toEqual(["one"]);
    expect(stagesOfTarget(stages, "one").map(({ name }) => name)).toEqual([
      "deps",
      "one",
    ]);
  });

  it("refuses COPY --from=<number> of a stage that is not there", () => {
    const stages = parseDockerfile(
      ["FROM node:22-alpine AS one", "COPY --from=7 /repo /repo"].join("\n"),
    );

    expect(() => targetsOf(stages)).toThrow(
      "stage one takes from stage 7, which is not there",
    );
  });

  it.each([
    ["COPY --from=one-dep /repo /repo"],
    ["RUN --mount=type=bind,from=one-dep,target=/src true"],
  ])("refuses %s - a stage name no stage has", (line) => {
    const stages = parseDockerfile(
      [
        "FROM node:22-alpine AS one-deps",
        "FROM node:22-alpine AS one",
        line,
      ].join("\n"),
    );

    expect(() => targetsOf(stages)).toThrow(
      "stage one takes from one-dep, which is no stage; an image needs its tag, registry or path",
    );
  });

  it.each([["alpine:3"], ["ghcr.io/x/y"], ["docker.io/library/node"]])(
    "takes COPY --from=%s for an image",
    (image) => {
      const stages = parseDockerfile(
        ["FROM node:22-alpine AS one", `COPY --from=${image} /x /x`].join("\n"),
      );

      expect(targetsOf(stages)).toEqual(["one"]);
    },
  );

  it("refuses a file without stages", () => {
    expect(() => targetsOf(parseDockerfile("ARG X=1"))).toThrow(/no stage/);
  });
});

describe("stagesOfTarget", () => {
  it("takes the target and what it is built from, not the stages of another target", () => {
    expect(stagesOfTarget(SYNTHETIC, "two").map(({ name }) => name)).toEqual([
      "base",
      "fetch",
      "two-deps",
      "two",
    ]);
  });

  it("refuses an unknown target", () => {
    expect(() => stagesOfTarget(SYNTHETIC, "three")).toThrow(
      'no target "three"',
    );
  });
});
