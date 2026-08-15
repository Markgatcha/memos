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
  // Skip TypeScript type-checking during build for faster builds.
  // Type checking is handled separately in CI via `npm run typecheck`.
  typescript: {
    ignoreBuildErrors: true,
  },
};

module.exports = nextConfig;
