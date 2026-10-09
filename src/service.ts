import node from '@prisma/composer/node';
import { compute, rawPostgres } from '@prisma/composer-prisma-cloud';
import { botInputSchema } from './config.ts';

export default compute({
  name: 'telegram-bot',
  deps: { db: rawPostgres() },
  input: botInputSchema,
  build: node({ module: import.meta.url, entry: '../dist/server.mjs', dependencies: 'external' }),
});
