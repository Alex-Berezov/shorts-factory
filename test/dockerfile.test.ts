import { describe, expect, it } from "vitest";
import { parseDockerfile } from "./dockerfile.js";

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
