import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const SITE = 'https://tunnel.dilyor.dev/';
const DESCRIPTION =
  'Open-source CLI that gives Claude Code, Codex, Cursor, Gemini CLI, OpenCode and other AI coding ' +
  'agents an encrypted tunnel to message each other across machines.';

/** Every HTML page in the build. */
const PAGES = ['index', 'terms', 'privacy', 'refund', 'account', 'admin'];
/** Signed-in pages: noindex, and left out of the sitemap. */
const PRIVATE = ['account', 'admin'];

const OFFERS = [
  { name: 'Free', price: '0', description: '1 tunnel per machine, files up to 10 MB, 7 days of history' },
  { name: 'Plus', price: '5', description: '10 tunnels, files up to 50 MB, 30 days of history, 2 GB of storage' },
  { name: 'Pro', price: '9', description: '20 tunnels, files up to 100 MB, 30 days of history, 5 GB of storage' },
];

// Structured data for search engines and AI answer engines. The FAQPage part is read from the
// page's own <details> elements, so the visible FAQ and the JSON-LD cannot drift apart.
function seo(): Plugin {
  return {
    name: 'tunnel-seo',
    transformIndexHtml(html, ctx) {
      if (basename(ctx.filename) !== 'index.html') return html;
      const questions = [
        ...html.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g),
      ].map(([, question, answer]) => ({
        '@type': 'Question',
        name: plain(question),
        acceptedAnswer: { '@type': 'Answer', text: plain(answer) },
      }));

      const graph = {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'WebSite',
            '@id': `${SITE}#website`,
            url: SITE,
            name: 'tunnel',
            alternateName: 'tunnel-ai',
            inLanguage: 'en',
          },
          {
            '@type': 'SoftwareApplication',
            '@id': `${SITE}#app`,
            name: 'tunnel',
            alternateName: 'tunnel-ai',
            description: DESCRIPTION,
            url: SITE,
            applicationCategory: 'DeveloperApplication',
            applicationSubCategory: 'Command-line tool',
            operatingSystem: 'macOS, Linux, Windows',
            installUrl: `${SITE}install.sh`,
            downloadUrl: `${SITE}tunnel-ai.tgz`,
            license: 'https://opensource.org/licenses/MIT',
            isAccessibleForFree: true,
            offers: OFFERS.map((offer) => ({
              '@type': 'Offer',
              name: offer.name,
              price: offer.price,
              priceCurrency: 'USD',
              description: offer.description,
              ...(offer.price !== '0' && {
                priceSpecification: {
                  '@type': 'UnitPriceSpecification',
                  price: offer.price,
                  priceCurrency: 'USD',
                  unitCode: 'MON',
                },
              }),
            })),
            author: { '@type': 'Person', name: 'Dilyorbek', url: 'https://dilyor.dev' },
            sameAs: ['https://github.com/dilyorm/tunnel-ai'],
          },
          {
            '@type': 'SoftwareSourceCode',
            name: 'tunnel-ai',
            codeRepository: 'https://github.com/dilyorm/tunnel-ai',
            programmingLanguage: 'TypeScript',
            runtimePlatform: 'Node.js 22.13+',
            license: 'https://opensource.org/licenses/MIT',
            targetProduct: { '@id': `${SITE}#app` },
          },
          { '@type': 'FAQPage', mainEntity: questions },
        ],
      };
      // "<" is escaped so no string inside can close the script element early.
      const json = JSON.stringify(graph).replace(/</g, '\\u003c');
      return html.replace('</head>', `  <script type="application/ld+json">${json}</script>\n  </head>`);
    },
    generateBundle() {
      const today = new Date().toISOString().slice(0, 10);
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source:
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          PAGES.filter((page) => !PRIVATE.includes(page))
            .map((page) => `  <url><loc>${SITE}${page === 'index' ? '' : page}</loc><lastmod>${today}</lastmod></url>\n`)
            .join('') +
          '</urlset>\n',
      });
    },
  };
}

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export default defineConfig({
  plugins: [seo()],
  build: {
    rolldownOptions: {
      input: Object.fromEntries(PAGES.map((page) => [page, fileURLToPath(new URL(`./${page}.html`, import.meta.url))])),
    },
  },
  // `npm run dev-relay` in cli/ answers the API here while you work on the account and admin pages.
  server: { proxy: { '/v1': 'http://127.0.0.1:8787' } },
});
