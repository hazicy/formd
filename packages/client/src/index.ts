import * as Y from 'yjs';
import { fromByteArray, toByteArray } from 'base64-js';
import {
  createGuestUser,
  validPresenceUser,
  validRelativeSelection,
  type Note,
  type Folder,
  type PresenceUser,
  type PresenceMember,
  type RelativeSelection,
} from '@formd/core';
export * from './presence';
export * from '@formd/core';
export type ConnectionStatus =
  'connecting' | 'connected' | 'offline' | 'deleted' | 'error';
export class FormdClient {
  readonly baseUrl: string;
  user?: PresenceUser;
  constructor(baseUrl: string, user?: PresenceUser) {
    this.user = user;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(error.error || `请求失败 (${response.status})`);
    }
    return response.json() as Promise<T>;
  }
  list(): Promise<Note[]> {
    return this.request('/api/notes');
  }
  create(
    title = '未命名文档',
    content = '',
    folderId: string | null = null,
  ): Promise<Note> {
    return this.request('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title, content, folderId }),
    });
  }
  rename(id: string, title: string): Promise<Note> {
    return this.request(`/api/notes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  }
  delete(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/notes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  move(id: string, folderId: string | null): Promise<Note> {
    return this.request(`/api/notes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ folderId }),
    });
  }
  listFolders(): Promise<Folder[]> {
    return this.request('/api/folders');
  }
  createFolder(name: string, parentId: string | null = null): Promise<Folder> {
    return this.request('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId }),
    });
  }
  updateFolder(
    id: string,
    changes: Partial<Pick<Folder, 'name' | 'parentId'>>,
  ): Promise<Folder> {
    return this.request(`/api/folders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
  }
  deleteFolder(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/folders/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  connect(id: string, user = this.user): NoteSession {
    return new NoteSession(this.baseUrl, id, user);
  }
}
export class NoteSession {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText('content');
  members: readonly PresenceMember[] = [];
  connectionId = '';
  user: PresenceUser;
  private selection: RelativeSelection | null = null;
  private presenceListeners = new Set<() => void>();
  status: ConnectionStatus = 'connecting';
  private listeners = new Set<() => void>();
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private ready = false;
  private retry = 500;
  private remote = {};
  private baseUrl: string;
  readonly id: string;
  constructor(baseUrl: string, id: string, user?: PresenceUser) {
    this.user = user ?? createGuestUser('unknown', this.doc.clientID);
    this.baseUrl = baseUrl;
    this.id = id;
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== this.remote && this.ready && this.socket?.readyState === 1)
        this.socket.send(
          JSON.stringify({ type: 'update', data: fromByteArray(update) }),
        );
      this.emit();
    });
    this.open();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribePresence(listener: () => void): () => void {
    this.presenceListeners.add(listener);
    return () => {
      this.presenceListeners.delete(listener);
    };
  }
  private emitPresence() {
    for (const listener of this.presenceListeners) listener();
  }
  isRemoteOrigin(origin: unknown) {
    return origin === this.remote;
  }
  setUser(user: PresenceUser) {
    if (!validPresenceUser(user)) throw new Error('Invalid presence profile');
    this.user = { ...user, name: user.name.trim() };
    this.sendPresence();
  }
  setSelection(selection: RelativeSelection | null) {
    if (!validRelativeSelection(selection)) return;
    if (
      this.selection?.anchor === selection?.anchor &&
      this.selection?.head === selection?.head
    )
      return;
    this.selection = selection;
    this.sendPresence();
  }
  private sendPresence() {
    if (this.ready && this.socket?.readyState === 1)
      this.socket.send(
        JSON.stringify({
          type: 'presence',
          user: this.user,
          selection: this.selection,
        }),
      );
  }
  private clearPresence() {
    this.members = [];
    this.connectionId = '';
    this.emitPresence();
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private setStatus(status: ConnectionStatus) {
    this.status = status;
    this.emit();
  }
  private open() {
    if (this.disposed) return;
    this.ready = false;
    this.setStatus('connecting');
    const socket = new WebSocket(
      this.baseUrl.replace(/^http/, 'ws') +
        `/sync/${encodeURIComponent(this.id)}`,
    );
    this.socket = socket;
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'deleted') {
          this.clearPresence();
          this.setStatus('deleted');
          socket.close();
          return;
        }
        if (message.type === 'error') {
          this.clearPresence();
          this.setStatus('error');
          socket.close();
          return;
        }
        if (message.type === 'presence') {
          if (Array.isArray(message.members)) {
            this.members = message.members.filter(
              (member: PresenceMember) =>
                typeof member?.id === 'string' &&
                validPresenceUser(member.user) &&
                validRelativeSelection(member.selection),
            );
            this.emitPresence();
          }
          return;
        }
        if (message.type === 'sync' || message.type === 'update') {
          Y.applyUpdate(this.doc, toByteArray(message.data), this.remote);
          if (message.type === 'sync') {
            this.connectionId =
              typeof message.selfId === 'string' ? message.selfId : '';
            socket.send(
              JSON.stringify({
                type: 'update',
                data: fromByteArray(Y.encodeStateAsUpdate(this.doc)),
              }),
            );
            this.ready = true;
            this.sendPresence();
            this.retry = 500;
            this.setStatus('connected');
          }
        }
      } catch {
        this.setStatus('error');
        socket.close();
      }
    };
    socket.onerror = () => {
      this.clearPresence();
      if (this.status !== 'deleted') this.setStatus('offline');
    };
    socket.onclose = () => {
      this.ready = false;
      this.clearPresence();
      if (this.disposed || this.status === 'deleted' || this.status === 'error')
        return;
      this.setStatus('offline');
      this.timer = setTimeout(() => this.open(), this.retry);
      this.retry = Math.min(this.retry * 2, 10000);
    };
  }
  replace(next: string) {
    const current = this.text.toString();
    if (current === next) return;
    let start = 0;
    while (
      start < current.length &&
      start < next.length &&
      current[start] === next[start]
    )
      start++;
    let end = 0;
    while (
      end < current.length - start &&
      end < next.length - start &&
      current[current.length - end - 1] === next[next.length - end - 1]
    )
      end++;
    this.doc.transact(() => {
      this.text.delete(start, current.length - start - end);
      this.text.insert(start, next.slice(start, next.length - end));
    });
  }
  destroy() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.socket?.close();
    this.clearPresence();
    this.presenceListeners.clear();
    this.listeners.clear();
    this.doc.destroy();
  }
}
