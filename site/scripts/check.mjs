// Checks the built site in dist/. Run `npm run build` first. Exits 1 with a list of problems.
import { existsSync, readFileSync } from 'node:fs';

const SITE = 'https://tunnel.dilyor.dev/';
// Every page the build must produce (keep in step with vite.config.ts).
const PAGES = ['index', 'terms', 'privacy', 'refund', 'account', 'admin'];
// Signed-in pages: noindex, and never in the sitemap.
const PRIVATE = ['account', 'admin'];

const dist = new URL('../dist/', import.meta.url);
const has = (file) => existsSync(new URL(file, dist));
const read = (file) => readFileSync(new URL(file, dist), 'utf8');
const problems = [];
const expect = (ok, problem) => {
  if (!ok) problems.push(problem);
};

for (const page of PAGES) expect(has(`${page}.html`), `dist/${page}.html is missing`);

if (has('index.html')) {
  const index = read('index.html');
  const blocks = [...index.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  expect(blocks.length === 1, `index.html has ${blocks.length} JSON-LD blocks, expected 1`);
  if (blocks.length === 1) {
    const graph = JSON.parse(blocks[0][1])['@graph'];
    const app = graph.find((node) => node['@type'] === 'SoftwareApplication');
    const prices = [].concat(app?.offers ?? []).map((offer) => offer.price).join(', ');
    expect(prices === '0, 5, 9', `offers are priced [${prices}], expected [0, 5, 9]`);
    const faq = graph.find((node) => node['@type'] === 'FAQPage');
    const shown = index.match(/<details>/g)?.length ?? 0;
    expect(faq?.mainEntity.length === shown, `FAQPage has ${faq?.mainEntity.length} questions, the page shows ${shown}`);
    expect(shown === 10, `the page shows ${shown} questions, expected 10`);
  }
  expect(!/\btrial\b|pay as you go/i.test(index), 'index.html still mentions the trial or pay as you go');
  expect(index.includes('data-account-link'), 'the nav has no Sign in link');
  expect(index.includes('Install tunnel from tunnel.dilyor.dev'), 'the "tell your agent" hint is missing');
  // The plan buttons ship as "Coming soon" (no link); the page turns them into links when the relay has billing.
  for (const plan of ['plus', 'pro']) {
    const button = index.match(new RegExp(`<a\\b[^>]*\\bdata-plan="${plan}"[^>]*>[^<]*</a>`))?.[0];
    expect(button !== undefined, `the ${plan} button is missing`);
    if (button) {
      expect(/>\s*Coming soon\s*</.test(button), `the ${plan} button doesn't say Coming soon`);
      expect(button.includes('aria-disabled="true"'), `the ${plan} button isn't aria-disabled`);
      expect(!/\bhref=/.test(button), `the ${plan} button is a link before the relay has said it sells plans`);
    }
  }
}

for (const page of PAGES.filter((p) => p !== 'index' && has(`${p}.html`))) {
  const html = read(`${page}.html`);
  expect(!html.includes('application/ld+json'), `${page}.html has JSON-LD; only the landing page should`);
  if (PRIVATE.includes(page)) expect(html.includes('<meta name="robots" content="noindex"'), `${page}.html must be noindex`);
  else expect(html.includes(`<link rel="canonical" href="${SITE}${page}"`), `${page}.html has no canonical link`);
}

if (has('sitemap.xml')) {
  const listed = [...read('sitemap.xml').matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  const wanted = PAGES.filter((p) => !PRIVATE.includes(p)).map((p) => SITE + (p === 'index' ? '' : p));
  expect(listed.join(' ') === wanted.join(' '), `sitemap lists [${listed.join(', ')}], expected [${wanted.join(', ')}]`);
} else {
  problems.push('dist/sitemap.xml is missing');
}

const robots = has('robots.txt') ? read('robots.txt').split(/\r?\n/) : [];
for (const path of ['/v1/', '/account', '/admin']) expect(robots.includes(`Disallow: ${path}`), `robots.txt doesn't disallow ${path}`);
expect(has('llms.txt') && read('llms.txt').includes('$5 a month'), 'llms.txt has no pricing');

if (problems.length) {
  console.error(`Site check failed:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Site check passed: ${PAGES.length} pages.`);
