import express from 'express';
import pg from 'pg';
import dns from 'dns/promises';
import Stripe from 'stripe';
import { Resend } from 'resend';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.RESEND_FROM || 'AegisDial <onboarding@resend.dev>';
const TF_LINK = 'https://testflight.apple.com/join/Hf2tFENW';

// Stripe is optional at boot — the /subscribe page renders fine without
// it and falls back to TestFlight + iOS IAP via the "stripe_not_configured"
// branch in the checkout endpoint. Once Jesiah pastes STRIPE_SECRET_KEY +
// the four STRIPE_PRICE_* vars on Railway, this lights up automatically.
// No code change needed on cutover day.
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : null;
const STRIPE_PRICES = {
  pro_annual:        process.env.STRIPE_PRICE_PRO_ANNUAL || null,
  recovery_session:  process.env.STRIPE_PRICE_RECOVERY_SESSION || null,
  recovery_monthly:  process.env.STRIPE_PRICE_RECOVERY_MONTHLY || null,
  recovery_annual:   process.env.STRIPE_PRICE_RECOVERY_ANNUAL || null,
};
// Which plans are subscriptions vs one-time. Wrong mode is a 400 from
// Stripe at session-create time — keep the mapping single-sourced here.
const STRIPE_MODES = {
  pro_annual:        'subscription',
  recovery_session:  'payment',
  recovery_monthly:  'subscription',
  recovery_annual:   'subscription',
};

// Block obvious throwaway / disposable domains
const DISPOSABLE = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'tempmail.com',
  'temp-mail.org', 'throwaway.email', 'trashmail.com', 'yopmail.com',
  'fakeinbox.com', 'getnada.com', 'maildrop.cc', 'sharklasers.com',
  'dispostable.com', 'mintemail.com', 'mohmal.com',
]);

