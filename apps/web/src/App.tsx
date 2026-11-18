import {
  ActionDialog,
  FolderSelect,
  FolderTree,
  type WorkspaceAction,
} from './WorkspaceControls';
import { Button } from '@base-ui/react/button';
import { Input } from '@base-ui/react/input';
import styles from './App.module.css';
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';
import { PresencePanel } from './PresencePanel';
import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  Search,
  FileText,
  Star,
  Library,
  FolderPlus,
  Feather,
  ChevronRight,
  Share2,
  Download,
  Trash2,
  Bold,
  Italic,
  Heading,
  Link,
  Code,
  List,
  Menu,
  PanelLeftClose,
  Clock,
  BookOpen,
  PanelLeft,
} from 'lucide-react';
import {
  FormdClient,
  markdownFilename,
  type Note,
  type Folder,
  type NoteSession,
  type PresenceUser,
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
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState(location.hash.slice(1));
  const [view, setView] = useState<keyof typeof documentViews>('all');
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
  const input = useRef<MarkdownEditorHandle>(null);
  const titleDirty = useRef(false);
  const titleVersion = useRef(0);
  const note = notes.find((n) => n.id === selected);
  const currentFolder = folders.find((folder) => folder.id === folderId);
  const currentFolderId = currentFolder?.id ?? null;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleNotes = notes.filter((entry) =>
    normalizedQuery
      ? entry.title.toLowerCase().includes(normalizedQuery)
      : entry.folderId === currentFolderId,
  );
  const favoriteIds = new Set(favorites);
  const recentOrder = new Map(recent.map((id, index) => [id, index]));
  const dashboardNotes = notes.filter(
    (entry) =>
      (!currentFolderId || entry.folderId === currentFolderId) &&
      (!normalizedQuery ||
        entry.title.toLowerCase().includes(normalizedQuery)) &&
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
    if (id) location.hash = id;
    else if (location.hash)
      history.pushState(null, '', location.pathname + location.search);
    setSelected(id);
    setSidebar(false);
  }
  async function refresh() {
    try {
      const [data, directories] = await Promise.all([
        client.list(),
        client.listFolders(),
      ]);
      setFolders(directories);
      setNotes(data);
      setError('');
      return data;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setLoading(false);
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
  async function remove() {
    if (!note) return;
    setBusy(true);
    try {
      await client.delete(note.id);
      const next = notes.filter((n) => n.id !== note.id);
      setNotes(next);
      select(next[0]?.id || '');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function insert(before: string, after = '') {
    input.current?.insert(before, after);
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([displayedSession?.text.toString() ?? ''], {
        type: 'text/markdown;charset=utf-8',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = markdownFilename(title);
    a.click();
    URL.revokeObjectURL(url);
  }
  const editable = !!note && (status === 'connected' || status === 'offline');
  const searchField = (
    <div className={styles.search}>
      <Search size={15} />
      <Input
        aria-label="搜索文档"
        placeholder="搜索文档…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
    </div>
  );
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
        <div className={styles.workspace}>
          <Library size={15} /> 文档库
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
        </div>
        <Button
          className={`${styles.note} ${!selected && !currentFolderId ? styles.active : ''}`}
          aria-current={!selected && !currentFolderId ? 'page' : undefined}
          onClick={() => {
            setFolderId(null);
            setView('all');
            select('');
          }}
        >
          <FileText size={15} /> 全部文件夹
        </Button>
        <FolderTree
          folders={folders}
          notes={notes}
          selected={currentFolderId}
          activeNote={selected}
          onOpen={select}
          onChoose={(id) => {
            setFolderId(id);
            if (selected) select('');
          }}
        />
        {selected && (
          <FolderSelect
            label="浏览文件夹"
            value={currentFolderId ?? ''}
            options={folderOptions}
            onChange={setFolderId}
          />
        )}
        {currentFolder && (
          <div className={styles['folder-controls']}>
            <Button
              disabled={busy}
              onClick={() =>
                setAction({
                  title: '重命名文件夹',
                  initialName: currentFolder.name,
                  run: (name) =>
                    void mutateFolder(() =>
                      client.updateFolder(currentFolder.id, { name }),
                    ),
                })
              }
            >
              重命名
            </Button>
            <FolderSelect
              label="移动文件夹到"
              value={currentFolder.parentId ?? ''}
              disabled={busy}
              options={folderOptions.filter((option) => {
                let target = byFolderId.get(option.value);
                while (target) {
                  if (target.id === currentFolder.id) return false;
                  target = target.parentId
                    ? byFolderId.get(target.parentId)
                    : undefined;
                }
                return true;
              })}
              onChange={(parentId) =>
                void mutateFolder(() =>
                  client.updateFolder(currentFolder.id, { parentId }),
                )
              }
            />
            <Button
              aria-label="删除文件夹"
              title="删除空文件夹"
              disabled={busy}
              onClick={() =>
                setAction({
                  title: `删除「${currentFolder.name}」？`,
                  description: '只能删除空文件夹，此操作无法撤销。',
                  run: () =>
                    void mutateFolder(async () => {
                      await client.deleteFolder(currentFolder.id);
                      setFolderId(currentFolder.parentId);
                    }),
                })
              }
            >
              <Trash2 size={15} />
            </Button>
          </div>
        )}
        {selected && (
          <>
            {searchField}
            <div className={styles['section-label']}>
              <span>我的文档</span>
              <span>{visibleNotes.length}</span>
            </div>
            <nav className={styles.notes} aria-label="文档列表">
              {visibleNotes.map((n) => (
                <Button
                  key={n.id}
                  className={`${styles.note} ${selected === n.id ? styles.active : ''}`}
                  onClick={() => select(n.id)}
                  aria-current={selected === n.id ? 'page' : undefined}
                >
                  <FileText size={15} />
                  <span>{n.title}</span>
                </Button>
              ))}
              {normalizedQuery && !visibleNotes.length && (
                <p className={styles.empty}>没有匹配的文档</p>
              )}
            </nav>
          </>
        )}
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
              <Button onClick={() => select('')}>我的文档</Button>
              <ChevronRight size={13} />
              <strong>{note?.title || '我的文档'}</strong>
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
                  {folders.length > 0 && (
                    <FolderSelect
                      label="移动文档到"
                      value={note.folderId ?? ''}
                      disabled={busy}
                      options={folderOptions}
                      onChange={(destination) =>
                        void mutateFolder(() =>
                          client.move(note.id, destination),
                        )
                      }
                    />
                  )}
                  <span className={styles.status}>
                    <span
                      className={`${styles.dot} ${status !== 'connected' ? styles.offline : ''}`}
                    />
                    {statusLabels[status]}
                  </span>
                  <Button
                    aria-label="导出 Markdown"
                    title="导出 Markdown"
                    onClick={download}
                  >
                    <Download size={15} />
                  </Button>
                  <Button
                    aria-label="删除文档"
                    title="删除文档"
                    disabled={busy}
                    onClick={() =>
                      setAction({
                        title: `删除「${note.title}」？`,
                        description: '此操作无法撤销。',
                        run: () => void remove(),
                      })
                    }
                  >
                    <Trash2 size={15} />
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
            <div className={styles['list-tools']}>
              {searchField}
              <Button
                className={styles.primary}
                disabled={busy}
                onClick={() => void create()}
              >
                <Plus size={16} /> 新建文档
              </Button>
            </div>
          </header>
        )}
        {error && (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            <Button onClick={() => void refresh()}>重试</Button>
          </div>
        )}
        {!selected ? (
          <section
            className={styles['document-list']}
            aria-label="工作空间文档"
          >
            <table className={styles['documents-table']}>
              <thead>
                <tr>
                  <th scope="col">文档</th>
                  <th scope="col">文件夹</th>
                  <th scope="col">最近更新</th>
                  <th scope="col">操作</th>
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
                      <Button
                        aria-label={`${favoriteIds.has(entry.id) ? '取消收藏' : '收藏'} ${entry.title}`}
                        aria-pressed={favoriteIds.has(entry.id)}
                        onClick={() => toggleFavorite(entry.id)}
                        className={styles['favorite-button']}
                      >
                        <Star size={16} />
                      </Button>
                    </td>
                  </tr>
                ))}
                {!dashboardNotes.length && (
                  <tr>
                    <td className={styles['list-empty']} colSpan={4}>
                      {loading
                        ? '正在加载文档…'
                        : normalizedQuery
                          ? '没有匹配的文档'
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
              <div className={styles.meta}>
                <Clock size={12} /> 更新于{' '}
                {new Date(note.updatedAt).toLocaleString('zh-CN', {
                  month: 'long',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                <span>·</span>
                <span>Markdown 文档</span>
              </div>
            </div>
            <div className={styles['editor-toolbar']}>
              <div className={styles.formatting}>
                {[
                  [Heading, '标题', '# ', ''],
                  [Bold, '粗体', '**', '**'],
                  [Italic, '斜体', '*', '*'],
                  [Link, '链接', '[', '](https://example.com)'],
                  [Code, '代码', '`', '`'],
                  [List, '列表', '- ', ''],
                ].map(([Icon, label, before, after]) => {
                  const I = Icon as typeof Bold;
                  return (
                    <Button
                      key={String(label)}
                      aria-label={String(label)}
                      title={String(label)}
                      disabled={!editable}
                      onClick={() => insert(String(before), String(after))}
                    >
                      <I size={16} />
                    </Button>
                  );
                })}
              </div>
            </div>
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
              {displayedSession && (
                <MarkdownEditor
                  key={selected}
                  ref={input}
                  session={displayedSession}
                  readOnly={!editable}
                  onDocumentSizeChange={setDocumentSize}
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
