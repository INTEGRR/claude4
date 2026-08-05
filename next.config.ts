import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['postgres', 'bwip-js'],
  experimental: {
    // Server Actions handle all mutations; keep the body limit generous for
    // label PDFs coming back from DHL.
    serverActions: { bodySizeLimit: '8mb' },
  },
}

export default nextConfig
