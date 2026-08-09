import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import './styles.css';

export const metadata: Metadata = {
  title: 'f(AI) Control',
  description: 'Панель управления разработкой программного обеспечения'
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
