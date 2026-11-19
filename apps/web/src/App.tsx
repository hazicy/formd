import {
  ActionDialog,
  EntryMenu,
  type EntryCommand,
  FolderTree,
  type WorkspaceAction,
} from './WorkspaceControls';
import { Button } from '@base-ui/react/button';
import { Input } from '@base-ui/react/input';
import styles from './App.module.css';
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';
import { CommentsPanel } from './CommentsPanel';
import { CommentInbox } from './CommentInbox';
import { PresencePanel } from './PresencePanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  Search,
  FileText,
  Star,
  FolderPlus,
  House,
  Inbox,
  Puzzle,
  Feather,
  ChevronRight,
  Share2,
  Menu,
  PanelLeftClose,
  Clock,
  BookOpen,
  PanelLeft,
  MessageSquare,
} from 'lucide-react';
import {
  FormdClient,
  markdownFilename,
  type Note,
  type CommentInboxItem,
  type Folder,
  type NoteSession,
  type PresenceUser,
  type RelativeSelection,
  createGuestUser,
  validPresenceUser,
} from '@formd/client';
function loadProfile(): PresenceUser {
  try {
    const saved = JSON.parse(
      localStorage.getItem('formd.profile') ??
        localStorage.getItem('typo.profile') ??
        'null',
    );
    if (validPresenceUser(saved)) return { ...saved, client: 'web' };
  } catch {
    /* anonymous defaults */
  }
  const guest = createGuestUser('web');
  try {
    localStorage.setItem('formd.profile', JSON.stringify(guest));
  } catch {
    /* private browsing */
  }
  return guest;
}
const initialProfile = loadProfile();
const client = new FormdClient(
  import.meta.env.VITE_API_URL || 'http://localhost:3001',
  initialProfile,
);
const statusLabels = {
  connecting: '正在连接',
  connected: '实时同步已连接',
  offline: '离线 · 等待重连',
  deleted: '文档已被删除',
  error: '同步失败 · 请备份内容',
};
const documentViews = {
  all: '全部文档',
  recent: '最近访问',
  favorites: '收藏',
} as const;

function savedIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [user, setUser] = useState<PresenceUser>(initialProfile);
  function updateUser(next: PresenceUser) {
    setUser(next);
    session.current?.setUser(next);
    client.user = next;
    try {
      localStorage.setItem('formd.profile', JSON.stringify(next));
    } catch {
      /* private browsing */
    }
  }
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const refreshVersion = useRef(0);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState(location.hash.slice(1));
  const [view, setView] = useState<keyof typeof documentViews>('all');
  const [workspacePage, setWorkspacePage] = useState<'inbox' | 'plugins' | null>(null);
  const [commentTarget, setCommentTarget] = useState<CommentInboxItem | null>(null);
  const pendingCommentTarget = useRef<CommentInboxItem | null>(null);
  const [favorites, setFavorites] = useState(() => savedIds('formd.favorites'));
  const [recent, setRecent] = useState(() => savedIds('formd.recent'));
  const [action, setAction] = useState<WorkspaceAction | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem('formd.favorites', JSON.stringify(favorites));
      localStorage.setItem('formd.recent', JSON.stringify(recent));
    } catch {
      /* storage may be disabled */
    }
  }, [favorites, recent]);
  const [query, setQuery] = useState('');
  const [documentSize, setDocumentSize] = useState({ length: 0, lines: 1 });
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<keyof typeof statusLabels>('connecting');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const session = useRef<NoteSession | null>(null);
  const [activeSession, setActiveSession] = useState<NoteSession | null>(null);
  const displayedSession =
    activeSession?.id === selected ? activeSession : null;
  const [commentPanel, setCommentPanel] = useState<{
    noteId: string;
    draft: RelativeSelection | null;
  } | null>(null);
  const commentsOpen = commentPanel?.noteId === selected;
  const input = useRef<MarkdownEditorHandle>(null);
  const titleDirty = useRef(false);
  const titleVersion = useRef(0);
  const note = notes.find((n) => n.id === selected);
  const currentFolder = folders.find((folder) => folder.id === folderId);
  const currentFolderId = currentFolder?.id ?? null;
  const normalizedQuery = query.trim().toLowerCase();
  const searchingSidebar = Boolean(normalizedQuery);
  const searchResults = searchingSidebar
    ? notes.filter((entry) => entry.title.toLowerCase().includes(normalizedQuery))
    : [];
  const favoriteIds = new Set(favorites);
  const recentOrder = new Map(recent.map((id, index) => [id, index]));
  const dashboardNotes = notes.filter(
    (entry) =>
      (!currentFolderId || entry.folderId === currentFolderId) &&
      (view !== 'favorites' || favoriteIds.has(entry.id)) &&
      (view !== 'recent' || recentOrder.has(entry.id)),
  );
  if (view === 'recent')
    dashboardNotes.sort(
      (a, b) => recentOrder.get(a.id)! - recentOrder.get(b.id)!,
    );
  useEffect(() => {
    if (note)
      setRecent((previous) =>
        [note.id, ...previous.filter((id) => id !== note.id)].slice(0, 100),
      );
  }, [note?.id]);
  function toggleFavorite(id: string) {
    setFavorites((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id],
    );
  }
  const byFolderId = new Map(folders.map((folder) => [folder.id, folder]));
  function folderPath(id: string) {
    const names: string[] = [];
    let folder = byFolderId.get(id);
    while (folder) {
      names.unshift(folder.name);
      folder = folder.parentId ? byFolderId.get(folder.parentId) : undefined;
    }
    return names.join(' / ');
  }
  const folderOptions = [
    { value: '', label: '根目录' },
    ...folders.map((folder) => ({
      value: folder.id,
      label: folderPath(folder.id),
    })),
  ];
  async function mutateFolder(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  function select(id: string) {
    setWorkspacePage(null);
    setCommentTarget(null);
    pendingCommentTarget.current = null;
    if (id) location.hash = id;
    else if (location.hash)
      history.pushState(null, '', location.pathname + location.search);
    setSelected(id);
    setSidebar(false);
  }
  function openInboxItem(item: CommentInboxItem) {
    select(item.noteId);
    setCommentPanel({ noteId: item.noteId, draft: null });
    setCommentTarget(item);
    pendingCommentTarget.current = item;
  }
  useEffect(() => {
    if (
      !commentTarget ||
      commentTarget.noteId !== displayedSession?.id ||
      status !== 'connected' ||
      displayedSession.status !== 'connected'
    )
      return;
    const frame = requestAnimationFrame(() => {
      if (pendingCommentTarget.current !== commentTarget) return;
      pendingCommentTarget.current = null;
      input.current?.locateComment(commentTarget.anchor);
    });
    return () => cancelAnimationFrame(frame);
  }, [commentTarget, displayedSession, status]);
  async function refresh() {
    const version = ++refreshVersion.current;
    try {
      const [data, directories] = await Promise.all([
        client.list(),
        client.listFolders(),
      ]);
      if (version === refreshVersion.current) {
        setFolders(directories);
        setNotes(data);
        setError('');
      }
      return data;
    } catch (e) {
      if (version === refreshVersion.current) setError(String(e));
      return null;
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const onHash = () => setSelected(location.hash.slice(1));
    window.addEventListener('hashchange', onHash);
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  useEffect(() => {
    if (!selected) return;
    titleDirty.current = false;
    const active = client.connect(selected);
    session.current = active;
    setActiveSession(active);
    const update = () => {
      setStatus(active.status);
    };
    update();
    const unsubscribe = active.subscribe(update);
    return () => {
      unsubscribe();
      active.destroy();
      session.current = null;
    };
  }, [selected]);
  useEffect(() => {
    if (!titleDirty.current) setTitle(note?.title || '');
  }, [note?.title, selected]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);
  async function create() {
    setBusy(true);
    try {
      const n = await client.create(undefined, undefined, currentFolderId);
      setNotes((prev) => [n, ...prev]);
      select(n.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function rename() {
    if (!titleDirty.current || !note) return;
    const id = note.id;
    const version = titleVersion.current;
    try {
      const updated = await client.rename(id, title);
      setNotes((prev) => prev.map((n) => (n.id === id ? updated : n)));
      if (location.hash.slice(1) === id && titleVersion.current === version) {
        titleDirty.current = false;
        setTitle(updated.title);
      }
    } catch (e) {
      setError(String(e));
    }
  }
  async function remove(target: Note) {
    setBusy(true);
    try {
      await client.delete(target.id);
      const next = notes.filter((n) => n.id !== target.id);
      setNotes((entries) => entries.filter((entry) => entry.id !== target.id));
      if (location.hash.slice(1) === target.id) select(next[0]?.id || '');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const addComment = useCallback(
    (draft: RelativeSelection) => setCommentPanel({ noteId: selected, draft }),
    [selected],
  );
  async function download(target: Note) {
    try {
      const active = displayedSession?.id === target.id ? displayedSession : null;
      const local = active && (active.status === 'connected' || active.status === 'offline');
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
      setError(String(error));
    }
  }
  const editable = !!note && (status === 'connected' || status === 'offline');
  function manageEntry(entry: Folder | Note, command: EntryCommand) {
    if ('parentId' in entry) {
      manageFolder(entry, command);
      return;
    }

    if (command === 'rename') {
      setAction({
        title: '重命名文档',
        initialName: entry.title,
        run: (name) => void mutateFolder(() => client.rename(entry.id, name)),
      });
    } else if (command === 'move') {
      setAction({
        title: '移动文档',
        destination: {
          initialValue: entry.folderId ?? '',
          options: folderOptions,
        },
        run: (value) =>
          void mutateFolder(() => client.move(entry.id, value || null)),
      });
    } else {
      setAction({
        title: `删除「${entry.title}」？`,
        description: '此操作无法撤销。',
        run: () => void remove(entry),
      });
    }
  }

  function manageFolder(folder: Folder, command: EntryCommand) {
    if (command === 'rename') {
      setAction({
        title: '重命名文件夹',
        initialName: folder.name,
        run: (name) =>
          void mutateFolder(() => client.updateFolder(folder.id, { name })),
      });
    } else if (command === 'move') {
      setAction({
        title: '移动文件夹',
        destination: {
          initialValue: folder.parentId ?? '',
          options: folderOptions.filter((option) => {
            let target = byFolderId.get(option.value);
            while (target) {
              if (target.id === folder.id) return false;
              target = target.parentId ? byFolderId.get(target.parentId) : undefined;
            }
            return true;
          }),
        },
        run: (value) =>
          void mutateFolder(() =>
            client.updateFolder(folder.id, { parentId: value || null }),
          ),
      });
    } else {
      setAction({
        title: `删除「${folderPath(folder.id) || folder.name}」？`,
        description: '只删除这个文件夹。里面的文档和子文件夹会移到上一级，同名子文件夹会自动加编号。',
        run: () =>
          void mutateFolder(async () => {
            const { parentId = folder.parentId } = await client.deleteFolder(folder.id);
            setFolderId((id) => (id === folder.id ? parentId : id));
            setToast(`已删除「${folder.name}」，内容保留在上一级`);
          }),
      });
    }
  }

  return (
    <div className={styles.app}>
      <aside className={`${styles.sidebar} ${sidebar ? '' : styles.hidden}`}>
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
            onClick={() => setSidebar(false)}
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
            className={`${styles.note} ${!selected && !workspacePage && !currentFolderId ? styles.active : ''}`}
            aria-current={!selected && !workspacePage && !currentFolderId ? 'page' : undefined}
            onClick={() => {
              setQuery('');
              setFolderId(null);
              setView('all');
              select('');
            }}
          >
            <House size={16} /> 首页
          </Button>
          <Button
            className={`${styles.note} ${workspacePage === 'inbox' && !selected ? styles.active : ''}`}
            aria-current={workspacePage === 'inbox' && !selected ? 'page' : undefined}
            onClick={() => {
              select('');
              setWorkspacePage('inbox');
            }}
          >
            <Inbox size={16} /> 待我处理
          </Button>
          <Button
            className={`${styles.note} ${workspacePage === 'plugins' && !selected ? styles.active : ''}`}
            aria-current={workspacePage === 'plugins' && !selected ? 'page' : undefined}
            onClick={() => {
              select('');
              setWorkspacePage('plugins');
            }}
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
              {searchResults.map((n) => (
                <div key={n.id} className={styles['tree-entry-row']}>
                  <Button
                    className={`${styles.note} ${selected === n.id ? styles.active : ''}`}
                    onClick={() => select(n.id)}
                    aria-current={selected === n.id ? 'page' : undefined}
                  >
                    <FileText size={15} />
                    <span>{n.title}</span>
                  </Button>
                  <EntryMenu
                    name={n.title}
                    busy={busy}
                    onManage={(command) => manageEntry(n, command)}
                    onDownload={() => void download(n)}
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
          activeNote={selected}
          hidden={searchingSidebar}
          busy={busy}
          onManage={manageEntry}
          onDownload={(entry) => void download(entry)}
          onOpen={select}
          onChoose={(id) => {
            setFolderId(id);
            if (selected || workspacePage) select('');
          }}
        />
        <div className={styles['sidebar-footer']}>
          <div
            className={styles.avatar}
            style={{ backgroundColor: user.color }}
          >
            {user.name.slice(0, 1)}
          </div>
          <span>{user.name}</span>
        </div>
      </aside>
      <main className={styles.main}>
        {selected ? (
          <header className={styles.topbar}>
            <div className={styles.breadcrumb}>
              <Button
                className={styles['mobile-menu']}
                aria-label="打开侧栏"
                onClick={() => setSidebar(true)}
              >
                <Menu size={18} />
              </Button>
              <Button onClick={() => select('')}>文档库</Button>
              {note?.folderId && (
                <>
                  <ChevronRight size={13} />
                  <strong>{folderPath(note.folderId)}</strong>
                </>
              )}
            </div>
            <div className={styles.actions}>
              {note && displayedSession && (
                <PresencePanel
                  key={selected}
                  session={displayedSession}
                  user={user}
                  onUserChange={updateUser}
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
                    title="查看评论"
                    aria-pressed={commentsOpen}
                    onClick={() =>
                      setCommentPanel(
                        commentsOpen ? null : { noteId: selected, draft: null },
                      )
                    }
                  >
                    <MessageSquare size={16} />
                  </Button>
                  <Button
                    aria-label="分享文档"
                    className={styles.primary}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(location.href)
                        .then(() => setToast('协作链接已复制'))
                        .catch(() =>
                          setError('复制失败，请直接复制浏览器地址'),
                        );
                    }}
                  >
                    <Share2 size={14} />
                    <span className={styles.label}>分享文档</span>
                  </Button>
                </>
              )}
            </div>
          </header>
        ) : workspacePage ? (
          <header className={styles['list-header']}>
            <div className={styles['list-title']}>
              <Button
                className={styles['mobile-menu']}
                aria-label="打开侧栏"
                onClick={() => setSidebar(true)}
              >
                <PanelLeft size={16} />
              </Button>
              <h1>{workspacePage === 'inbox' ? '待我处理' : '插件'}</h1>
            </div>
          </header>
        ) : (
          <header className={styles['list-header']}>
            <div className={styles['list-title']}>
              <Button
                className={styles['mobile-menu']}
                aria-label="打开侧栏"
                onClick={() => setSidebar(true)}
              >
                <PanelLeft size={16} />
              </Button>
              <h1>{currentFolder?.name ?? '文档库'}</h1>
              <div className={styles['list-create']}>
                <Button
                  aria-label="新建文件夹"
                  title="新建文件夹"
                  disabled={busy}
                  onClick={() =>
                    setAction({
                      title: '新建文件夹',
                      initialName: '',
                      run: (name) =>
                        void mutateFolder(async () => {
                          const folder = await client.createFolder(
                            name,
                            currentFolderId,
                          );
                          setFolderId(folder.id);
                        }),
                    })
                  }
                >
                  <FolderPlus size={16} />
                </Button>
                <Button
                  className={styles.primary}
                  disabled={busy}
                  onClick={() => void create()}
                >
                  <Plus size={16} /> 新建文档
                </Button>
              </div>
            </div>
            <div
              className={styles['view-filters']}
              role="group"
              aria-label="文档筛选"
            >
              {(
                Object.keys(documentViews) as (keyof typeof documentViews)[]
              ).map((key) => (
                <Button
                  key={key}
                  aria-pressed={view === key}
                  onClick={() => setView(key)}
                >
                  {key === 'recent' ? (
                    <Clock size={14} />
                  ) : key === 'favorites' ? (
                    <Star size={14} />
                  ) : (
                    <FileText size={14} />
                  )}
                  {documentViews[key]}
                </Button>
              ))}
            </div>
          </header>
        )}
        {error && (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            <Button onClick={() => void refresh()}>重试</Button>
          </div>
        )}
        {!selected && workspacePage === 'inbox' ? (
          <CommentInbox
            key={user.name}
            client={client}
            name={user.name}
            onOpen={openInboxItem}
          />
        ) : !selected && workspacePage === 'plugins' ? (
          <section className={styles['document-list']} aria-label="插件列表">
            <p className={styles.empty}>暂无可用插件。</p>
          </section>
        ) : !selected ? (
          <section
            className={styles['document-list']}
            aria-label="工作空间文档"
          >
            <table className={styles['documents-table']}>
              <thead>
                <tr>
                  <th scope="col">标题</th>
                  <th scope="col">位置</th>
                  <th scope="col">创建时间</th>
                  <th scope="col">最近更新</th>
                  <th scope="col" aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {dashboardNotes.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <Button
                        className={styles['document-link']}
                        onClick={() => select(entry.id)}
                      >
                        <FileText size={15} />
                        <span>{entry.title}</span>
                      </Button>
                    </td>
                    <td>
                      {entry.folderId ? folderPath(entry.folderId) : '根目录'}
                    </td>
                    <td>
                      <time dateTime={entry.createdAt}>
                        {new Date(entry.createdAt).toLocaleDateString('zh-CN')}
                      </time>
                    </td>
                    <td>
                      <time dateTime={entry.updatedAt}>
                        {new Date(entry.updatedAt).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </td>
                    <td>
                      <EntryMenu
                        name={entry.title}
                        busy={busy}
                        favorite={{
                          active: favoriteIds.has(entry.id),
                          toggle: () => toggleFavorite(entry.id),
                        }}
                        onManage={(command) => manageEntry(entry, command)}
                        onDownload={() => void download(entry)}
                      />
                    </td>
                  </tr>
                ))}
                {!dashboardNotes.length && (
                  <tr>
                    <td className={styles['list-empty']} colSpan={5}>
                      {loading
                        ? '正在加载文档…'
                        : view === 'recent'
                          ? '暂无访问记录'
                          : view === 'favorites'
                            ? '暂无收藏文档'
                            : '暂无文档'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        ) : note ? (
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
                    onChange={(e) => {
                      titleDirty.current = true;
                      titleVersion.current++;
                      setTitle(e.target.value);
                    }}
                    onBlur={() => void rename()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                </div>
                {displayedSession && (
                  <MarkdownEditor
                    key={selected}
                    ref={input}
                    session={displayedSession}
                    readOnly={!editable}
                    onDocumentSizeChange={setDocumentSize}
                    onComment={addComment}
                  />
                )}
              </div>
              {displayedSession && commentsOpen && (
                <CommentsPanel
                  key={`comments-${selected}`}
                  session={displayedSession}
                  editable={editable}
                  draft={commentPanel.draft}
                  activeThreadId={
                    commentTarget?.noteId === selected
                      ? commentTarget.threadId
                      : undefined
                  }
                  onDraftChange={(draft) =>
                    setCommentPanel({ noteId: selected, draft })
                  }
                  onClose={() => setCommentPanel(null)}
                  onLocate={(anchor) => input.current?.locateComment(anchor)}
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
            <p>
              {selected
                ? '文档不存在或已被删除，请选择其他文档。'
                : '新建一篇文档，开始记录你的想法。'}
            </p>
            <Button
              className={styles.primary}
              disabled={busy}
              onClick={() => void create()}
            >
              <Plus size={16} />
              新建文档
            </Button>
          </div>
        )}
      </main>
      {action && <ActionDialog action={action} close={() => setAction(null)} />}
      {toast && (
        <div className={styles.toast} role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
