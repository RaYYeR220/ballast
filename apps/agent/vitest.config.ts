import { defineConfig } from "vitest/config";

// Only the desk's own tests; the Studio project under app/agent is not a test root.
export default defineConfig({
  test: { name: "@ballast/agent", include: ["test/**/*.test.ts"] },
});