// Quick DNS MX check — proves the domain can actually receive email.
// Catches fakes like "test@notarealdomain.xyz" and typos like "@gmial.com".
async function domainCanReceiveMail(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  if (DISPOSABLE.has(domain)) return false;
  try {
    const mx = await dns.resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    // Some domains use only A records for mail (rare but valid).
    try {
      await dns.resolve(domain);
      return false; // No MX = effectively not a mailable domain in 2026.
    } catch {
      return false;
    }
  }
}

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // 2026-05-12 — additive columns so paid-ad UTM tracking + the
  // developer-portal "API access" form can tag signups without forking
  // the table. Existing rows backfill to NULL which is fine for analytics.
  await pool.query(
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS source TEXT`,
  );
  await pool.query(
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS utm_source TEXT`,
  );
  await pool.query(
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS utm_medium TEXT`,
  );
  await pool.query(
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS utm_campaign TEXT`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS waitlist_source_idx ON waitlist (source)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS waitlist_utm_campaign_idx ON waitlist (utm_campaign)`,
  );
} catch (err) {
  console.error('DB init error:', err.message);
}

// Length cap on free-text tracking fields so a bad caller can't blow up
// the table. UTM standard values are <50 chars; we leave headroom.
function clampTag(v, max = 120) {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : null;
}

function waitlistEmail(email) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#0A0E14;border-radius:20px;border:1px solid #1F2832;overflow:hidden;">

        <!-- Header -->
        <tr><td style="padding:40px 40px 32px;text-align:center;border-bottom:1px solid #1F2832;">
          <table cellpadding="0" cellspacing="0" style="margin:0 auto 18px;">
            <tr><td style="width:64px;height:64px;border-radius:18px;overflow:hidden;text-align:center;vertical-align:middle;">
              <img src="https://aegisdial-web-production.up.railway.app/icon.png" width="64" height="64" alt="AegisDial" style="display:block;border-radius:18px;" />
            </td></tr>
          </table>
          <p style="margin:0;font-size:13px;font-weight:600;letter-spacing:2px;color:#6A7480;text-transform:uppercase;">AegisDial</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:40px;">
          <h1 style="margin:0 0 10px;font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.8px;">You're on the list.</h1>
          <p style="margin:0 0 28px;font-size:16px;color:#B8C2CC;line-height:1.65;">
            Thanks for signing up. AegisDial is an on-device AI that protects you from phone scams, suspicious texts, and dark-web breaches — privately, on your iPhone.
          </p>

          <!-- TestFlight CTA -->
          <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:32px;">
            <tr><td align="center" style="background:#1FE08A;border-radius:14px;">
              <a href="${TF_LINK}" style="display:block;padding:16px 24px;font-size:16px;font-weight:700;color:#000000;text-decoration:none;letter-spacing:-0.2px;">
                Try AegisDial on TestFlight →
              </a>
            </td></tr>
          </table>

          <!-- Features -->
          <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:32px;">
            <tr>
              <td style="padding:16px;background:#12181F;border-radius:12px;border:1px solid #1F2832;vertical-align:top;">
                <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#1FE08A;">Live Shield</p>
                <p style="margin:0;font-size:13px;color:#6A7480;line-height:1.5;">AI scores suspicious calls in real time while you're on the phone.</p>
              </td>
            </tr>
            <tr><td style="height:10px;"></td></tr>
            <tr>
              <td style="padding:16px;background:#12181F;border-radius:12px;border:1px solid #1F2832;vertical-align:top;">
                <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#1FE08A;">SMS Filter</p>
                <p style="margin:0;font-size:13px;color:#6A7480;line-height:1.5;">Paste any suspicious text. Get a plain-English verdict in seconds.</p>
              </td>
            </tr>
            <tr><td style="height:10px;"></td></tr>
            <tr>
              <td style="padding:16px;background:#12181F;border-radius:12px;border:1px solid #1F2832;vertical-align:top;">
                <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#1FE08A;">Breach Monitor</p>
                <p style="margin:0;font-size:13px;color:#6A7480;line-height:1.5;">Know if your email or phone appeared in dark-web data leaks.</p>
              </td>
            </tr>
          </table>

          <!-- Privacy -->
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr><td style="padding:14px 16px;background:rgba(31,224,138,0.06);border-radius:10px;border:1px solid rgba(31,224,138,0.2);">
              <p style="margin:0;font-size:12px;color:#6A7480;line-height:1.6;">
                🔒 All analysis stays on your device. We never see your calls, texts, or personal data.
              </p>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 40px;border-top:1px solid #1F2832;text-align:center;">
          <p style="margin:0 0 6px;font-size:12px;color:#6A7480;">
            © 2026 AegisDial · <a href="https://aegisdial-web-production.up.railway.app/privacy" style="color:#6A7480;text-decoration:underline;">Privacy</a> · <a href="https://aegisdial-web-production.up.railway.app/terms" style="color:#6A7480;text-decoration:underline;">Terms</a>
          </p>
          <p style="margin:0;font-size:11px;color:#3A4048;">You're receiving this because you signed up at aegisdial.com</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Pretty URLs for legal pages — the iOS app + landing footer point at
// /privacy and /terms, no .html. Without these routes Express's static
// middleware falls through to a 404 because it only matches exact
// filenames. App Store review requires working privacy + terms URLs.
app.get('/privacy', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'privacy.html'));
});
app.get('/terms', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'terms.html'));
});
app.get('/support', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'support.html'));
});
// B2B / enterprise API portal — separate page from the consumer
// waitlist. Same /waitlist endpoint POST but with source='api_waitlist'
// so we can tell enterprise leads apart in CSV exports.
app.get('/developers', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'developers.html'));
});
// Consumer Stripe subscribe page (Jesiah's issue #11). Renders the
// three locked tiers and hands off to Stripe Checkout via the JSON
// endpoint below. Pre-Stripe-cutover the page falls back to TestFlight
// + iOS IAP — see /api/subscribe/checkout for the gating.
app.get('/subscribe', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'subscribe.html'));
});

// POST /api/subscribe/checkout
//   body: { plan: 'pro_annual'|'recovery_session'|'recovery_monthly'|'recovery_annual',
//           utm?: { utm_source, utm_medium, utm_campaign } }
// Returns: { url } on success (Stripe-hosted checkout), or
//          { error: 'stripe_not_configured' } when env vars aren't set
//          yet — the client falls back to TestFlight in that case.
app.post('/api/subscribe/checkout', async (req, res) => {
  const plan = String(req.body?.plan || '');
  const priceId = STRIPE_PRICES[plan];
  const mode = STRIPE_MODES[plan];

  if (!stripe || !priceId || !mode) {
    // Pre-launch state — Stripe env vars not set yet. The client
    // bounces to TestFlight in this branch; we return 200 so we
    // don't pollute error monitoring during the rollout window.
    return res.status(200).json({ error: 'stripe_not_configured' });
  }

  const utm = req.body?.utm || {};
  const success = `${req.protocol}://${req.get('host')}/subscribe?status=success&plan=${encodeURIComponent(plan)}`;
  const cancel  = `${req.protocol}://${req.get('host')}/subscribe?status=cancelled`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: success,
      cancel_url: cancel,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      // Metadata follows the cart through to the eventual webhook
      // (we'll wire that next once price IDs are confirmed live).
      // Stripe caps each metadata value at 500 chars; clampTag keeps
      // us well under without truncating real UTM values.
      metadata: {
        plan,
        utm_source:   clampTag(utm.utm_source)   ?? '',
        utm_medium:   clampTag(utm.utm_medium)   ?? '',
        utm_campaign: clampTag(utm.utm_campaign) ?? '',
      },
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return res.status(500).json({
      error: 'checkout_failed',
      message: 'Couldn\'t start checkout. Please try again or email support@aegisdial.com.',
    });
  }
});

