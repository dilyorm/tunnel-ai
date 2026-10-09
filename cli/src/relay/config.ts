// Which optional features this relay runs. Every feature is off until all of its variables are set,
// so a self-hosted relay with no settings behaves exactly like the plain mailbox.

export type Env = Record<string, string | undefined>;

export interface Features {
  /** Origin of the site and relay, e.g. https://tunnel.dilyor.dev. Accounts need it. */
  publicUrl?: string;
  github?: { clientId: string; clientSecret: string };
  email?: { apiKey: string; from: string };
  billing?: {
    apiKey: string;
    storeId: string;
    webhookSecret: string;
    variants: { plus: string; pro: string };
  };
  /** Lowercased. Non-empty also turns on stats. */
  adminEmails: Set<string>;
  statsSalt?: string;
}

const GROUPS = {
  github: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  email: ['RESEND_API_KEY', 'TUNNEL_EMAIL_FROM'],
  billing: [
    'LEMONSQUEEZY_API_KEY',
    'LEMONSQUEEZY_STORE_ID',
    'LEMONSQUEEZY_WEBHOOK_SECRET',
    'LEMONSQUEEZY_VARIANT_PLUS',
    'LEMONSQUEEZY_VARIANT_PRO',
  ],
} as const;

const LABELS: Record<keyof typeof GROUPS, string> = {
  github: 'GitHub sign-in',
  email: 'Email sign-in',
  billing: 'Billing',
};

export function readFeatures(env: Env, warn: (line: string) => void = () => {}): Features {
  const value = (name: string) => env[name]?.trim() || undefined;

  let publicUrl = value('TUNNEL_PUBLIC_URL')?.replace(/\/+$/, '');
  if (publicUrl && !/^https?:\/\/[^/\s]+$/.test(publicUrl)) {
    warn(`TUNNEL_PUBLIC_URL must look like https://tunnel.example.com, got "${publicUrl}". Accounts are off.`);
    publicUrl = undefined;
  }

  const group = (key: keyof typeof GROUPS): string[] | undefined => {
    const names: readonly string[] = GROUPS[key];
    const values = names.map(value);
    if (values.every((v) => v === undefined)) return undefined;
    const missing = names.filter((_, i) => values[i] === undefined);
    if (missing.length) {
      warn(`${LABELS[key]} is off: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`);
      return undefined;
    }
    if (!publicUrl) {
      warn(`${LABELS[key]} is off: TUNNEL_PUBLIC_URL is not set.`);
      return undefined;
    }
    return values as string[];
  };

  const github = group('github');
  const email = group('email');
  const billing = group('billing');

  const admins = (value('TUNNEL_ADMIN_EMAILS') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (admins.length && !publicUrl) warn('Admin is off: TUNNEL_PUBLIC_URL is not set.');

  return {
    publicUrl,
    github: github && { clientId: github[0], clientSecret: github[1] },
    email: email && { apiKey: email[0], from: email[1] },
    billing: billing && {
      apiKey: billing[0],
      storeId: billing[1],
      webhookSecret: billing[2],
      variants: { plus: billing[3], pro: billing[4] },
    },
    adminEmails: new Set(publicUrl ? admins : []),
    statsSalt: value('TUNNEL_STATS_SALT'),
  };
}
