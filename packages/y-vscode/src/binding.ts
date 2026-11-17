import * as Y from 'yjs';

export interface TextChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}
export interface EditorSnapshot {
  text: string;
  version: number;
}
export interface EditorChange extends EditorSnapshot {
  changes: readonly TextChange[];
}
export interface EditorAdapter {
  snapshot(): EditorSnapshot;
  onChange(listener: (change: EditorChange) => void): () => void;
  /** Must reject stale versions atomically and deliver the change event before resolving true. */
  applyEdits(changes: readonly TextChange[], version: number): Promise<boolean>;
}

export function applyTextChanges(
  text: string,
  changes: readonly TextChange[],
): string {
  let previous = text.length + 1;
  for (const change of [...changes].sort(
    (a, b) => b.rangeOffset - a.rangeOffset,
  )) {
    const { rangeOffset: start, rangeLength: length } = change;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(length) ||
      start < 0 ||
      length < 0 ||
      start + length > text.length ||
      start + length > previous
    )
      throw new Error('Invalid or overlapping editor changes');
    text = text.slice(0, start) + change.text + text.slice(start + length);
    previous = start;
  }
  return text;
}

// Convert a Y.Text transaction into non-overlapping edits against the old document.
export function deltaToChanges(delta: Y.YTextEvent['delta']): TextChange[] {
  const result: TextChange[] = [];
  let index = 0;
  let span: TextChange | undefined;
  const flush = () => {
    if (span) result.push(span);
    span = undefined;
  };
  for (const op of delta) {
    if (op.retain !== undefined) {
      flush();
      index += op.retain;
    } else {
      span ??= { rangeOffset: index, rangeLength: 0, text: '' };
      if (op.delete !== undefined) {
        span.rangeLength += op.delete;
        index += op.delete;
      }
      if (op.insert !== undefined) {
        if (typeof op.insert !== 'string')
          throw new Error('Only plain Y.Text content is supported');
        span.text += op.insert;
      }
    }
  }
  flush();
  return result;
}

/**
 * A Y.Text binding for asynchronous editors. Unlike Monaco's synchronous mutex,
 * a shadow Y.Doc represents the exact editor revision. Events received during an
 * async remote edit are buffered until the version-checked edit succeeds/fails.
 * A rejected remote edit is rebased on local input rather than replacing it.
 */
export class YEditorBinding {
  private readonly shadow = new Y.Doc();
  private readonly text: Y.Text;
  private readonly localOrigin = {};
  private readonly remoteOrigin = {};
  private readonly undoManager: Y.UndoManager;
  private readonly unsubscribe: () => void;
  private pending?: { events: EditorChange[] };
  private running?: Promise<void>;
  private requested = false;
  private disposed = false;
  private failed = false;
  private revision = 0;
  private readonly sharedDoc: Y.Doc;
  private readonly sharedChanged = () => {
    this.schedule();
  };
  private readonly shadowChanged = (update: Uint8Array, origin: unknown) => {
    if (origin === this.localOrigin)
      Y.applyUpdate(this.sharedDoc, update, this);
  };

  constructor(
    private readonly sharedText: Y.Text,
    private readonly editor: EditorAdapter,
    private readonly onError: (error: Error) => void,
    initialState?: Uint8Array,
    private readonly textName = 'content',
  ) {
    if (!sharedText.doc || sharedText.doc.getText(textName) !== sharedText)
      throw new Error('Binding requires a named, attached Y.Text');
    this.sharedDoc = sharedText.doc;
    Y.applyUpdate(
      this.shadow,
      initialState ?? Y.encodeStateAsUpdate(this.sharedDoc),
      this.remoteOrigin,
    );
    this.text = this.shadow.getText(textName);
    if (editor.snapshot().text !== this.text.toString()) {
      this.shadow.destroy();
      throw new Error('Editor snapshot does not match the initial Yjs state');
    }
    this.revision = editor.snapshot().version;
    this.undoManager = new Y.UndoManager(sharedText, {
      trackedOrigins: new Set([this]),
      captureTimeout: 500,
    });
    this.shadow.on('update', this.shadowChanged);
    this.unsubscribe = editor.onChange((event) => {
      if (this.disposed || this.failed) return;
      if (this.pending) this.pending.events.push(event);
      else {
        try {
          this.applyLocal(event);
          this.schedule();
        } catch (error) {
          this.fail(error);
        }
      }
    });
    this.sharedDoc.on('update', this.sharedChanged);
    this.schedule();
  }

