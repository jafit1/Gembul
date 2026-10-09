import { serveSchedule } from '@prisma/composer-prisma-cloud/cron';
import { Pool } from 'pg';
import service, { schedule } from './worker-service.ts';
import { processUpdate } from './worker-turn.ts';
import { readBotConfig } from './config.ts';
import { listenHttp } from './http-server.ts';

const { db } = service.load();
const config = readBotConfig(service.input());
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
      chat_id TEXT PRIMARY KEY, history JSONB NOT NULL DEFAULT '[]'::jsonb,
      memory TEXT NOT NULL DEFAULT '', todos JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`
    CREATE TABLE IF NOT EXISTS hermes_lite_updates (
      update_id BIGINT PRIMARY KEY, payload JSONB NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  })().catch((error) => { schemaReady = undefined; throw error; });
  return schemaReady;
}

const handler = serveSchedule(service, schedule, {
  processTelegramUpdates: async () => {
    await ensureSchema();
    const claimClient = await pool.connect();
    let rows;
    try {
      await claimClient.query('BEGIN');
      const result = await claimClient.query(
        `SELECT update_id, payload FROM hermes_lite_updates
         WHERE state='queued' OR (state='processing' AND updated_at < NOW() - INTERVAL '2 minutes')
         ORDER BY update_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      rows = result.rows;
      if (rows.length) {
        const ids = rows.map((row) => row.update_id);
        await claimClient.query(
          `UPDATE hermes_lite_updates SET state='processing', attempts=attempts+1, updated_at=NOW()
           WHERE update_id = ANY($1::bigint[])`, [ids],
        );
      }
      await claimClient.query('COMMIT');
    } catch (error) {
      await claimClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { claimClient.release(); }

    let processed = 0;
    for (const row of rows) {
      const updateId = Number(row.update_id);
      const work = await pool.connect();
      try {
        const update = row.payload as Parameters<typeof processUpdate>[1];
        await processUpdate(work, update, config);
        await work.query(`UPDATE hermes_lite_updates SET state='done', payload='{}'::jsonb, updated_at=NOW() WHERE update_id=$1`, [updateId]);
        processed++;
      } catch (error) {
        console.error('failed Telegram update; it will retry', updateId, error);
        await work.query(`UPDATE hermes_lite_updates SET state='queued', updated_at=NOW() WHERE update_id=$1`, [updateId]).catch(() => undefined);
      } finally { work.release(); }
    }
    return { ok: true, processed };
  },
});

listenHttp(service.port(), handler);
console.log(`Hermes-Lite durable Telegram worker listening on ${service.port()}`);
