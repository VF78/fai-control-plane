import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import './styles.css';

export const metadata: Metadata = {
  title: 'f(AI) Control Plane',
  description: 'Internal software delivery control plane'
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
