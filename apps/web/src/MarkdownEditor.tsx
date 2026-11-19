import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  Annotation,
  Transaction,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Text,
  type ChangeSpec,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  showTooltip,
  type DecorationSet,
} from '@codemirror/view';
import {
  captureSelection,
  captureCommentAnchor,
  resolveSelection,
  type ExcerptReplaced,
  type NoteSession,
  type PresenceMember,
  type RelativeSelection,
} from '@formd/client';
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import { markdownLive } from './markdownLive';
import styles from './MarkdownEditor.module.css';

export interface MarkdownEditorHandle {
  locateComment(anchor: RelativeSelection): void;
}

const fromSession = Annotation.define<boolean>();
const setPresence = StateEffect.define<DecorationSet>();
const presence = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setPresence)) return effect.value;
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

class RemoteCaret extends WidgetType {
  readonly member: PresenceMember;
  readonly line: number;

  constructor(member: PresenceMember, line: number) {
    super();
    this.member = member;
    this.line = line;
  }

  eq(other: RemoteCaret) {
    return (
      this.line === other.line &&
      this.member.id === other.member.id &&
      this.member.user.name === other.member.user.name &&
      this.member.user.color === other.member.user.color
    );
  }

  toDOM(view: EditorView) {
    const caret = view.dom.ownerDocument.createElement('span');
    caret.className = styles.caret;
    caret.setAttribute('role', 'img');
    caret.setAttribute(
      'aria-label',
      `${this.member.user.name} 的光标，第 ${this.line} 行`,
    );
    caret.style.color = this.member.user.color;
    const label = caret.appendChild(
      view.dom.ownerDocument.createElement('span'),
    );
    label.className = styles.label;
    label.style.backgroundColor = this.member.user.color;
    label.textContent = this.member.user.name;
    return caret;
  }
}

function insert(view: EditorView, before: string, after: string) {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to) || '文字';
  view.dispatch({
    changes: { from, to, insert: before + selected + after },
    selection: {
      anchor: from + before.length,
      head: from + before.length + selected.length,
    },
    scrollIntoView: true,
    userEvent: 'input',
  });
  view.focus();
  return true;
}

const readOnlyConfig = new Compartment();
const selectionActions = [
  ['H', '标题', '# ', ''],
  ['B', '粗体', '**', '**'],
  ['I', '斜体', '*', '*'],
  ['链接', '链接', '[', '](https://example.com)'],
  ['代码', '代码', '`', '`'],
  ['列表', '列表', '- ', ''],
] as const;

function selectionToolbar(onComment: (view: EditorView) => boolean) {
  function create(view: EditorView) {
    const document = view.dom.ownerDocument;
    const dom = document.createElement('div');
    dom.className = styles['selection-toolbar'];
    dom.setAttribute('role', 'group');
    dom.setAttribute('aria-label', '选区操作');
    dom.addEventListener('mousedown', (event) => event.preventDefault());
    const addButton = (text: string, label: string, run: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', run);
      dom.append(button);
    };
    for (const [text, label, before, after] of selectionActions) {
      addButton(text, label, () => insert(view, before, after));
    }
    addButton('评论', '添加评论', () => onComment(view));
    return { dom };
  }
  return showTooltip.compute(['selection', EditorState.readOnly], (state) => {
    const { from, to, empty } = state.selection.main;
    return state.readOnly || empty ? null : { pos: from, end: to, above: true, create };
  });
}

const editing = (readOnly: boolean) => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
  EditorView.contentAttributes.of({
    role: 'textbox',
    'aria-label': 'Markdown 编辑器',
    'aria-multiline': 'true',
    'aria-readonly': String(readOnly),
    spellcheck: 'false',
    tabindex: '0',
  }),
];

export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  {
    session: NoteSession;
    readOnly: boolean;
    onDocumentSizeChange: (size: { length: number; lines: number }) => void;
    onComment: (anchor: RelativeSelection) => void;
  }
