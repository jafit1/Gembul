import { Pool } from 'pg';
import { readBotConfig } from './config.ts';
import { listenHttp } from './http-server.ts';
import service from './service.ts';

type TelegramUpdate = {
  update_id: number;
  message?: { message_id: number; date: number; text?: string; chat?: { id?: number; type?: string }; from?: { id?: number; is_bot?: boolean } };
};

const { db } = service.load();
const config = readBotConfig(service.input());
const webhookUrl = `${service.origin().replace(/\/$/, '')}/telegram/webhook`;
const pool = new Pool({
  connectionString: db.url,
  max: 1,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 8_000,
  ssl: { rejectUnauthorized: true },
});

let schemaReady: Promise<void> | undefined;
function ensureSchema() {
  schemaReady ??= (async () => {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS hermes_lite_chats (
      chat_id TEXT PRIMARY KEY,
      history JSONB NOT NULL DEFAULT '[]'::jsonb,
      memory TEXT NOT NULL DEFAULT '',
      todos JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`
    CREATE TABLE IF NOT EXISTS hermes_lite_updates (
      update_id BIGINT PRIMARY KEY,
      payload JSONB NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  })().catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

async function queueUpdate(update: TelegramUpdate) {
  await pool.query(
    `INSERT INTO hermes_lite_updates(update_id, payload) VALUES ($1, $2::jsonb)
     ON CONFLICT(update_id) DO NOTHING`,
    [update.update_id, JSON.stringify(update)],
  );
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/healthz' && request.method === 'GET') return new Response('ok');
  if (url.pathname !== '/telegram/webhook' || request.method !== 'POST') return new Response('not found', { status: 404 });
  if (request.headers.get('x-telegram-bot-api-secret-token') !== config.webhookSecret) return new Response('unauthorized', { status: 401 });
  try {
    if (Number(request.headers.get('content-length') ?? 0) > 1_000_000) return new Response('payload too large', { status: 413 });
    const update = await request.json() as TelegramUpdate;
    if (!Number.isSafeInteger(update.update_id)) return new Response('bad request', { status: 400 });
    const message = update.message;
    if (message?.chat?.type === 'private' && message.text && message.chat.id !== undefined && message.from?.id !== undefined) {
      const userId = String(message.from.id);
      if (config.allowedUsers.has(userId) && message.from.id === message.chat.id && !message.from.is_bot) {
        await ensureSchema();
        await queueUpdate(update);
      }
    }
    return new Response('ok', { status: 200 });
  } catch (error) {
    console.error('Telegram webhook enqueue failed', error);
    return new Response('temporary error', { status: 503 });
  }
}

process.on('uncaughtException', (error) => console.error('uncaughtException', error));
process.on('unhandledRejection', (error) => console.error('unhandledRejection', error));

listenHttp(service.port(), route);
console.log(`Hermes-Lite Telegram webhook listening on ${service.port()}`);

fetch(`https://api.telegram.org/bot${config.botToken}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: config.webhookSecret,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  }),
  signal: AbortSignal.timeout(10_000),
}).then(async (response) => {
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) throw new Error(`Telegram setWebhook ${response.status}: ${result.description ?? ''}`);
  console.log(`Telegram webhook registered at ${webhookUrl}`);
}).catch((error) => console.error('Telegram webhook registration failed; it will retry at the next service start', error));
