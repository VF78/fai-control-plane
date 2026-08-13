import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import './styles.css';

export const metadata: Metadata = {title: 'f(AI) Control Plane', description: 'GitHub Project + Hermes supervision'};
export default function Layout({children}: Readonly<{children: ReactNode}>) {
  return <html lang="ru"><body>{children}</body></html>;
}
