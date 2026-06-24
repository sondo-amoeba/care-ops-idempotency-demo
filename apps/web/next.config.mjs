/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const apiBase = process.env.API_PROXY_URL ?? "http://localhost:3001";
    return [
      {
        source: "/care-ops/:path*",
        destination: `${apiBase}/care-ops/:path*`,
      },
      {
        source: "/webhooks/:path*",
        destination: `${apiBase}/webhooks/:path*`,
      },
    ];
  },
};

export default nextConfig;
