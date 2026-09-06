import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // env-ok: build-time packaging switch for web.Dockerfile, not app config (E0-01)
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1"
    ? { output: "standalone" as const }
    : {}),
};

export default nextConfig;
