import express from 'express';
import pg from 'pg';
import dns from 'dns/promises';
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
} catch (err) {
  console.error('DB init error:', err.message);
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

  try {
    const result = await pool.query(
      'INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING RETURNING id',
      [email]
    );
    const isNew = result.rowCount > 0;

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
