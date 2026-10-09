const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_WEBHOOK_URL'];
const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: `${process.env.TELEGRAM_WEBHOOK_URL.trim().replace(/\/$/, '')}/telegram/webhook`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  }),
});
const result = await response.json();
if (!response.ok || !result.ok) {
  console.error(`Telegram setWebhook failed (${response.status}): ${result.description ?? 'unknown error'}`);
  process.exit(1);
}
console.log('Telegram webhook configured.');
