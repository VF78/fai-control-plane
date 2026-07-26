import type {PublicProjectProjection} from '@fai-control-plane/application';
import {getProjectShareRuntime} from '../../../src/project-share-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const responseHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Security-Policy': [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'none'",
    "img-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'"
  ].join('; '),
  'Content-Type': 'text/html; charset=utf-8',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive'
} as const;

const escapeHtml = (value: string): string => value.replace(
  /[&<>"']/g,
  (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]!
);

const document = (content: string, title = 'Project update'): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f5f2; color: #20231f; }
    main { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 64px; }
    header { border-bottom: 1px solid #c8ccc5; padding-bottom: 20px; }
    h1 { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: 0; }
    .items { display: grid; gap: 1px; margin-top: 24px; background: #c8ccc5; border: 1px solid #c8ccc5; }
    article { min-width: 0; background: #fff; padding: 20px; }
    .row { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    h2 { min-width: 0; margin: 0; font-size: 17px; line-height: 1.35; letter-spacing: 0; overflow-wrap: anywhere; }
    .status { flex: none; font-size: 13px; font-weight: 650; text-transform: uppercase; }
    p { margin: 10px 0 0; color: #50574f; line-height: 1.55; overflow-wrap: anywhere; }
    time { display: block; margin-top: 14px; color: #6a7169; font-size: 13px; }
    .empty { margin-top: 24px; padding: 20px; background: #fff; border: 1px solid #c8ccc5; }
    @media (max-width: 560px) {
      main { width: min(100% - 24px, 920px); padding-top: 28px; }
      .row { align-items: flex-start; flex-direction: column; gap: 8px; }
    }
  </style>
</head>
<body><main>${content}</main></body>
</html>`;

const renderProjection = (projection: PublicProjectProjection): string => {
  const items = projection.items.map((item) => `<article>
  <div class="row">
    <h2>${escapeHtml(item.publicTitle)}</h2>
    <span class="status">${escapeHtml(item.publicStatus)}</span>
  </div>
  ${item.publicSummary === null ? '' : `<p>${escapeHtml(item.publicSummary)}</p>`}
  <time datetime="${escapeHtml(item.updatedTime)}">${escapeHtml(item.updatedTime)}</time>
</article>`).join('');
  return document(`<header><h1>Project update</h1></header>
${items.length === 0
    ? '<p class="empty">No public items are available.</p>'
    : `<section class="items" aria-label="Project items">${items}</section>`}`);
};

const notFoundResponse = (): Response => new Response(
  document('<header><h1>Shared project unavailable</h1></header>'),
  {status: 404, headers: responseHeaders}
);

export async function GET(
  _request: Request,
  context: {params: Promise<{token: string}>}
): Promise<Response> {
  try {
    const {token} = await context.params;
    if (process.env.PUBLIC_SHARING_ENABLED !== 'true') {
      return notFoundResponse();
    }
    const projection = await (await getProjectShareRuntime()).resolve(token);
    return projection === null
      ? notFoundResponse()
      : new Response(renderProjection(projection), {
          status: 200,
          headers: responseHeaders
        });
  } catch {
    return notFoundResponse();
  }
}
