import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // workspace packages ship TypeScript source
  transpilePackages: ["@ballast/risk"],
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
};

export default config;