>(function MarkdownEditor({ session, readOnly, onDocumentSizeChange, onComment }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      locateComment(anchor) {
        const view = editor.current;
        const selection = resolveSelection(session.text, anchor);
        if (!view || !selection) return;
        view.dispatch({ selection, scrollIntoView: true });
        view.focus();
      },
    }),
    [session],
  );

  useLayoutEffect(() => {
    const origin = {};
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const flashes = new Map<string, ExcerptReplaced>();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const refreshPresence = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const ranges: Range<Decoration>[] = [];
        for (const member of session.members) {
          if (member.id === session.connectionId) continue;
          const selection = resolveSelection(session.text, member.selection);
          if (!selection) continue;
          const flash = flashes.get(member.id);
          const highlight =
            (flash && resolveSelection(session.text, flash.range)) || selection;
          const from = Math.min(highlight.anchor, highlight.head);
          const to = Math.max(highlight.anchor, highlight.head);
          if (from < to) {
            ranges.push(
              Decoration.mark({
                class: flash ? styles.flash : styles.selection,
                attributes: {
                  style: `--presence-color: ${member.user.color}35`,
                },
              }).range(from, to),
            );
          }
          ranges.push(
            Decoration.widget({
              widget: new RemoteCaret(
                member,
                view.state.doc.lineAt(selection.head).number,
              ),
              side: 1,
            }).range(selection.head),
          );
        }
        view.dispatch({
          effects: setPresence.of(Decoration.set(ranges, true)),
        });
      });
    };
    function addComment(view: EditorView) {
      if (view.state.readOnly) return false;
      const { from, to, empty } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      const anchor = captureCommentAnchor(
        session.text,
        empty ? line.from : from,
        empty ? line.to : to,
      );
      if (!anchor) return false;
      onComment(anchor);
      return true;
    }
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: Text.of(session.text.toString().split('\n')),
        extensions: [
          readOnlyConfig.of(editing(true)),
          markdown({ base: markdownLanguage }),
          markdownLive,
          presence,
          history(),
          selectionToolbar(addComment),
          keymap.of([
            { key: 'Mod-b', run: (view) => insert(view, '**', '**') },
            { key: 'Mod-Alt-m', run: addComment },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) =>
                transaction.annotation(fromSession),
              )
            ) {
              session.doc.transact(() => {
                update.changes.iterChanges(
                  (from, to, newFrom, _newTo, inserted) => {
                    if (to > from) session.text.delete(newFrom, to - from);
                    if (inserted.length)
                      session.text.insert(newFrom, inserted.toString());
                  },
                );
              }, origin);
            }
            if (
              update.docChanged ||
              update.selectionSet ||
              update.focusChanged
            ) {
              const { anchor, head } = update.state.selection.main;
              session.setSelection(
                update.view.hasFocus
                  ? captureSelection(session.text, anchor, head)
                  : null,
              );
            }
            if (update.docChanged) {
              const { length, lines } = update.state.doc;
              onDocumentSizeChange({ length, lines });
              refreshPresence();
            }
          }),
        ],
      }),
    });
    editor.current = view;
    const { length, lines } = view.state.doc;
    onDocumentSizeChange({ length, lines });
    const sync: Parameters<typeof session.text.observe>[0] = (
      event,
      transaction,
    ) => {
      if (transaction.origin === origin) return;
      const changes: ChangeSpec[] = [];
      let offset = 0;
      for (const part of event.delta) {
        if (part.retain) offset += part.retain;
        if (part.delete) {
          changes.push({ from: offset, to: offset + part.delete });
          offset += part.delete;
        }
        if (typeof part.insert === 'string') {
          changes.push({
            from: offset,
            insert: Text.of(part.insert.split('\n')),
          });
        }
      }
      view.dispatch({
        changes,
        annotations: [fromSession.of(true), Transaction.addToHistory.of(false)],
      });
    };
    session.text.observe(sync);
    const unsubscribe = session.subscribePresence(refreshPresence);
    const unsubscribeExcerpts = session.subscribeExcerptReplaced((event) => {
      if (reduceMotion.matches || event.memberId === session.connectionId)
        return;
      clearTimeout(timers.get(event.memberId));
      flashes.set(event.memberId, event);
      timers.set(
        event.memberId,
        setTimeout(() => {
          flashes.delete(event.memberId);
          timers.delete(event.memberId);
          refreshPresence();
        }, 400),
      );
      refreshPresence();
    });
    refreshPresence();
    return () => {
      session.text.unobserve(sync);
      unsubscribe();
      unsubscribeExcerpts();
      session.setSelection(null);
      cancelAnimationFrame(frame);
      for (const timer of timers.values()) clearTimeout(timer);
      view.destroy();
      editor.current = null;
    };
  }, [session, onDocumentSizeChange, onComment]);

  useLayoutEffect(() => {
    editor.current?.dispatch({
      effects: readOnlyConfig.reconfigure(editing(readOnly)),
    });
  }, [session, readOnly]);

  return <div className={styles.editor} ref={host} />;
});
