import { module } from '@prisma/composer';
import { cron, defineSchedule } from '@prisma/composer-prisma-cloud/cron';
import { envParam, envSecret, rawPostgres } from '@prisma/composer-prisma-cloud';
import workerService from './src/worker-service.ts';
import botService from './src/service.ts';

const schedule = defineSchedule({ processTelegramUpdates: '10s' });

export default module('hermes-lite-telegram', ({ provision }) => {
  const db = provision(rawPostgres({ name: 'bot-database' }));
  provision(botService, {
    deps: { db },
    input: {
      botToken: envSecret('TELEGRAM_BOT_TOKEN'),
      webhookSecret: envSecret('TELEGRAM_WEBHOOK_SECRET'),
      allowedUsers: envParam('TELEGRAM_ALLOWED_USERS'),
      modelBaseUrl: envParam('MODEL_BASE_URL'),
      modelName: envParam('MODEL_NAME'),
      modelApiKey: envSecret('MODEL_API_KEY'),
      modelSystemPrompt: envParam('BOT_SYSTEM_PROMPT'),
      tavilyApiKey: envSecret('TAVILY_API_KEY'),
    },
  });
  provision(cron({
    schedule,
    runner: workerService,
    input: {
      botToken: envSecret('TELEGRAM_BOT_TOKEN'),
      webhookSecret: envSecret('TELEGRAM_WEBHOOK_SECRET'),
      allowedUsers: envParam('TELEGRAM_ALLOWED_USERS'),
      modelBaseUrl: envParam('MODEL_BASE_URL'),
      modelName: envParam('MODEL_NAME'),
      modelApiKey: envSecret('MODEL_API_KEY'),
      modelSystemPrompt: envParam('BOT_SYSTEM_PROMPT'),
      tavilyApiKey: envSecret('TAVILY_API_KEY'),
    },
  }), { deps: { db } });
});
