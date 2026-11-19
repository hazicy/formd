import { Button } from '../../ui';
import type { CommentInboxItem, FormdClient } from '@formd/client';
import { useEffect, useState } from 'react';
import styles from '../../styles/workspace.module.css';

export function CommentInbox({
  client,
  name,
  onOpen,
}: {
  client: FormdClient;
  name: string;
  onOpen: (item: CommentInboxItem) => void;
}) {
  const [items, setItems] = useState<CommentInboxItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const result = await client.commentInbox(name, controller.signal);
        if (!controller.signal.aborted) {
          setItems(result);
          setFailed(false);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [client, name, attempt]);

  return (
    <section className={styles['comment-inbox']} aria-label="待我处理的讨论">
      {failed && (
        <p role="alert">
          无法刷新讨论。{' '}
          <Button onClick={() => setAttempt((value) => value + 1)}>重试</Button>
        </p>
      )}
      {!failed && !items && <p role="status">正在加载讨论…</p>}
      {!failed && items?.length === 0 && (
        <p>暂无待处理的讨论。别人 @你或回复你发起的讨论时，会显示在这里。</p>
      )}
      {!!items?.length && (
        <ul>
          {items.map((item) => (
            <li key={`${item.noteId}:${item.threadId}`}>
              <Button onClick={() => onOpen(item)}>
                <strong>{item.noteTitle}</strong>
                <span>
                  {item.message.author} ·{' '}
                  {item.reason === 'mention' ? '@了你' : '回复了你'}
                  {' · '}
                  <time
                    dateTime={new Date(item.message.createdAt).toISOString()}
                  >
                    {new Date(item.message.createdAt).toLocaleString('zh-CN')}
                  </time>
                </span>
                <span className={styles['inbox-excerpt']}>
                  {item.message.body}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
