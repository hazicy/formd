import { PresenceTextarea } from './PresenceTextarea';
import { PresencePanel } from './PresencePanel';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Plus,
  Search,
  FileText,
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
} from 'lucide-react';
import {
  TypoClient,
  markdownFilename,
  type Note,
  type Folder,
  type NoteSession,
  type PresenceUser,
  createGuestUser,
  validPresenceUser,
} from '@typo/client';
function loadProfile(): PresenceUser {
  try {
    const saved = JSON.parse(localStorage.getItem('typo.profile') || 'null');
    if (validPresenceUser(saved)) return { ...saved, client: 'web' };
  } catch {
    /* anonymous defaults */
  }
  const guest = createGuestUser('web');
  try {
    localStorage.setItem('typo.profile', JSON.stringify(guest));
  } catch {
    /* private browsing */
  }
  return guest;
}
const initialProfile = loadProfile();
const client = new TypoClient(
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
export default function App() {
  const [user, setUser] = useState<PresenceUser>(initialProfile);
  function updateUser(next: PresenceUser) {
    setUser(next);
    session.current?.setUser(next);
    client.user = next;
    try {
      localStorage.setItem('typo.profile', JSON.stringify(next));
    } catch {
      /* private browsing */
    }
  }
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState(location.hash.slice(1));
  const [query, setQuery] = useState('');
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<keyof typeof statusLabels>('connecting');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'edit' | 'split' | 'preview'>('split');
  const [sidebar, setSidebar] = useState(false);
  const session = useRef<NoteSession | null>(null);
  const [activeSession, setActiveSession] = useState<NoteSession | null>(null);
  const displayedSession =
    activeSession?.id === selected ? activeSession : null;
  const input = useRef<HTMLTextAreaElement>(null);
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
  const folderOptions = folders.map((folder) => (
    <option key={folder.id} value={folder.id}>
      {folderPath(folder.id)}
    </option>
  ));
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
    location.hash = id;
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
    void refresh().then((data) => {
      if (data?.length && !location.hash) select(data[0].id);
    });
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
    setContent('');
    titleDirty.current = false;
    const active = client.connect(selected);
    session.current = active;
    setActiveSession(active);
    const update = () => {
      setContent(active.text.toString());
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
    if (!note || !confirm(`确定删除「${note.title}」？此操作无法撤销。`))
      return;
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
  function change(value: string) {
    session.current?.replace(value);
  }
  function insert(before: string, after = '') {
    const el = input.current;
    if (!el) {
      setMode('edit');
      return;
    }
    const start = el.selectionStart,
      end = el.selectionEnd;
    change(
      content.slice(0, start) +
        before +
        (content.slice(start, end) || '文字') +
        after +
        content.slice(end),
    );
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(
        start + before.length,
        start + before.length + (end - start || 2),
      );
    });
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([content], { type: 'text/markdown;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = markdownFilename(title);
    a.click();
    URL.revokeObjectURL(url);
  }
  const editable = !!note && (status === 'connected' || status === 'offline');
  return (
    <div className="app">
      <aside className={`sidebar ${sidebar ? '' : 'hidden'}`}>
        <div className="brand">
          <span className="brand-icon">
            <Feather size={23} />
          </span>{' '}
          Formd<span style={{ color: '#91a182' }}>.</span>
          <button
            className="mobile-menu"
            aria-label="关闭侧栏"
            onClick={() => setSidebar(false)}
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
        <div className="workspace">YOUR IDEAS, CONNECTED.</div>
        <button
          className="primary new"
          onClick={() => void create()}
          disabled={busy}
        >
          <Plus size={17} /> 新建文档
        </button>
        <div className="folder-controls">
          <select
            aria-label="浏览文件夹"
            value={currentFolderId ?? ''}
            onChange={(event) => setFolderId(event.target.value || null)}
          >
            <option value="">根目录</option>
            {folderOptions}
          </select>
          <button
            aria-label="新建文件夹"
            title="新建文件夹"
            disabled={busy}
            onClick={() => {
              const name = window.prompt('文件夹名称')?.trim();
              if (name)
                void mutateFolder(async () => {
                  const folder = await client.createFolder(
                    name,
                    currentFolderId,
                  );
                  setFolderId(folder.id);
                });
            }}
          >
            <FolderPlus size={16} />
          </button>
        </div>
        {currentFolder && (
          <div className="folder-controls">
            <button
              disabled={busy}
              onClick={() => {
                const name = window
                  .prompt('文件夹名称', currentFolder.name)
                  ?.trim();
                if (name && name !== currentFolder.name)
                  void mutateFolder(() =>
                    client.updateFolder(currentFolder.id, { name }),
                  );
              }}
            >
              重命名
            </button>
            <select
              aria-label="移动文件夹到"
              value={currentFolder.parentId ?? ''}
              disabled={busy}
              onChange={(event) => {
                const parentId = event.target.value || null;
                void mutateFolder(() =>
                  client.updateFolder(currentFolder.id, { parentId }),
                );
              }}
            >
              <option value="">根目录</option>
              {folderOptions.filter(
                (option) => option.key !== currentFolder.id,
              )}
            </select>
            <button
              aria-label="删除文件夹"
              title="删除空文件夹"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`删除空文件夹「${currentFolder.name}」？`))
                  void mutateFolder(async () => {
                    await client.deleteFolder(currentFolder.id);
                    setFolderId(currentFolder.parentId);
                  });
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        )}
        <div className="search">
          <Search size={15} />
          <input
            aria-label="搜索文档"
            placeholder="搜索文档…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="section-label">
          <span>我的文档</span>
          <span>{visibleNotes.length.toString().padStart(2, '0')}</span>
        </div>
        <nav className="notes" aria-label="文档列表">
          {visibleNotes.map((n) => (
            <button
              key={n.id}
              className={`note ${selected === n.id ? 'active' : ''}`}
              onClick={() => select(n.id)}
              aria-current={selected === n.id ? 'page' : undefined}
            >
              <FileText size={15} />
              <span>{n.title}</span>
            </button>
          ))}
          {normalizedQuery && !visibleNotes.length && (
            <p className="empty">没有匹配的文档</p>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="avatar">T</div>
          <div>
            我的工作空间<small>为每一个灵感留一页</small>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu"
              aria-label="打开侧栏"
              onClick={() => setSidebar(true)}
            >
              <Menu size={18} />
            </button>
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong>{note?.title || '我的文档'}</strong>
          </div>
          <div className="actions">
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
                  <select
                    className="document-folder"
                    aria-label="移动文档到"
                    value={note.folderId ?? ''}
                    disabled={busy}
                    onChange={(event) => {
                      const destination = event.target.value || null;
                      void mutateFolder(() =>
                        client.move(note.id, destination),
                      );
                    }}
                  >
                    <option value="">根目录</option>
                    {folderOptions}
                  </select>
                )}
                <span className="status">
                  <span
                    className={`dot ${status !== 'connected' ? 'offline' : ''}`}
                  />
                  {statusLabels[status]}
                </span>
                <button
                  aria-label="导出 Markdown"
                  title="导出 Markdown"
                  onClick={download}
                >
                  <Download size={15} />
                </button>
                <button
                  aria-label="删除文档"
                  title="删除文档"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  <Trash2 size={15} />
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(location.href)
                      .then(() => setToast('协作链接已复制'))
                      .catch(() => setError('复制失败，请直接复制浏览器地址'));
                  }}
                >
                  <Share2 size={14} />
                  <span className="label">分享文档</span>
                </button>
              </>
            )}
          </div>
        </header>
        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            <button onClick={() => void refresh()}>重试</button>
          </div>
        )}
        {note ? (
          <>
            <div className="document-heading">
              <div className="eyebrow">A LITTLE SPACE FOR BIG IDEAS</div>
              <input
                className="title"
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
              <div className="meta">
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
            <div className="editor-toolbar">
              <div className="formatting">
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
                    <button
                      key={String(label)}
                      aria-label={String(label)}
                      title={String(label)}
                      disabled={!editable || mode === 'preview'}
                      onClick={() => insert(String(before), String(after))}
                    >
                      <I size={16} />
                    </button>
                  );
                })}
              </div>
              <div className="modes">
                {(['edit', 'split', 'preview'] as const).map((m) => (
                  <button
                    key={m}
                    className={mode === m ? 'active' : ''}
                    onClick={() => setMode(m)}
                  >
                    {{ edit: '编辑', split: '分屏', preview: '预览' }[m]}
                  </button>
                ))}
              </div>
            </div>
            {(status === 'deleted' ||
              status === 'error' ||
              status === 'offline') && (
              <div className="error" role="status">
                {statusLabels[status]}
                {status === 'offline'
                  ? '；当前修改仅保留在内存，请保持页面打开或导出备份。'
                  : '，可导出当前内容备份。'}
              </div>
            )}
            <div className={`editor-area ${mode}`}>
              {mode !== 'preview' && displayedSession && (
                <PresenceTextarea
                  key={selected}
                  ref={input}
                  session={displayedSession}
                  value={content}
                  disabled={!editable}
                  onChange={change}
                  onBold={() => insert('**', '**')}
                />
              )}
              {mode !== 'edit' && (
                <article className="preview">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {content}
                  </ReactMarkdown>
                </article>
              )}
            </div>
            <footer className="bottom">
              <span>
                Markdown{' '}
                <span style={{ marginLeft: 16 }}>
                  {content.length.toLocaleString()} 字符 ·{' '}
                  {content.split('\n').length} 行
                </span>
              </span>
              <span>让想法，自然生长。</span>
            </footer>
          </>
        ) : (
          <div className="empty">
            <BookOpen size={42} />
            <h2>{loading ? '正在打开工作空间…' : '给灵感一个开始'}</h2>
            <p>
              {selected
                ? '文档不存在或已被删除，请选择其他文档。'
                : '新建一篇文档，开始记录你的想法。'}
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void create()}
            >
              <Plus size={16} />
              新建文档
            </button>
          </div>
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
