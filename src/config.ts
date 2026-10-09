import { secretString } from '@prisma/composer/arktype';
import { type } from 'arktype';

export const botInputSchema = type({
  botToken: secretString(),
  webhookSecret: secretString(),
  allowedUsers: 'string',
  modelBaseUrl: 'string',
  modelName: 'string',
  modelApiKey: secretString(),
  'modelSystemPrompt?': 'string',
  'tavilyApiKey?': secretString(),
});

export type BotConfig = {
  botToken: string;
  webhookSecret: string;
  allowedUsers: Set<string>;
  modelBaseUrl: string;
  modelName: string;
  modelApiKey: string;
  modelSystemPrompt: string;
  tavilyApiKey?: string;
};

export function readBotConfig(input: typeof botInputSchema.infer): BotConfig {
  return {
    botToken: input.botToken.expose(),
    webhookSecret: input.webhookSecret.expose(),
    allowedUsers: new Set(input.allowedUsers.split(',').map((id) => id.trim()).filter(Boolean)),
    modelBaseUrl: input.modelBaseUrl.replace(/\/+$/, ''),
    modelName: input.modelName,
    modelApiKey: input.modelApiKey.expose(),
    modelSystemPrompt: input.modelSystemPrompt ?? 'You are Hermes-Lite, a concise personal assistant. Use tools for durable memory, todo tracking, and optional web search.',
    tavilyApiKey: input.tavilyApiKey?.expose(),
  };
}
