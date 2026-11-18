import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import type { NoteSession } from '@formd/client';
import { documentKeyString, type DocumentKey } from './document-key.js';

export class DraftStore {
  // Separate writers prevent two extension hosts from overwriting each other.
  private readonly writer = randomUUID();

  constructor(
    private readonly root: string,
    private readonly legacyRoot?: string,
  ) {}

  restore(key: DocumentKey, doc: Y.Doc) {
    const roots = this.legacyRoot ? [this.root, this.legacyRoot] : [this.root];
    const updates = roots.flatMap((root) => {
      const directory = this.directory(key, root);
      try {
        return readdirSync(directory)
          .filter((file) => file.endsWith('.yjs'))
          .map((file) => readFileSync(join(directory, file)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    });
    if (!updates.length) return false;
    Y.applyUpdate(doc, Y.mergeUpdates(updates));
    return true;
  }

  save(key: DocumentKey, doc: Y.Doc, filename?: string) {
    const directory = this.directory(key);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, this.writer + '.yjs');
    writeFileSync(path + '.tmp', Y.encodeStateAsUpdate(doc), {
      mode: 0o600,
    });
    renameSync(path + '.tmp', path);
    const index = join(directory, 'note.json');
    if (filename && !existsSync(index)) {
      const temporary = join(directory, this.writer + '.json.tmp');
      writeFileSync(
        temporary,
        JSON.stringify({ server: key.server, id: key.noteId, filename }),
        {
          mode: 0o600,
        },
      );
      renameSync(temporary, index);
    }
  }

  list(server: string): { key: DocumentKey; filename: string }[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const index = join(this.root, entry.name, 'note.json');
      if (!existsSync(index)) return [];
      const note = JSON.parse(readFileSync(index, 'utf8'));
      return note.server === server &&
        typeof note.id === 'string' &&
        typeof note.filename === 'string'
        ? [{ key: { server, noteId: note.id }, filename: note.filename }]
        : [];
    });
  }

  read(key: DocumentKey) {
    const doc = new Y.Doc();
    try {
      if (this.restore(key, doc)) return doc.getText('content').toString();
    } finally {
      doc.destroy();
    }
  }

  private directory(identity: DocumentKey, root = this.root) {
    const key = createHash('sha256')
      .update(documentKeyString(identity))
      .digest('hex');
    return join(root, key);
  }
}

export class SessionDraft {
  available = false;
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private failed = false;

  constructor(
    private readonly store: DraftStore,
    private readonly key: DocumentKey,
    private readonly session: NoteSession,
    private readonly filename: string,
    private readonly onAvailable: () => void,
    private readonly report: (
      error: unknown,
      operation: 'restore' | 'save',
    ) => void,
  ) {
    try {
      this.available = store.restore(key, session.doc);
    } catch (error) {
      this.report(error, 'restore');
    }
    session.doc.on('update', this.schedule);
  }

  private readonly schedule = (_update: Uint8Array, origin: unknown) => {
    if (this.session.isRemoteOrigin(origin)) return;
    this.dirty = true;
    this.timer ??= setTimeout(() => this.flush(), 250);
  };

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    try {
      this.store.save(this.key, this.session.doc, this.filename);
    } catch (error) {
      if (!this.failed) this.report(error, 'save');
      this.failed = true;
      return;
    }
    this.dirty = false;
    this.failed = false;
    const first = !this.available;
    this.available = true;
    if (first) this.onAvailable();
  }

  dispose() {
    this.session.doc.off('update', this.schedule);
    this.flush();
  }
}
