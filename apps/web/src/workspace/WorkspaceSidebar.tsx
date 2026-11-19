import { Button } from '@base-ui/react/button';
import { Input } from '@base-ui/react/input';
import type { Folder, Note, PresenceUser } from '@formd/client';
import {
  Feather,
  FileText,
  House,
  Inbox,
  PanelLeftClose,
  Puzzle,
  Search,
} from 'lucide-react';
import {
  EntryMenu,
  FolderTree,
  type EntryCommand,
} from '../features/library/LibraryControls';
import { useState } from 'react';
import styles from '../styles/workspace.module.css';

export function WorkspaceSidebar({
  open,
  user,
  folders,
  notes,
  busy,
  currentFolderId,
  activeNoteId,
  workspacePage,
  onClose,
  onHome,
  onInbox,
  onPlugins,
  onChooseFolder,
  onOpenNote,
  onManage,
  onDownload,
}: {
  open: boolean;
  user: PresenceUser;
  folders: Folder[];
  notes: Note[];
  busy: boolean;
  currentFolderId: string | null;
  activeNoteId: string;
  workspacePage: 'inbox' | 'plugins' | null;
  onClose: () => void;
  onHome: () => void;
  onInbox: () => void;
  onPlugins: () => void;
  onChooseFolder: (id: string) => void;
  onOpenNote: (id: string) => void;
  onManage: (entry: Folder | Note, command: EntryCommand) => void;
  onDownload: (note: Note) => void;
}) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const searchingSidebar = Boolean(normalizedQuery);
  const searchResults = searchingSidebar
    ? notes.filter((entry) =>
        entry.title.toLowerCase().includes(normalizedQuery),
      )
    : [];
  return (
    <aside className={`${styles.sidebar} ${open ? '' : styles.hidden}`}>
      <div className={styles.brand}>
        <span className={styles['brand-icon']}>
          <Feather size={15} />
        </span>
        <span>
          Formd<span className={styles['brand-accent']}>.</span>
        </span>
        <Button
          className={styles['sidebar-toggle']}
          aria-label="关闭侧栏"
          onClick={onClose}
        >
          <PanelLeftClose size={16} />
        </Button>
      </div>
      <div className={styles.search} role="search" aria-label="文档库">
        <Search size={15} aria-hidden="true" />
        <Input
          type="search"
          aria-label="全局搜索文档"
          placeholder="搜索全部文档…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <nav className={styles['sidebar-nav']} aria-label="文档库导航">
        <Button
          className={`${styles.note} ${!activeNoteId && !workspacePage && !currentFolderId ? styles.active : ''}`}
          aria-current={
            !activeNoteId && !workspacePage && !currentFolderId
              ? 'page'
              : undefined
          }
          onClick={() => {
            setQuery('');
            onHome();
          }}
        >
          <House size={16} /> 首页
        </Button>
        <Button
          className={`${styles.note} ${workspacePage === 'inbox' && !activeNoteId ? styles.active : ''}`}
          aria-current={
            workspacePage === 'inbox' && !activeNoteId ? 'page' : undefined
          }
          onClick={onInbox}
        >
          <Inbox size={16} /> 待我处理
        </Button>
        <Button
          className={`${styles.note} ${workspacePage === 'plugins' && !activeNoteId ? styles.active : ''}`}
          aria-current={
            workspacePage === 'plugins' && !activeNoteId ? 'page' : undefined
          }
          onClick={onPlugins}
        >
          <Puzzle size={16} /> 插件
        </Button>
      </nav>
      {searchingSidebar && (
        <>
          <div className={styles['section-label']}>
            <span>搜索结果</span>
            <span>{searchResults.length}</span>
          </div>
          <nav className={styles.notes} aria-label="搜索结果">
            {searchResults.map((note) => (
              <div key={note.id} className={styles['tree-entry-row']}>
                <Button
                  className={`${styles.note} ${activeNoteId === note.id ? styles.active : ''}`}
                  onClick={() => onOpenNote(note.id)}
                  aria-current={activeNoteId === note.id ? 'page' : undefined}
                >
                  <FileText size={15} />
                  <span>{note.title}</span>
                </Button>
                <EntryMenu
                  name={note.title}
                  busy={busy}
                  onManage={(command) => onManage(note, command)}
                  onDownload={() => void onDownload(note)}
                />
              </div>
            ))}
            {!searchResults.length && (
              <p className={styles.empty}>没有匹配的文档</p>
            )}
          </nav>
        </>
      )}
      <FolderTree
        folders={folders}
        notes={notes}
        selected={currentFolderId}
        activeNote={activeNoteId}
        hidden={searchingSidebar}
        busy={busy}
        onManage={onManage}
        onDownload={(entry) => void onDownload(entry)}
        onOpen={onOpenNote}
        onChoose={onChooseFolder}
      />
      <div className={styles['sidebar-footer']}>
        <div className={styles.avatar} style={{ backgroundColor: user.color }}>
          {user.name.slice(0, 1)}
        </div>
        <span>{user.name}</span>
      </div>
    </aside>
  );
}
