import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // web/ is its own app inside the Atlas repo; don't let the root lockfile pick the workspace.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  // The chat log section is gone; older links shared in chats land on the overview.
  async redirects() {
    return [{ source: "/t/:id/chat", destination: "/t/:id", permanent: false }];
  },
};

export default config;
