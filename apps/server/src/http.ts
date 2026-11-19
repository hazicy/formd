import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { randomUUID } from 'node:crypto';
import {
  isFolderId,
  isNoteId,
  MAX_CONTENT_LENGTH,
  MAX_TITLE_LENGTH,
} from '@formd/core';
import { StorageConflict, type NoteStore } from './storage/index.js';
import type { NoteService } from './notes.js';

export function createHttpApp(
  notes: NoteService,
  store: NoteStore,
  allowedOrigins: string[],
) {
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
  app.get('/api/folders', async (c) => c.json(await store.listFolders()));
  app.post('/api/folders', limitJsonBody, parseJsonBody, async (c) => {
    const { name, parentId = null } = c.get('jsonBody');
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > MAX_TITLE_LENGTH ||
      (parentId !== null && !isFolderId(parentId))
    ) {
      return c.json({ error: '无效的文件夹名称或父目录' }, 400);
    }
    const now = new Date().toISOString();
    return c.json(
      await store.createFolder({
        id: randomUUID(),
        name: name.trim(),
        parentId,
        createdAt: now,
        updatedAt: now,
      }),
      201,
    );
  });
  app.patch('/api/folders/:id', limitJsonBody, parseJsonBody, async (c) => {
    const id = c.req.param('id');
    const { name, parentId } = c.get('jsonBody');
    if (!isFolderId(id)) return c.json({ error: '文件夹不存在' }, 404);
    if (
      (name === undefined && parentId === undefined) ||
      (name !== undefined &&
        (typeof name !== 'string' ||
          !name.trim() ||
          name.trim().length > MAX_TITLE_LENGTH)) ||
      (parentId !== undefined && parentId !== null && !isFolderId(parentId))
    ) {
      return c.json({ error: '无效的文件夹名称或父目录' }, 400);
    }
    return c.json(
      await store.updateFolder(id, {
        ...(name === undefined ? {} : { name: name.trim() }),
        ...(parentId === undefined ? {} : { parentId }),
      }),
    );
  });
  app.delete('/api/folders/:id', async (c) => {
    const id = c.req.param('id');
    if (!isFolderId(id)) return c.json({ error: '文件夹不存在' }, 404);
    const parentId = await notes.deleteFolder(id);
    return c.json({ ok: true, parentId });
  });
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/notes', (c) => c.json(notes.list()));
  app.get('/api/comment-inbox', (c) => {
    const name = c.req.query('name')?.trim();
    if (!name || name.length > 48) return c.json({ error: '显示名称无效' }, 400);
    return c.json(notes.commentInbox(name));
  });
  app.post('/api/notes', limitJsonBody, parseJsonBody, async (c) => {
    const {
      title = '未命名文档',
      content = '',
      folderId = null,
    } = c.get('jsonBody');
    if (
      typeof title !== 'string' ||
      typeof content !== 'string' ||
      content.length > MAX_CONTENT_LENGTH ||
      (folderId !== null && !isFolderId(folderId))
    ) {
      return c.json({ error: '标题或正文格式错误，正文最多 100 万字符' }, 400);
    }
    return c.json(await notes.create(title, content, folderId), 201);
  });
  app.use('/api/notes/:id', async (c, next) => {
    const id = c.req.param('id');
    if (!isNoteId(id) || !notes.has(id)) {
      return c.json({ error: '文档不存在' }, 404);
    }
    await next();
  });
  app.patch('/api/notes/:id', limitJsonBody, parseJsonBody, async (c) => {
    const { title, folderId } = c.get('jsonBody');
    if (
      (title === undefined && folderId === undefined) ||
      (title !== undefined && typeof title !== 'string') ||
      (folderId !== undefined && folderId !== null && !isFolderId(folderId))
    ) {
      return c.json({ error: '无效的标题或目录' }, 400);
    }
    const note = await notes.update(c.req.param('id'), {
      ...(title === undefined ? {} : { title }),
      ...(folderId === undefined ? {} : { folderId }),
    });
    return note ? c.json(note) : c.json({ error: '文档不存在' }, 404);
  });
  app.delete('/api/notes/:id', async (c) => {
    const deleted = await notes.remove(c.req.param('id'));
    return deleted
      ? c.json({ ok: true })
      : c.json({ error: '文档不存在' }, 404);
  });
  app.onError((error, c) => {
    if (error instanceof StorageConflict)
      return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: '服务器请求失败' }, 500);
  });
  return app;
}
