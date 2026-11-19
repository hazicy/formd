import { useEffect, useState, type FormEvent } from 'react';
import {
  MAX_COMMENT_LENGTH,
  resolveSelection,
  type NoteSession,
  type RelativeSelection,
} from '@formd/client';
import styles from './CommentsPanel.module.css';

export function CommentsPanel({
  session,
  editable,
  draft,
  onClose,
  onDraftChange,
  onLocate,
}: {
  session: NoteSession;
  editable: boolean;
  draft: RelativeSelection | null;
  onClose: () => void;
  onDraftChange: (anchor: RelativeSelection | null) => void;
  onLocate: (anchor: RelativeSelection) => void;
}) {
  const [threads, setThreads] = useState(() => session.comments.list());
  const [error, setError] = useState('');
  useEffect(() => {
    const update = () => setThreads(session.comments.list());
    const unsubscribe = session.subscribe(update);
    update();
    return unsubscribe;
  }, [session]);

  function excerpt(anchor: RelativeSelection) {
    const selection = resolveSelection(session.text, anchor);
    if (!selection || selection.anchor === selection.head)
      return '原文已移除或为空';
    const from = Math.min(selection.anchor, selection.head);
    return session.text
      .toString()
      .slice(
        from,
        Math.min(from + 180, Math.max(selection.anchor, selection.head)),
      );
  }

  function submit(
    event: FormEvent<HTMLFormElement>,
    send: (body: string) => void,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = String(new FormData(form).get('body') ?? '');
    if (!editable || !body.trim()) return;
    try {
      send(body);
      form.reset();
      setError('');
    } catch {
      setError('无法提交评论，请检查线程状态后重试。');
    }
  }

  return (
    <aside className={styles.panel} aria-label="文档评论">
      <header>
        <h2>评论</h2>
        <button type="button" onClick={onClose}>
          关闭评论
        </button>
      </header>
      {editable && draft && (
        <form
          onSubmit={(event) =>
            submit(event, (body) => {
              session.comments.create(draft, body);
              onDraftChange(null);
            })
          }
        >
          <blockquote>{excerpt(draft)}</blockquote>
          <textarea
            autoFocus
            name="body"
            aria-label="新评论"
            maxLength={MAX_COMMENT_LENGTH}
            required
          />
          <div className={styles.actions}>
            <button type="submit">发布评论</button>
            <button type="button" onClick={() => onDraftChange(null)}>
              取消
            </button>
          </div>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {!threads.length && !draft && <p>暂无评论</p>}
      {threads.map((thread) => (
        <article className={styles.thread} key={thread.id}>
          <button
            type="button"
            className={styles.anchor}
            onClick={() => onLocate(thread.anchor)}
          >
            {excerpt(thread.anchor)}
          </button>
          {thread.messages.map((message, index) => (
            <div className={styles.message} key={index}>
              <strong>{message.author}</strong>
              <p>{message.body}</p>
            </div>
          ))}
          {editable && !thread.resolved && (
            <form
              onSubmit={(event) =>
                submit(event, (body) => session.comments.reply(thread.id, body))
              }
            >
              <textarea
                name="body"
                aria-label="回复内容"
                maxLength={MAX_COMMENT_LENGTH}
                required
              />
              <button type="submit">回复</button>
            </form>
          )}
          {thread.resolved && <p>已解决</p>}
          {editable && (
            <button
              type="button"
              onClick={() =>
                session.comments.setResolved(thread.id, !thread.resolved)
              }
            >
              {thread.resolved ? '重新打开' : '标记为已解决'}
            </button>
          )}
        </article>
      ))}
    </aside>
  );
}
