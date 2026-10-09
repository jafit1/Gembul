import type { PoolClient } from 'pg';
import type { BotConfig } from './config.ts';

type HistoryItem = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};
type TodoItem = { id: number; text: string; done: boolean };
type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { id?: number; is_bot?: boolean; first_name?: string; username?: string };
  };
};
type ChatState = { history: HistoryItem[]; memory: string; todos: TodoItem[] };

async function telegram(config: BotConfig, method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(7_000),
  });
  const data = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method}: ${response.status} ${data.description ?? ''}`);
}

async function sendText(config: BotConfig, chatId: number, text: string) {
  const value = text.trim() || 'Agent selesai tanpa teks jawaban.';
  const clipped = value.length > 3500 ? `${value.slice(0, 3460).trimEnd()}\n\n[Jawaban dipotong.]` : value;
  await telegram(config, 'sendMessage', { chat_id: chatId, text: clipped });
}

async function loadChat(client: PoolClient, chatId: string): Promise<ChatState> {
  await client.query('INSERT INTO hermes_lite_chats(chat_id) VALUES ($1) ON CONFLICT DO NOTHING', [chatId]);
  const result = await client.query('SELECT history, memory, todos FROM hermes_lite_chats WHERE chat_id=$1', [chatId]);
  return {
    history: result.rows[0].history as HistoryItem[],
    memory: result.rows[0].memory as string,
    todos: result.rows[0].todos as TodoItem[],
  };
}

async function saveChat(client: PoolClient, chatId: string, state: ChatState) {
  let history = state.history.slice(-80);
  while (history.length && history[0].role !== 'user') history = history.slice(1);
  while (history.length > 2 && Buffer.byteLength(JSON.stringify(history), 'utf8') > 700_000) {
    history = history.slice(2);
    while (history.length && history[0].role !== 'user') history = history.slice(1);
  }
  await client.query(
    `INSERT INTO hermes_lite_chats(chat_id, history, memory, todos, updated_at)
     VALUES ($1, $2::jsonb, $3, $4::jsonb, NOW())
     ON CONFLICT(chat_id) DO UPDATE SET history=EXCLUDED.history, memory=EXCLUDED.memory, todos=EXCLUDED.todos, updated_at=NOW()`,
    [chatId, JSON.stringify(history), state.memory.slice(-8000), JSON.stringify(state.todos.slice(-100))],
  );
}

function tools(config: BotConfig): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [
    { type: 'function', function: { name: 'memory_read', description: 'Read durable facts for this private user.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
    { type: 'function', function: { name: 'memory_add', description: 'Save one concise durable fact or preference.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } },
    { type: 'function', function: { name: 'todo_list', description: 'Read saved tasks.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
    { type: 'function', function: { name: 'todo_add', description: 'Add one saved task.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } },
    { type: 'function', function: { name: 'todo_complete', description: 'Mark a task complete by id.', parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } } },
  ];
  if (config.tavilyApiKey) {
    result.push({ type: 'function', function: { name: 'web_search', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } });
    result.push({ type: 'function', function: { name: 'web_extract', description: 'Extract page text from URLs.', parameters: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' }, maxItems: 3 } }, required: ['urls'], additionalProperties: false } } });
  }
  return result;
}

async function callTool(name: string, args: Record<string, unknown>, state: ChatState, config: BotConfig): Promise<string> {
  switch (name) {
    case 'memory_read': return state.memory || '(memory kosong)';
    case 'memory_add': {
      const fact = String(args.text ?? '').trim().slice(0, 1000);
      if (!fact) return 'Tidak menyimpan memory kosong.';
      const facts = state.memory.split('\n').filter(Boolean);
      if (!facts.includes(fact)) facts.push(fact);
      state.memory = facts.slice(-30).join('\n');
      return `Tersimpan: ${fact}`;
    }
    case 'todo_list': return JSON.stringify(state.todos);
    case 'todo_add': {
      const text = String(args.text ?? '').trim().slice(0, 500);
      if (!text) return 'Task kosong.';
      const item = { id: (state.todos.at(-1)?.id ?? 0) + 1, text, done: false };
      state.todos.push(item);
      return JSON.stringify(item);
    }
    case 'todo_complete': {
      const item = state.todos.find((task) => task.id === Number(args.id));
      if (!item) return 'Task tidak ditemukan.';
      item.done = true;
      return JSON.stringify(item);
    }
    case 'web_search':
    case 'web_extract': {
      if (!config.tavilyApiKey) return 'Web search tidak dikonfigurasi.';
      const endpoint = name === 'web_search' ? 'search' : 'extract';
      const params = name === 'web_search' ? { query: String(args.query ?? ''), max_results: 5, include_answer: true } : { urls: Array.isArray(args.urls) ? args.urls.slice(0, 3) : [] };
      const response = await fetch(`https://api.tavily.com/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...params, api_key: config.tavilyApiKey }), signal: AbortSignal.timeout(5_000),
      });
      const body = await response.text();
      return response.ok ? body.slice(0, 14_000) : `Tavily ${response.status}: ${body.slice(0, 400)}`;
    }
    default: return `Tool tidak dikenal: ${name}`;
  }
}

