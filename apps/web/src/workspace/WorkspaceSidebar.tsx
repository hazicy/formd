import { Button, Input } from '../ui';
import type { Folder, Note, PresenceUser } from '@formd/client';
import {
  SquarePen,
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
  collapsed,
  recent,
  user,
  folders,
  notes,
  busy,
  currentFolderId,
  activeNoteId,
  workspacePage,
  onClose,
  onToggle,
  onCreate,
  onHome,
  onInbox,
  onPlugins,
  onChooseFolder,
  onOpenNote,
  onManage,
  onDownload,
}: {
  open: boolean;
  collapsed: boolean;
  recent: string[];
  user: PresenceUser;
  folders: Folder[];
  notes: Note[];
  busy: boolean;
  currentFolderId: string | null;
  activeNoteId: string;
  workspacePage: 'inbox' | 'plugins' | null;
  onClose: () => void;
  onToggle: () => void;
  onCreate: () => void;
  onHome: () => void;
  onInbox: () => void;
  onPlugins: () => void;
  onChooseFolder: (id: string) => void;
  onOpenNote: (id: string) => void;
  onManage: (entry: Folder | Note, command: EntryCommand) => void;
  onDownload: (note: Note) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const searchingSidebar = Boolean(normalizedQuery);
  const searchResults = searchingSidebar
    ? notes.filter((entry) =>
        entry.title.toLowerCase().includes(normalizedQuery),
      )
    : [];
  const notesById = new Map(notes.map((note) => [note.id, note]));

  return (
    <>
      {open && (
        <div
          className={styles['sidebar-backdrop']}
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={styles.sidebar}
        data-open={open}
        data-collapsed={collapsed}
        aria-label="工作空间侧栏"
      >
        <div className={styles.brand}>
          <img
            src={`${import.meta.env.BASE_URL}formd.svg`}
            className={styles['brand-mark']}
            alt=""
            width={28}
            height={28}
          />
          <span>Formd</span>
          <Button
            className={styles['icon-action']}
            aria-label="搜索全部文档"
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen(!searchOpen);
              if (searchOpen) setQuery('');
            }}
          >
            <Search size={16} />
          </Button>
          <Button
            className={styles['icon-action']}
            aria-label="关闭侧栏"
            onClick={onToggle}
          >
            <PanelLeftClose size={16} />
          </Button>
        </div>
        {searchOpen && (
          <div className={styles.search} role="search" aria-label="文档库">
            <Search size={15} aria-hidden="true" />
            <Input
              autoFocus
              type="search"
              aria-label="全局搜索文档"
              placeholder="搜索全部文档…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}
        <Button className={styles.note} disabled={busy} onClick={onCreate}>
          <SquarePen size={16} /> 新建文档
        </Button>
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
        <div className={styles['sidebar-content']}>
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
                      aria-current={
                        activeNoteId === note.id ? 'page' : undefined
                      }
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
          {!searchingSidebar && (
            <div className={styles['section-label']}>文件与文件夹</div>
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
          {!searchingSidebar && !folders.length && !notes.length && (
            <p className={styles['sidebar-empty']}>暂无文件</p>
          )}
          {!searchingSidebar && (
            <nav aria-label="最近访问">
              <div className={styles['section-label']}>最近访问</div>
              {recent.map((id) => {
                const note = notesById.get(id);
                return (
                  note && (
                    <Button
                      key={id}
                      className={`${styles.note} ${activeNoteId === id ? styles.active : ''}`}
                      aria-current={activeNoteId === id ? 'page' : undefined}
                      onClick={() => onOpenNote(id)}
                    >
                      <span>{note.title}</span>
                    </Button>
                  )
                );
              })}
              {!recent.some((id) => notesById.has(id)) && (
                <p className={styles['sidebar-empty']}>暂无访问记录</p>
              )}
            </nav>
          )}
        </div>
        <div className={styles['sidebar-profile']}>
          <span
            className={styles.avatar}
            style={{ backgroundColor: user.color }}
            aria-hidden="true"
          >
            {user.name.slice(0, 1)}
          </span>
          <span className={styles['profile-name']} title={user.name}>
            {user.name}
          </span>
        </div>
      </aside>
    </>
  );
}
