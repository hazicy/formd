import { Button } from '@base-ui/react/button';
import type { Note } from '@formd/client';
import {
  Clock,
  FileText,
  FolderPlus,
  PanelLeft,
  Plus,
  Star,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { EntryMenu, type EntryCommand } from './LibraryControls';
import type { DocumentView, useDocumentLibrary } from './useDocumentLibrary';
import styles from '../../styles/workspace.module.css';

const documentViews = {
  all: { label: '全部文档', empty: '暂无文档', icon: FileText },
  recent: { label: '最近访问', empty: '暂无访问记录', icon: Clock },
  favorites: { label: '收藏', empty: '暂无收藏文档', icon: Star },
} satisfies Record<
  DocumentView,
  { label: string; empty: string; icon: typeof FileText }
>;

export function LibraryHeader({
  title,
  onOpenSidebar,
  actions,
  children,
}: {
  title: string;
  onOpenSidebar: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className={styles['list-header']}>
      <div className={styles['list-title']}>
        <Button
          className={styles['mobile-menu']}
          aria-label="打开侧栏"
          onClick={onOpenSidebar}
        >
          <PanelLeft size={16} />
        </Button>
        <h1>{title}</h1>
        {actions}
      </div>
      {children}
    </header>
  );
}

function DocumentFilters({
  view,
  onChange,
}: {
  view: DocumentView;
  onChange: (view: DocumentView) => void;
}) {
  return (
    <div className={styles['view-filters']} role="group" aria-label="文档筛选">
      {(Object.keys(documentViews) as DocumentView[]).map((key) => {
        const { icon: Icon, label } = documentViews[key];
        return (
          <Button
            key={key}
            aria-pressed={view === key}
            onClick={() => onChange(key)}
          >
            <Icon size={14} />
            {label}
          </Button>
        );
      })}
    </div>
  );
}

function LibraryToolbar({
  title,
  onOpenSidebar,
  view,
  onViewChange,
  busy,
  onCreateFolder,
  onCreateNote,
}: {
  title: string;
  onOpenSidebar: () => void;
  view: DocumentView;
  onViewChange: (view: DocumentView) => void;
  busy: boolean;
  onCreateFolder: () => void;
  onCreateNote: () => void;
}) {
  return (
    <LibraryHeader
      title={title}
      onOpenSidebar={onOpenSidebar}
      actions={
        <div className={styles['list-create']}>
          <Button
            aria-label="新建文件夹"
            title="新建文件夹"
            disabled={busy}
            onClick={onCreateFolder}
          >
            <FolderPlus size={16} />
          </Button>
          <Button
            className={styles.primary}
            disabled={busy}
            onClick={onCreateNote}
          >
            <Plus size={16} /> 新建文档
          </Button>
        </div>
      }
    >
      <DocumentFilters view={view} onChange={onViewChange} />
    </LibraryHeader>
  );
}

function DocumentTable({
  notes,
  view,
  folderId,
  loading,
  busy,
  favorites,
  recent,
  folderPath,
  onOpen,
  onFavorite,
  onManage,
  onDownload,
}: {
  notes: Note[];
  view: DocumentView;
  folderId: string | null;
  loading: boolean;
  busy: boolean;
  favorites: string[];
  recent: string[];
  folderPath: (id: string) => string;
  onOpen: (id: string) => void;
  onFavorite: (id: string) => void;
  onManage: (note: Note, command: EntryCommand) => void;
  onDownload: (note: Note) => void;
}) {
  const favoriteIds = new Set(favorites);
  const recentOrder = new Map(recent.map((id, index) => [id, index]));
  const visibleNotes = notes.filter(
    (entry) =>
      (!folderId || entry.folderId === folderId) &&
      (view !== 'favorites' || favoriteIds.has(entry.id)) &&
      (view !== 'recent' || recentOrder.has(entry.id)),
  );
  if (view === 'recent')
    visibleNotes.sort(
      (a, b) => recentOrder.get(a.id)! - recentOrder.get(b.id)!,
    );

  return (
    <section className={styles['document-list']} aria-label="工作空间文档">
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
          {visibleNotes.map((entry) => (
            <tr key={entry.id}>
              <td>
                <Button
                  className={styles['document-link']}
                  onClick={() => onOpen(entry.id)}
                >
                  <FileText size={15} />
                  <span>{entry.title}</span>
                </Button>
              </td>
              <td>{entry.folderId ? folderPath(entry.folderId) : '根目录'}</td>
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
                    toggle: () => onFavorite(entry.id),
                  }}
                  onManage={(command) => onManage(entry, command)}
                  onDownload={() => void onDownload(entry)}
                />
              </td>
            </tr>
          ))}
          {!visibleNotes.length && (
            <tr>
              <td className={styles['list-empty']} colSpan={5}>
                {loading ? '正在加载文档…' : documentViews[view].empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

export function DocumentLibrary({
  library,
  onOpenSidebar,
  onOpenNote,
  onDownload,
  children,
}: {
  library: ReturnType<typeof useDocumentLibrary>;
  onOpenSidebar: () => void;
  onOpenNote: (id: string) => void;
  onDownload: (note: Note) => void;
  children: ReactNode;
}) {
  return (
    <>
      <LibraryToolbar
        title={library.currentFolder?.name ?? '文档库'}
        onOpenSidebar={onOpenSidebar}
        view={library.view}
        onViewChange={library.setView}
        busy={library.busy}
        onCreateFolder={library.createFolder}
        onCreateNote={library.createNote}
      />
      {children}
      <DocumentTable
        notes={library.notes}
        view={library.view}
        folderId={library.currentFolderId}
        loading={library.loading}
        busy={library.busy}
        favorites={library.favorites}
        recent={library.recent}
        folderPath={library.folderPath}
        onOpen={onOpenNote}
        onFavorite={library.toggleFavorite}
        onManage={library.manageEntry}
        onDownload={onDownload}
      />
    </>
  );
}
