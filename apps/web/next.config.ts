import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // workspace packages ship TypeScript source
  transpilePackages: ["@ballast/risk", "@ballast/sdk", "@ballast/binance"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // the deployment files are read at request time (contracts/deployments/<chainId>.json)
  outputFileTracingIncludes: {
    "/app": ["../../contracts/deployments/*.json"],
    "/api/**/*": ["../../contracts/deployments/*.json"],
  },
};

export default config;
