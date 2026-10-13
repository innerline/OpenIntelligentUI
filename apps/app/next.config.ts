import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@copilotkit/runtime"],
  async redirects() {
    return [
      {
        source: "/",
        destination: "/cockpit/honey",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
