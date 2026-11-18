import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { isNoteId, MAX_CONTENT_LENGTH } from '@typo/core';
import type { NoteService } from './notes.js';

export function createHttpApp(notes: NoteService, allowedOrigins: string[]) {
  const app = new Hono<{ Variables: { jsonBody: Record<string, unknown> } }>();
  app.use(
    '/api/*',
    cors({
      origin: allowedOrigins,
      allowMethods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    }),
  );
  const limitJsonBody = bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) =>
      c.json({ error: '请求正文过大' }, 413, { Connection: 'close' }),
  });
  const parseJsonBody = createMiddleware<{
    Variables: { jsonBody: Record<string, unknown> };
  }>(async (c, next) => {
    let body: Record<string, unknown> = {};
    const contentType = c.req.header('content-type')?.split(';')[0].trim();
    if (contentType?.toLowerCase() === 'application/json') {
      const raw = await c.req.text();
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object')
            return c.json({ error: '请求正文必须是 JSON 对象' }, 400);
          body = parsed as Record<string, unknown>;
        } catch {
          return c.json({ error: '请求正文不是有效的 JSON' }, 400);
        }
      }
    }
    c.set('jsonBody', body);
    await next();
  });
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/notes', (c) => c.json(notes.list()));
  app.post('/api/notes', limitJsonBody, parseJsonBody, async (c) => {
    const { title = '未命名文档', content = '' } = c.get('jsonBody');
    if (
      typeof title !== 'string' ||
      typeof content !== 'string' ||
      content.length > MAX_CONTENT_LENGTH
    ) {
      return c.json({ error: '标题或正文格式错误，正文最多 100 万字符' }, 400);
    }
    return c.json(await notes.create(title, content), 201);
  });
  app.use('/api/notes/:id', async (c, next) => {
    const id = c.req.param('id');
    if (!isNoteId(id) || !notes.has(id)) {
      return c.json({ error: '文档不存在' }, 404);
    }
    await next();
  });
  app.patch('/api/notes/:id', limitJsonBody, parseJsonBody, async (c) => {
    const { title } = c.get('jsonBody');
    if (typeof title !== 'string') {
      return c.json({ error: '标题必须是字符串' }, 400);
    }
    const note = await notes.rename(c.req.param('id'), title);
    return note ? c.json(note) : c.json({ error: '文档不存在' }, 404);
  });
  app.delete('/api/notes/:id', async (c) => {
    const deleted = await notes.remove(c.req.param('id'));
    return deleted
      ? c.json({ ok: true })
      : c.json({ error: '文档不存在' }, 404);
  });
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: '服务器请求失败' }, 500);
  });
  return app;
}
