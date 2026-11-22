import { Button } from '../ui';
import {
  FormdClient,
  type CommentInboxItem,
  type PresenceUser,
} from '@formd/client';
import { useEffect, useState } from 'react';
import { CommentInbox } from '../features/comments/CommentInbox';
import { DocumentEditor } from '../features/editor/DocumentEditor';
import { useDocumentEditor } from '../features/editor/useDocumentEditor';
import {
  DocumentLibrary,
  LibraryHeader,
} from '../features/library/DocumentLibrary';
import { ActionDialog } from '../features/library/LibraryControls';
import { useDocumentLibrary } from '../features/library/useDocumentLibrary';
import { loadProfile, saveProfile } from '../features/presence/profile';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import styles from '../styles/workspace.module.css';

const initialProfile = loadProfile();
const client = new FormdClient(
  import.meta.env.VITE_API_URL || 'http://localhost:3001',
  initialProfile,
);

type WorkspacePage = 'inbox' | 'plugins';

function readNoteId() {
  return location.hash.slice(1);
}

export function Workspace() {
  const [user, setUser] = useState(initialProfile);
  const [noteId, setNoteId] = useState(readNoteId);
  const [workspacePage, setWorkspacePage] = useState<WorkspacePage | null>(
    null,
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const library = useDocumentLibrary({
    client,
    noteId,
    openNote,
    reportError: setError,
    notify: setToast,
  });
  const { selectedNote } = library;
  const editor = useDocumentEditor({
    client,
    noteId,
    note: selectedNote,
    onNoteUpdated: library.updateNote,
    reportError: setError,
  });

  useEffect(() => {
    const syncNoteId = () => setNoteId(readNoteId());
    window.addEventListener('hashchange', syncNoteId);
    return () => window.removeEventListener('hashchange', syncNoteId);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function openNote(id: string) {
    setWorkspacePage(null);
    editor.clearCommentTarget();
    if (id) location.hash = id;
    else if (location.hash)
      history.pushState(null, '', location.pathname + location.search);
    setNoteId(id);
    setSidebarOpen(false);
  }

  function openPage(page: WorkspacePage) {
    openNote('');
    setWorkspacePage(page);
  }

  function openInboxItem(item: CommentInboxItem) {
    openNote(item.noteId);
    editor.openInboxComment(item);
  }

  function updateProfile(profile: PresenceUser) {
    setUser(profile);
    editor.updatePresence(profile);
    client.user = profile;
    saveProfile(profile);
  }

  const openSidebar = () => {
    setSidebarCollapsed(false);
    setSidebarOpen(true);
  };
  const errorNotice = error && (
    <div className={styles.error} role="alert">
      <span>{error}</span>
      <Button onClick={() => void library.refresh()}>重试</Button>
    </div>
  );

  return (  
    <div className={styles.app} data-sidebar-collapsed={sidebarCollapsed}>
      <WorkspaceSidebar
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        recent={library.recent}
        onToggle={() => {
          if (window.matchMedia('(max-width: 700px)').matches)
            setSidebarOpen(false);
          else setSidebarCollapsed(true);
        }}
        onCreate={library.createNote}
        user={user}
        folders={library.folders}
        notes={library.notes}
        busy={library.busy}
        currentFolderId={library.currentFolderId}
        activeNoteId={noteId}
        workspacePage={workspacePage}
        onClose={() => setSidebarOpen(false)}
        onHome={() => {
          setQuery('');
          library.chooseFolder(null);
          library.setView('all');
          openNote('');
        }}
        onInbox={() => openPage('inbox')}
        onPlugins={() => openPage('plugins')}
        onChooseFolder={(id) => {
          library.chooseFolder(id);
          if (noteId || workspacePage) openNote('');
          else setSidebarOpen(false);
        }}
        onOpenNote={openNote}
        onManage={library.manageEntry}
        onDownload={editor.downloadMarkdown}
      />
      <main className={styles.main}>
        {noteId ? (
          <DocumentEditor
            editor={editor}
            noteId={noteId}
            note={selectedNote}
            folderBreadcrumb={
              selectedNote?.folderId
                ? library.folderPath(selectedNote.folderId)
                : null
            }
            user={user}
            loading={library.loading}
            busy={library.busy}
            onUserChange={updateProfile}
            onOpenSidebar={openSidebar}
            onCloseNote={() => openNote('')}
            onCreateNote={library.createNote}
            notify={setToast}
            reportError={setError}
          >
            {errorNotice}
          </DocumentEditor>
        ) : workspacePage ? (
          <>
            <LibraryHeader
              title={workspacePage === 'inbox' ? '待我处理' : '插件'}
              onOpenSidebar={openSidebar}
            />
            {errorNotice}
            {workspacePage === 'inbox' ? (
              <CommentInbox
                key={user.name}
                client={client}
                name={user.name}
                onOpen={openInboxItem}
              />
            ) : (
              <section
                className={styles['document-list']}
                aria-label="插件列表"
              >
                <p className={styles.empty}>暂无可用插件。</p>
              </section>
            )}
          </>
        ) : (
          <DocumentLibrary
            library={library}
            query={query}
            onQueryChange={setQuery}
            onOpenSidebar={openSidebar}
            onOpenNote={openNote}
            onDownload={editor.downloadMarkdown}
          >
            {errorNotice}
          </DocumentLibrary>
        )}
      </main>
      {library.action && (
        <ActionDialog action={library.action} close={library.dismissAction} />
      )}
      {toast && (
        <div className={styles.toast} role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
