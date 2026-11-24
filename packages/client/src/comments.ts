import * as Y from 'yjs';
import { validRelativeSelection, type RelativeSelection } from '@formd/core';

export const MAX_COMMENT_LENGTH = 4000;
export const COMMENT_REACTIONS = ['👍', '👎', '❤️', '🎉', '😄', '👀'] as const;

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

export interface CommentInboxItem {
  noteId: string;
  noteTitle: string;
  threadId: string;
  anchor: RelativeSelection;
  reason: 'mention' | 'reply';
  message: CommentMessage;
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
  private readonly originals = new WeakMap<CommentMessage, CommentMessage>();
  private readonly edits = new WeakMap<CommentMessage, CommentMessage>();
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
      const messages = replies.toArray().flatMap((message, index) => {
        if (!validMessage(message)) return [];
        const key = this.messageKey(replies, index);
        const body = thread.get(`edit:${key}`);
        if (typeof body !== 'string' || body === message.body) return [message];
        const cached = this.edits.get(message);
        if (cached?.body === body) return [cached];
        const edited = { ...message, body };
        if (!validMessage(edited)) return [message];
        this.edits.set(message, edited);
        this.originals.set(edited, message);
        return [edited];
      });
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

  deleteMessage(id: string, message: CommentMessage) {
    const thread = this.threads.get(id);
    const messages = thread instanceof Y.Map ? thread.get('messages') : null;
    if (!(messages instanceof Y.Array)) return;
    const index = messages
      .toArray()
      .indexOf(this.originals.get(message) ?? message);
    if (index !== -1) messages.delete(index, 1);
  }

  editMessage(id: string, message: CommentMessage, body: string) {
    const target = this.reactionTarget(id, message);
    if (!target) throw new Error('This comment no longer exists.');
    const edited = { ...message, body: body.trim() };
    if (!validMessage(edited))
      throw new Error('Enter a comment of 1 to 4000 characters.');
    if (
      edited.body !==
      (target.thread.get(`edit:${target.key}`) ??
        (this.originals.get(message) ?? message).body)
    )
      target.thread.set(`edit:${target.key}`, edited.body);
  }

  reactions(id: string, message: CommentMessage, actor: string) {
    const target = this.reactionTarget(id, message);
    const counts = new Map<string, number>();
    if (target) {
      for (const key of target.thread.keys()) {
        if (!key.startsWith(target.prefix)) continue;
        const emoji = key.slice(target.prefix.length).split(':', 1)[0];
        counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
      }
    }
    return COMMENT_REACTIONS.map((label) => ({
      label,
      count: counts.get(label) ?? 0,
      authorHasReacted:
        target?.thread.has(`${target.prefix}${label}:${actor}`) ?? false,
    }));
  }

  toggleReaction(
    id: string,
    message: CommentMessage,
    emoji: string,
    actor: string,
  ) {
    if (!COMMENT_REACTIONS.some((label) => label === emoji)) return;
    const target = this.reactionTarget(id, message);
    if (!target) return;
    const key = `${target.prefix}${emoji}:${actor}`;
    if (target.thread.has(key)) target.thread.delete(key);
    else target.thread.set(key, true);
  }

  private reactionTarget(id: string, message: CommentMessage) {
    const thread = this.threads.get(id);
    if (!(thread instanceof Y.Map)) return;
    const messages = thread.get('messages');
    if (!(messages instanceof Y.Array)) return;
    const index = messages
      .toArray()
      .indexOf(this.originals.get(message) ?? message);
    if (index === -1) return;
    // Use the CRDT item's identity, not its position or message contents.
    const key = this.messageKey(messages, index);
    if (key) return { thread, key, prefix: `reaction:${key}:` };
  }

  private messageKey(messages: Y.Array<unknown>, index: number) {
    const { item } = Y.createRelativePositionFromTypeIndex(messages, index);
    return item && `${item.client}:${item.clock}`;
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
