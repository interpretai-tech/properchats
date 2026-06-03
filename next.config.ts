import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the Next.js dev indicator/logo (it overlapped the sidebar controls).
  devIndicators: false,
  // Allow the dev server (and its HMR websocket) to be reached over Tailscale /
  // LAN, not just localhost. Add your own dev hostnames here if Next blocks
  // cross-origin dev requests from them.
  allowedDevOrigins: ["*.ts.net"],
};

export default nextConfig;
