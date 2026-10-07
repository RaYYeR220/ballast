import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // workspace packages ship TypeScript source
  transpilePackages: ["@ballast/risk"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default config;
