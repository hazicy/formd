import {
  markdownFilename,
  type CommentInboxItem,
  type FormdClient,
  type Note,
  type NoteSession,
  type PresenceUser,
  type RelativeSelection,
} from '@formd/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarkdownEditorHandle } from './MarkdownEditor';

export const statusLabels = {
  connecting: '正在连接',
  connected: '实时同步已连接',
  offline: '离线 · 等待重连',
  deleted: '文档已被删除',
  error: '同步失败 · 请备份内容',
};
export function useDocumentEditor({
  client,
  noteId,
  note,
  onNoteUpdated,
  reportError,
}: {
  client: FormdClient;
  noteId: string;
  note: Note | undefined;
  onNoteUpdated: (note: Note) => void;
  reportError: (message: string) => void;
}) {
  const [documentSize, setDocumentSize] = useState({ length: 0, lines: 1 });
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<keyof typeof statusLabels>('connecting');
  const sessionRef = useRef<NoteSession | null>(null);
  const [activeSession, setActiveSession] = useState<NoteSession | null>(null);
  const noteSession = activeSession?.id === noteId ? activeSession : null;
  const [commentPanel, setCommentPanel] = useState<{
    noteId: string;
    draft: RelativeSelection | null;
  } | null>(null);
  const [commentTarget, setCommentTarget] = useState<CommentInboxItem | null>(
    null,
  );
  const pendingCommentTarget = useRef<CommentInboxItem | null>(null);
  const commentsOpen = commentPanel?.noteId === noteId;
  const commentDraft = commentsOpen ? commentPanel.draft : null;
  function setCommentDraft(draft: RelativeSelection | null) {
    setCommentPanel({ noteId, draft });
  }
  function openInboxComment(item: CommentInboxItem) {
    setCommentPanel({ noteId: item.noteId, draft: null });
    setCommentTarget(item);
    pendingCommentTarget.current = item;
  }
  function clearCommentTarget() {
    setCommentTarget(null);
    pendingCommentTarget.current = null;
  }
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const titleDirty = useRef(false);
  const titleVersion = useRef(0);
  useEffect(() => {
    if (
      !commentTarget ||
      commentTarget.noteId !== noteSession?.id ||
      status !== 'connected' ||
      noteSession.status !== 'connected'
    )
      return;
    const frame = requestAnimationFrame(() => {
      if (pendingCommentTarget.current !== commentTarget) return;
      pendingCommentTarget.current = null;
      editorRef.current?.locateComment(commentTarget.anchor);
    });
    return () => cancelAnimationFrame(frame);
  }, [commentTarget, noteSession, status]);
  useEffect(() => {
    if (!noteId) return;
    titleDirty.current = false;
    const active = client.connect(noteId);
    sessionRef.current = active;
    setActiveSession(active);
    const update = () => {
      setStatus(active.status);
    };
    update();
    const unsubscribe = active.subscribe(update);
    return () => {
      unsubscribe();
      active.destroy();
      sessionRef.current = null;
    };
  }, [client, noteId]);
  useEffect(() => {
    if (!titleDirty.current) setTitle(note?.title || '');
  }, [note?.title, noteId]);
  async function saveTitle() {
    if (!titleDirty.current || !note) return;
    const id = note.id;
    const version = titleVersion.current;
    try {
      const updated = await client.rename(id, title);
      onNoteUpdated(updated);
      if (location.hash.slice(1) === id && titleVersion.current === version) {
        titleDirty.current = false;
        setTitle(updated.title);
      }
    } catch (e) {
      reportError(String(e));
    }
  }
  const addComment = useCallback(
    (draft: RelativeSelection) => setCommentPanel({ noteId, draft }),
    [noteId],
  );
  async function downloadMarkdown(target: Note) {
    try {
      const active = noteSession?.id === target.id ? noteSession : null;
      const local =
        active &&
        (active.status === 'connected' || active.status === 'offline');
      const content = local
        ? active.text.toString()
        : (await client.readContent(target.id)).content;
      const url = URL.createObjectURL(
        new Blob([content], { type: 'text/markdown;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = markdownFilename(local ? title : target.title);
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      reportError(String(error));
    }
  }
  const editable = !!note && (status === 'connected' || status === 'offline');

  return {
    noteSession,
    editorRef,
    status,
    editable,
    title,
    saveTitle,
    editTitle: (value: string) => {
      titleDirty.current = true;
      titleVersion.current++;
      setTitle(value);
    },
    documentSize,
    setDocumentSize,
    commentsOpen,
    commentDraft,
    setCommentDraft,
    closeComments: () => setCommentPanel(null),
    addComment,
    downloadMarkdown,
    openInboxComment,
    clearCommentTarget,
    activeThreadId:
      commentTarget?.noteId === noteId ? commentTarget.threadId : undefined,
    updatePresence: (user: PresenceUser) => sessionRef.current?.setUser(user),
  };
}
