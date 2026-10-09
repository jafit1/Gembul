import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export function listenHttp(port: number, handler: (request: Request) => Promise<Response> | Response) {
  const server = createServer(async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    try {
      const host = incoming.headers.host ?? 'localhost';
      const body = incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : Readable.toWeb(incoming) as ReadableStream;
      const request = new Request(new URL(incoming.url ?? '/', `http://${host}`), {
        method: incoming.method,
        headers: incoming.headers as HeadersInit,
        body,
        ...(body ? { duplex: 'half' } : {}),
      } as RequestInit);
      const response = await handler(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      if (!response.body || incoming.method === 'HEAD') {
        outgoing.end();
      } else {
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(outgoing);
      }
    } catch (error) {
      console.error('HTTP handler failed', error);
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500;
        outgoing.end('internal server error');
      } else {
        outgoing.destroy(error instanceof Error ? error : undefined);
      }
    }
  });
  server.listen(port, '0.0.0.0');
  return server;
}
