import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import type { NoteSession } from '@typo/client';

export class DraftStore {
  // Separate writers prevent two extension hosts from overwriting each other.
  private readonly writer = randomUUID();

  constructor(private readonly root: string) {}

  restore(server: string, session: Pick<NoteSession, 'doc' | 'id'>) {
    const directory = this.directory(server, session.id);
    let files: string[];
    try {
      files = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const updates = files
      .filter((file) => file.endsWith('.yjs'))
      .map((file) => readFileSync(join(directory, file)));
    if (!updates.length) return false;
    Y.applyUpdate(session.doc, Y.mergeUpdates(updates));
    return true;
  }

  save(server: string, session: Pick<NoteSession, 'doc' | 'id'>) {
    const directory = this.directory(server, session.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, this.writer + '.yjs');
    writeFileSync(path + '.tmp', Y.encodeStateAsUpdate(session.doc), {
      mode: 0o600,
    });
    renameSync(path + '.tmp', path);
  }

  private directory(server: string, id: string) {
    const key = createHash('sha256')
      .update(JSON.stringify([server, id]))
      .digest('hex');
    return join(this.root, key);
  }
}
