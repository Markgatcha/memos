/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  // Suppress lockfile warnings since we have nested package.json
  outputFileTracingRoot: __dirname,
};

module.exports = nextConfig;