import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: [
    '@fai-control-plane/db',
    '@fai-control-plane/application',
    '@fai-control-plane/domain',
    '@fai-control-plane/integrations'
  ]
};

export default nextConfig;
