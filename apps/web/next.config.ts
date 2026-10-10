import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources, so Next compiles them itself.
  // The list is the import graph of web rather than its direct dependencies:
  // `@sf/api-client` imports `@sf/contracts`, which imports `@sf/core`, and a
  // package left out fails the build on its raw sources. `@sf/config` and
  // `@sf/api-client` are reachable from server code as their `/server` entries
  // only - see docs/adr/0001-config-server-entry.md.
  transpilePackages: [
    "@sf/config",
    "@sf/api-client",
    "@sf/contracts",
    "@sf/core",
  ],
  experimental: {
    // Workspace sources are ESM TypeScript: they import each other with `.js`
    // specifiers that only exist as `.ts` on disk. Webpack has to try the
    // sources first and keep `.js` last so real JavaScript in node_modules
    // still resolves - see docs/adr/0001-config-server-entry.md.
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
  // env-ok: build-time packaging switch for web.Dockerfile, not app config (E0-01)
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1"
    ? { output: "standalone" as const }
    : {}),
};

export default nextConfig;
