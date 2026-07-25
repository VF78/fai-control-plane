import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: [
    '@fai-control-plane/db',
    '@fai-control-plane/observability'
  ]
};

export default nextConfig;
