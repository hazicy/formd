import { Button, Input } from '../../ui';
import type { Note, PresenceUser } from '@formd/client';
import {
  BookOpen,
  ChevronRight,
  Menu,
  MessageSquare,
  Plus,
  Share2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { CommentsPanel } from '../comments/CommentsPanel';
import { PresencePanel } from '../presence/PresencePanel';
import styles from '../../styles/workspace.module.css';
import { MarkdownEditor } from './MarkdownEditor';
import { statusLabels, type useDocumentEditor } from './useDocumentEditor';

export function DocumentEditor({
  editor,
  noteId,
  note,
  folderBreadcrumb,
  user,
  loading,
  busy,
  onUserChange,
  onOpenSidebar,
  onCloseNote,
  onCreateNote,
  notify,
  reportError,
  children,
}: {
  editor: ReturnType<typeof useDocumentEditor>;
  noteId: string;
  note: Note | undefined;
  folderBreadcrumb: string | null;
  user: PresenceUser;
  loading: boolean;
  busy: boolean;
  onUserChange: (profile: PresenceUser) => void;
  onOpenSidebar: () => void;
  onCloseNote: () => void;
  onCreateNote: () => void;
  notify: (message: string) => void;
  reportError: (message: string) => void;
  children: ReactNode;
}) {
  const {
    noteSession,
    editorRef,
    status,
    editable,
    title,
    saveTitle,
    editTitle,
    documentSize,
    setDocumentSize,
    commentsOpen,
    commentDraft,
    setCommentDraft,
    closeComments,
    addComment,
    activeThreadId,
  } = editor;
  function toggleComments() {
    if (commentsOpen) closeComments();
    else setCommentDraft(null);
  }
  async function shareNote() {
    try {
      await navigator.clipboard.writeText(location.href);
      notify('协作链接已复制');
    } catch {
      reportError('复制失败，请直接复制浏览器地址');
    }
  }

  return (
    <>
      <header className={styles.topbar}>
        <div className={styles.breadcrumb}>
          <Button
            className={styles['mobile-menu']}
            aria-label="打开侧栏"
            onClick={onOpenSidebar}
          >
            <Menu size={18} />
          </Button>
          <Button onClick={onCloseNote}>文档库</Button>
          {folderBreadcrumb !== null && (
            <>
              <ChevronRight size={13} />
              <strong>{folderBreadcrumb}</strong>
            </>
          )}
        </div>
        <div className={styles.actions}>
          {note && noteSession && (
            <PresencePanel
              key={noteId}
              session={noteSession}
              user={user}
              onUserChange={onUserChange}
            />
          )}
          {note && (
            <>
              <span
                className={styles.status}
                role="img"
                tabIndex={0}
                aria-label={statusLabels[status]}
              >
                <span
                  className={`${styles.dot} ${status !== 'connected' ? styles.offline : ''}`}
                />
                <span className={styles['status-tooltip']} aria-hidden="true">
                  {statusLabels[status]}
                </span>
              </span>
              <Button
                aria-label="评论"
                className={styles['icon-action']}
                title="查看评论"
                aria-pressed={commentsOpen}
                onClick={toggleComments}
              >
                <MessageSquare size={16} />
              </Button>
              <Button
                aria-label="分享文档"
                className={styles.primary}
                onClick={shareNote}
              >
                <Share2 size={14} />
                <span className={styles.label}>分享文档</span>
              </Button>
            </>
          )}
        </div>
      </header>
      {children}
      {note ? (
        <>
          {(status === 'deleted' ||
            status === 'error' ||
            status === 'offline') && (
            <div className={styles.error} role="status">
              {statusLabels[status]}
              {status === 'offline'
                ? '；当前修改仅保留在内存，请保持页面打开或导出备份。'
                : '，可导出当前内容备份。'}
            </div>
          )}
          <div className={styles['editor-area']}>
            <div className={styles['editor-column']}>
              <div className={styles['document-heading']}>
                <Input
                  className={styles.title}
                  aria-label="文档标题"
                  maxLength={160}
                  value={title}
                  onChange={(event) => editTitle(event.target.value)}
                  onBlur={() => void saveTitle()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                />
              </div>
              {noteSession && (
                <MarkdownEditor
                  key={noteId}
                  ref={editorRef}
                  session={noteSession}
                  readOnly={!editable}
                  onDocumentSizeChange={setDocumentSize}
                  onComment={addComment}
                />
              )}
            </div>
            {noteSession && commentsOpen && (
              <CommentsPanel
                key={`comments-${noteId}`}
                session={noteSession}
                editable={editable}
                draft={commentDraft}
                activeThreadId={activeThreadId}
                onDraftChange={setCommentDraft}
                onClose={closeComments}
                onLocate={(anchor) => editorRef.current?.locateComment(anchor)}
              />
            )}
          </div>
          <footer className={styles.bottom}>
            <span>
              Markdown{' '}
              <span className={styles['document-count']}>
                {documentSize.length.toLocaleString()} 字符 ·{' '}
                {documentSize.lines} 行
              </span>
            </span>
          </footer>
        </>
      ) : (
        <div className={styles.empty}>
          <BookOpen size={42} />
          <h2>{loading ? '正在打开工作空间…' : '未找到文档'}</h2>
          <p>文档不存在或已被删除，请选择其他文档。</p>
          <Button
            className={styles.primary}
            disabled={busy}
            onClick={onCreateNote}
          >
            <Plus size={16} />
            新建文档
          </Button>
        </div>
      )}
    </>
  );
}
