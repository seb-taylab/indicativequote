import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MetaComp Rate Hub',
  description: 'Internal partner rate board with an indicative quote.',
  // D1: internal only. No public projection, and nothing indexed.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
