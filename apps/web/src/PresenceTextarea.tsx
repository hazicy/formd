import styles from './PresenceTextarea.module.css';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  captureSelection,
  resolveSelection,
  type NoteSession,
  type PresenceMember,
  type RelativeSelection,
} from '@typo/client';
interface Props {
  session: NoteSession;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onBold: () => void;
}
export const PresenceTextarea = forwardRef<HTMLTextAreaElement, Props>(
  function PresenceTextarea(
    { session, value, disabled, onChange, onBold },
    ref,
  ) {
    const input = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => input.current!, []);
    const [members, setMembers] = useState<readonly PresenceMember[]>(
      session.members,
    );
    const [layout, setLayout] = useState<{
      style: React.CSSProperties;
      top: number;
      left: number;
    }>({ style: {}, top: 0, left: 0 });
    const saved = useRef<{
      selection: RelativeSelection;
      direction: 'forward' | 'backward' | 'none';
    } | null>(null);
    const measure = () => {
      const element = input.current;
      if (!element) return;
      const computed = getComputedStyle(element);
      const style: Record<string, string | number> = {
        width: element.clientWidth,
        minHeight: element.scrollHeight,
      };
      for (const key of [
        'fontFamily',
        'fontSize',
        'fontWeight',
        'fontStyle',
        'lineHeight',
        'letterSpacing',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'tabSize',
        'wordBreak',
        'overflowWrap',
        'textIndent',
        'textAlign',
      ] as const)
        style[key] = computed[key];
      setLayout({ style, top: -element.scrollTop, left: -element.scrollLeft });
    };
    const publish = () => {
      const element = input.current;
      if (
        !element ||
        document.activeElement !== element ||
        element.value !== session.text.toString()
      )
        return;
      const backward = element.selectionDirection === 'backward';
      session.setSelection(
        captureSelection(
          session.text,
          backward ? element.selectionEnd : element.selectionStart,
          backward ? element.selectionStart : element.selectionEnd,
        ),
      );
    };
    useEffect(
      () => session.subscribePresence(() => setMembers([...session.members])),
      [session],
    );
    useEffect(() => {
      const previous = new WeakMap<object, typeof saved.current>();
      const before = (transaction: { origin: unknown }) => {
        const element = input.current;
        if (
          !element ||
          !session.isRemoteOrigin(transaction.origin) ||
          document.activeElement !== element ||
          element.value !== session.text.toString()
        )
          return;
        const backward = element.selectionDirection === 'backward';
        previous.set(transaction, saved.current);
        saved.current = {
          selection: captureSelection(
            session.text,
            backward ? element.selectionEnd : element.selectionStart,
            backward ? element.selectionStart : element.selectionEnd,
          ),
          direction: element.selectionDirection,
        };
      };
      const after = (transaction: {
        origin: unknown;
        changed: ReadonlyMap<unknown, unknown>;
      }) => {
        if (previous.has(transaction) && !transaction.changed.has(session.text))
          saved.current = previous.get(transaction) ?? null;
        previous.delete(transaction);
      };
      session.doc.on('beforeTransaction', before);
      session.doc.on('afterTransaction', after);
      const observer = new ResizeObserver(measure);
      if (input.current) observer.observe(input.current);
      return () => {
        session.doc.off('beforeTransaction', before);
        session.doc.off('afterTransaction', after);
        observer.disconnect();
        session.setSelection(null);
      };
    }, [session]);
    useLayoutEffect(() => {
      const element = input.current;
      if (saved.current && element) {
        const selection = resolveSelection(
          session.text,
          saved.current.selection,
        );
        if (selection)
          element.setSelectionRange(
            Math.min(selection.anchor, selection.head),
            Math.max(selection.anchor, selection.head),
            saved.current.direction,
          );
        saved.current = null;
      }
      measure();
    }, [value, session]);
    return (
      <div className={styles['source-frame']}>
        <textarea
          ref={input}
          className={styles['source']}
          aria-label="Markdown 编辑器"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
            publish();
          }}
          onSelect={publish}
          onKeyUp={publish}
          onMouseUp={publish}
          onFocus={publish}
          onBlur={() => {
            saved.current = null;
            session.setSelection(null);
          }}
          onScroll={measure}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'b') {
              event.preventDefault();
              onBold();
            }
          }}
        />
        {members
          .filter((member) => member.id !== session.connectionId)
          .map((member) => {
            const selection = resolveSelection(session.text, member.selection);
            if (!selection) return null;
            const start = Math.min(selection.anchor, selection.head),
              end = Math.max(selection.anchor, selection.head);
            const caret = (
              <span
                className={styles['remote-caret']}
                style={{ borderColor: member.user.color }}
              >
                <span
                  className="remote-label"
                  style={{ background: member.user.color }}
                >
                  {member.user.name}
                </span>
              </span>
            );
            return (
              <div
                key={member.id}
                className={styles['presence-mirror']}
                role="img"
                aria-label={`${member.user.name} 的光标，第 ${value.slice(0, selection.head).split('\n').length} 行`}
                data-presence-id={member.id}
              >
                <div
                  className={styles['presence-mirror-content']}
                  style={{
                    ...layout.style,
                    top: layout.top,
                    left: layout.left,
                  }}
                >
                  {value.slice(0, start)}
                  {selection.head === start ? caret : null}
                  <span
                    className="remote-selection"
                    style={{ background: member.user.color + '35' }}
                  >
                    {value.slice(start, end)}
                  </span>
                  {selection.head !== start ? caret : null}
                  {value.slice(end)}
                  {'\u200b'}
                </div>
              </div>
            );
          })}
      </div>
    );
  },
);
