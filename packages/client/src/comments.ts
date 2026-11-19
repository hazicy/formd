import * as Y from 'yjs';
import { validRelativeSelection, type RelativeSelection } from '@formd/core';

export const MAX_COMMENT_LENGTH = 4000;

export interface CommentMessage {
  author: string;
  body: string;
  createdAt: number;
}

export interface CommentThread {
  id: string;
  anchor: RelativeSelection;
  resolved: boolean;
  messages: CommentMessage[];
}

function validMessage(value: unknown): value is CommentMessage {
  if (!value || typeof value !== 'object') return false;
  const { author, body, createdAt } = value as CommentMessage;
  return (
    typeof author === 'string' &&
    author.trim().length > 0 &&
    author.length <= 48 &&
    typeof body === 'string' &&
    body.trim().length > 0 &&
    body.length <= MAX_COMMENT_LENGTH &&
    typeof createdAt === 'number' &&
    Number.isFinite(createdAt) &&
    Math.abs(createdAt) <= 8.64e15
  );
}

export class NoteComments {
  private readonly threads: Y.Map<Y.Map<unknown>>;
  private readonly doc: Y.Doc;
  private readonly author: () => string;
  constructor(doc: Y.Doc, author: () => string) {
    this.doc = doc;
    this.author = author;
    this.threads = doc.getMap('comments');
  }

  list(): CommentThread[] {
    const threads: CommentThread[] = [];
    for (const [id, thread] of this.threads) {
      if (!(thread instanceof Y.Map)) continue;
      const anchor = thread.get('anchor');
      const replies = thread.get('messages');
      if (
        !anchor ||
        !validRelativeSelection(anchor) ||
        !(replies instanceof Y.Array)
      )
        continue;
      const messages = replies.toArray().filter(validMessage);
      if (!messages.length) continue;
      threads.push({
        id,
        anchor,
        resolved: thread.get('resolved') === true,
        messages,
      });
    }
    return threads.sort(
      (a, b) =>
        a.messages[0].createdAt - b.messages[0].createdAt ||
        a.id.localeCompare(b.id),
    );
  }

  create(anchor: RelativeSelection, body: string) {
    if (!anchor || !validRelativeSelection(anchor))
      throw new Error('Invalid comment anchor.');
    const message = this.message(body);
    const id = [...globalThis.crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    this.doc.transact(() => {
      const thread = new Y.Map<unknown>();
      const messages = new Y.Array<CommentMessage>();
      messages.push([message]);
      thread.set('anchor', anchor);
      thread.set('messages', messages);
      this.threads.set(id, thread);
    });
    return id;
  }

  reply(id: string, body: string) {
    const thread = this.threads.get(id);
    const messages = thread instanceof Y.Map ? thread.get('messages') : null;
    if (!(messages instanceof Y.Array) || thread?.get('resolved') === true)
      throw new Error('This comment thread is unavailable for replies.');
    messages.push([this.message(body)]);
  }

  setResolved(id: string, resolved: boolean) {
    const thread = this.threads.get(id);
    if (thread instanceof Y.Map) thread.set('resolved', resolved);
  }

  private message(body: string): CommentMessage {
    const message = {
      author: this.author(),
      body: body.trim(),
      createdAt: Date.now(),
    };
    if (!validMessage(message))
      throw new Error('Enter a comment of 1 to 4000 characters.');
    return message;
  }
}
