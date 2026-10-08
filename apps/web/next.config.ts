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
  // every response: never framed by another site (a wallet confirms what this page shows), no MIME sniffing,
  // and no full URL leaked to other origins
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default config;
