import type { Note } from '@typo/core';

export interface StoredNote extends Note {
  state: string;
}

export interface NoteStore {
  load(): Promise<StoredNote[]>;
  upsert(note: StoredNote): Promise<void>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}