// Admin endpoints, basic-auth gated on WEB_ADMIN_PASSWORD. Lets us
// pull the waitlist count + paid-ad attribution without hitting Railway
// directly. Without the env var the routes 503 — fail-closed.
function adminAuth(req, res, next) {
  const expected = process.env.WEB_ADMIN_PASSWORD;
  if (!expected) {
    return res.status(503).json({ error: 'admin_disabled' });
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="AegisDial Admin"');
    return res.status(401).end();
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const pw = decoded.split(':').slice(1).join(':');
  if (pw !== expected) {
    res.setHeader('WWW-Authenticate', 'Basic realm="AegisDial Admin"');
    return res.status(401).end();
  }
  next();
}

app.get('/admin/waitlist', adminAuth, async (_req, res) => {
  try {
    const total = await pool.query(`SELECT COUNT(*)::INT AS n FROM waitlist`);
    const bySource = await pool.query(
      `SELECT COALESCE(source, '(none)') AS source, COUNT(*)::INT AS n
         FROM waitlist GROUP BY source ORDER BY n DESC`,
    );
    const recent = await pool.query(
      `SELECT email, source, utm_source, utm_medium, utm_campaign, created_at
         FROM waitlist ORDER BY created_at DESC LIMIT 100`,
    );
    res.json({
      total: total.rows[0]?.n ?? 0,
      by_source: bySource.rows,
      recent: recent.rows,
    });
  } catch (err) {
    console.error('Waitlist admin error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/admin/waitlist/export', adminAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT email, source, utm_source, utm_medium, utm_campaign, created_at
         FROM waitlist ORDER BY created_at DESC`,
    );
    const csv = ['email,source,utm_source,utm_medium,utm_campaign,created_at'];
    for (const row of r.rows) {
      const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
      csv.push([
        esc(row.email),
        esc(row.source),
        esc(row.utm_source),
        esc(row.utm_medium),
        esc(row.utm_campaign),
        esc(row.created_at?.toISOString()),
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="aegisdial-waitlist.csv"');
    res.send(csv.join('\n'));
  } catch (err) {
    console.error('Waitlist export error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/waitlist', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  // Verify the domain actually exists and accepts email.
  const reachable = await domainCanReceiveMail(email);
  if (!reachable) {
    return res.status(400).json({ error: 'email_not_found' });
  }

  // Optional attribution. `source` is the high-level bucket ('landing_page',
  // 'api_waitlist', 'subscribe_intent'); `utm_*` are the standard ad-platform
  // fields. All clamped + NULL when missing. On a returning email (ON
  // CONFLICT DO NOTHING) we still want to backfill source/UTM on the
  // existing row so we don't lose attribution from a return visit — hence
  // the COALESCE-style UPDATE in the conflict path.
  const source = clampTag(req.body.source);
  const utmSource = clampTag(req.body.utm_source);
  const utmMedium = clampTag(req.body.utm_medium);
  const utmCampaign = clampTag(req.body.utm_campaign);

  try {
    const result = await pool.query(
      `INSERT INTO waitlist (email, source, utm_source, utm_medium, utm_campaign)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         source       = COALESCE(waitlist.source,       EXCLUDED.source),
         utm_source   = COALESCE(waitlist.utm_source,   EXCLUDED.utm_source),
         utm_medium   = COALESCE(waitlist.utm_medium,   EXCLUDED.utm_medium),
         utm_campaign = COALESCE(waitlist.utm_campaign, EXCLUDED.utm_campaign)
       RETURNING (xmax = 0) AS is_new`,
      [email, source, utmSource, utmMedium, utmCampaign],
    );
    const isNew = result.rows[0]?.is_new === true;

    if (isNew) {
      const sendRes = await resend.emails.send({
        from: FROM,
        to: email,
        subject: "You're on the AegisDial waitlist",
        html: waitlistEmail(email),
      }).catch(err => {
        console.error('Email send error:', err.message);
        return { error: err };
      });
      if (sendRes?.error) {
        console.error('Resend response error:', JSON.stringify(sendRes.error));
      } else {
        console.log('Email sent to', email, 'id:', sendRes?.data?.id);
      }
    }

    res.json({ ok: true, new: isNew });
  } catch (err) {
    console.error('Waitlist insert error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.listen(port, () => {
  console.log(`AegisDial web running on port ${port}`);
});