async function runModel(state: ChatState, text: string, config: BotConfig): Promise<string> {
  state.history.push({ role: 'user', content: text.slice(0, 12_000) });
  for (let turn = 0; turn < 3; turn++) {
    const system = `${config.modelSystemPrompt}\n\nDurable memory:\n${state.memory || '(empty)'}\n\nTodos:\n${JSON.stringify(state.todos)}`;
    const response = await fetch(`${config.modelBaseUrl}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${config.modelApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.modelName, messages: [{ role: 'system', content: system }, ...state.history], tools: tools(config), tool_choice: 'auto' }),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Model API ${response.status}: ${raw.slice(0, 700)}`);
    const payload = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: NonNullable<HistoryItem['tool_calls']> } }> };
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error('Model returned no message');
    if (message.tool_calls?.length) {
      state.history.push({ role: 'assistant', content: message.content ?? '', tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>; } catch { /* report parse failure below */ }
        let content = '';
        try { content = await callTool(call.function.name, args, state, config); }
        catch (error) { content = `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
        state.history.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content });
      }
      continue;
    }
    const answer = message.content?.trim() || 'Agent selesai tanpa teks jawaban.';
    state.history.push({ role: 'assistant', content: answer });
    return answer;
  }
  const answer = 'Batas tool-call tercapai. Kirim pesan lanjutan untuk meneruskan.';
  state.history.push({ role: 'assistant', content: answer });
  return answer;
}

export async function processUpdate(client: PoolClient, update: TelegramUpdate, config: ReturnType<typeof import('./config.ts').readBotConfig>) {
  const message = update.message;
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  const text = message?.text?.trim();
  if (!message || !chatId || !userId || message.from?.is_bot || message.chat?.type !== 'private' || !text) return;
  if (!config.allowedUsers.has(String(userId))) return;

  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO hermes_lite_chats(chat_id) VALUES ($1) ON CONFLICT DO NOTHING', [String(chatId)]);
    await client.query('SELECT chat_id FROM hermes_lite_chats WHERE chat_id=$1 FOR UPDATE', [String(chatId)]);
    const result = await client.query('SELECT history, memory, todos FROM hermes_lite_chats WHERE chat_id=$1', [String(chatId)]);
    const state: ChatState = {
      history: result.rows[0].history as HistoryItem[],
      memory: result.rows[0].memory as string,
      todos: result.rows[0].todos as TodoItem[],
    };
    let answer: string;
    if (text === '/new' || text.startsWith('/new@')) {
      state.history = [];
      answer = 'Percakapan baru dimulai. Memory dan todo tetap tersimpan.';
    } else if (['/start', '/help'].some((command) => text === command || text.startsWith(`${command}@`))) {
      answer = 'Hermes-Lite aktif. Kirim pesan untuk chat. Perintah: /new, /status, /help.';
    } else if (text === '/status' || text.startsWith('/status@')) {
      answer = `Hermes-Lite aktif\nModel: ${config.modelName}\nWeb search: ${config.tavilyApiKey ? 'aktif' : 'nonaktif'}`;
    } else {
      answer = await runModel(state, text, config);
    }
    let history = state.history.slice(-80);
    while (history.length && history[0].role !== 'user') history = history.slice(1);
    await client.query(
      `UPDATE hermes_lite_chats SET history=$2::jsonb, memory=$3, todos=$4::jsonb, updated_at=NOW() WHERE chat_id=$1`,
      [String(chatId), JSON.stringify(history), state.memory.slice(-8000), JSON.stringify(state.todos.slice(-100))],
    );

    const response = answer.length > 3500 ? `${answer.slice(0, 3460).trimEnd()}\n\n[Jawaban dipotong.]` : answer;
      await telegramSend(config, chatId, response);
      await client.query("UPDATE hermes_lite_updates SET payload='{}'::jsonb WHERE update_id=$1", [update.update_id]);
      await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function telegramSend(config: ReturnType<typeof import('./config.ts').readBotConfig>, chatId: number, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(7_000),
  });
  const payload = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !payload.ok) throw new Error(`Telegram sendMessage ${response.status}: ${payload.description ?? ''}`);
}
