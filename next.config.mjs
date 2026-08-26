/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    // §18.5 transport: HSTS, a CSP denying inline script, and the usual
    // hardening. 'unsafe-inline' is permitted for STYLE only (Next injects
    // critical CSS); script-src carries no unsafe-inline.
    return [
      {
        source: '/:path*',
        headers: [
          // The Content-Security-Policy is NOT set here. It carries a
          // per-request nonce so that Next.js's own inline bootstrap can run
          // while nothing else inline can, and a static header cannot vary
          // per request. See middleware.ts, which sets it and explains why.
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // The board shows partner pricing. Keep it out of search indexes and
          // out of any assistant that respects the header -- D1, internal only.
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
        ],
      },
    ];
  },
};

export default nextConfig;