  get isFailed() {
    return this.failed;
  }
  get content() {
    return this.text.toString();
  }
  exportState() {
    return Y.encodeStateAsUpdate(this.shadow);
  }
  private fail(error: unknown) {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }
  private applyLocal(event: EditorChange) {
    if (event.version <= this.revision) return;
    if (applyTextChanges(this.content, event.changes) !== event.text)
      throw new Error(
        'Editor and collaboration state diverged; reopen the note after exporting your draft',
      );
    this.revision = event.version;
    this.shadow.transact(() => {
      for (const change of [...event.changes].sort(
        (a, b) => b.rangeOffset - a.rangeOffset,
      )) {
        if (change.rangeLength)
          this.text.delete(change.rangeOffset, change.rangeLength);
        if (change.text) this.text.insert(change.rangeOffset, change.text);
      }
    }, this.localOrigin);
  }
  private schedule() {
    this.requested = true;
    if (this.disposed || this.failed || this.running) return;
    // Defer once so running is assigned before adapter callbacks can re-enter.
    this.running = Promise.resolve()
      .then(async () => {
        while (this.requested && !this.disposed && !this.failed) {
          this.requested = false;
          await this.drain();
        }
      })
      .catch((error) => this.fail(error))
      .finally(() => {
        this.running = undefined;
        if (this.requested && !this.disposed && !this.failed) this.schedule();
      });
  }
  async flush() {
    this.schedule();
    await this.running;
    if (this.failed)
      throw new Error(
        'Collaboration binding stopped; export the editor draft before reopening',
      );
  }
  async undo() {
    await this.flush();
    this.undoManager.stopCapturing();
    this.undoManager.undo();
    await this.flush();
  }
  async redo() {
    await this.flush();
    this.undoManager.redo();
    await this.flush();
  }
  stopCapturing() {
    this.undoManager.stopCapturing();
  }

  private async drain() {
    let rejected = 0;
    while (!this.disposed && !this.failed) {
      const base = this.editor.snapshot();
      if (base.text !== this.content)
        throw new Error('Editor changed without a content event');
      const update = Y.encodeStateAsUpdate(
        this.sharedDoc,
        Y.encodeStateVector(this.shadow),
      );
      const candidate = new Y.Doc();
      let changes: TextChange[] = [];
      let target: string;
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.shadow));
        const text = candidate.getText(this.textName);
        text.observe((event) => {
          changes = deltaToChanges(event.delta);
        });
        Y.applyUpdate(candidate, update);
        target = text.toString();
      } finally {
        candidate.destroy();
      }
      if (!changes.length) {
        Y.applyUpdate(this.shadow, update, this.remoteOrigin);
        return;
      }
      const pending = { events: [] as EditorChange[] };
      this.pending = pending;
      let applied = false;
      try {
        applied = await this.editor.applyEdits(changes, base.version);
      } finally {
        this.pending = undefined;
      }
      if (this.disposed) return;
      if (applied) {
        const [remote, ...local] = pending.events;
        if (
          !remote ||
          remote.version !== base.version + 1 ||
          remote.text !== target
        ) {
          throw new Error(
            'Remote edit acknowledgement did not match the editor revision',
          );
        }
        Y.applyUpdate(this.shadow, update, this.remoteOrigin);
        this.revision = remote.version;
        for (const event of local) this.applyLocal(event);
        rejected = 0;
      } else {
        for (const event of pending.events) this.applyLocal(event);
        // Recompute the delta against the new editor revision, never retry stale offsets.
        if (++rejected > 8)
          throw new Error(
            'Editor repeatedly rejected remote changes; export your draft and reopen the note',
          );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.sharedDoc.off('update', this.sharedChanged);
    this.shadow.off('update', this.shadowChanged);
    this.undoManager.destroy();
    this.shadow.destroy();
  }
}
