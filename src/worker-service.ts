import node from '@prisma/composer/node';
import { compute, rawPostgres } from '@prisma/composer-prisma-cloud';
import { contract, rpc } from '@prisma/composer/service-rpc';
import { type } from 'arktype';
import { botInputSchema } from './config.ts';
import { defineSchedule } from '@prisma/composer-prisma-cloud/cron';

export const schedule = defineSchedule({ processTelegramUpdates: '10s' });

export const workerContract = contract({
  trigger: rpc({ input: type({ jobId: 'string' }), output: type({ ok: 'boolean' }) }),
});

export default compute({
  name: 'telegram-worker',
  deps: { db: rawPostgres() },
  input: botInputSchema,
  build: node({ module: import.meta.url, entry: '../dist/worker-server.mjs' }),
  expose: { trigger: workerContract },
});
