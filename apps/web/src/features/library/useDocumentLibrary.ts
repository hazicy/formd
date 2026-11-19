import type { Folder, FormdClient, Note } from '@formd/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntryCommand, LibraryAction } from './LibraryControls';
export type DocumentView = 'all' | 'recent' | 'favorites';

function readStoredIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

export function useDocumentLibrary({
  client,
  noteId,
  openNote,
  reportError,
  notify,
}: {
  client: FormdClient;
  noteId: string;
  openNote: (id: string) => void;
  reportError: (message: string) => void;
  notify: (message: string) => void;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const refreshVersion = useRef(0);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [view, setView] = useState<DocumentView>('all');
  const [favorites, setFavorites] = useState(() =>
    readStoredIds('formd.favorites'),
  );
  const [recent, setRecent] = useState(() => readStoredIds('formd.recent'));
  const [action, setAction] = useState<LibraryAction | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem('formd.favorites', JSON.stringify(favorites));
      localStorage.setItem('formd.recent', JSON.stringify(recent));
    } catch {
      /* storage may be disabled */
    }
  }, [favorites, recent]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const currentFolder = folders.find((folder) => folder.id === folderId);
  const currentFolderId = currentFolder?.id ?? null;
  const selectedNote = notes.find((note) => note.id === noteId);
  const openedNoteId = selectedNote?.id;
  useEffect(() => {
    if (openedNoteId)
      setRecent((previous) =>
        [openedNoteId, ...previous.filter((id) => id !== openedNoteId)].slice(
          0,
          100,
        ),
      );
  }, [openedNoteId]);
  function toggleFavorite(id: string) {
    setFavorites((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id],
    );
  }
  const byFolderId = new Map(folders.map((folder) => [folder.id, folder]));
  function folderAncestors(id: string) {
    const ancestors: Folder[] = [];
    const visited = new Set<string>();
    let folder = byFolderId.get(id);
    while (folder && !visited.has(folder.id)) {
      ancestors.push(folder);
      visited.add(folder.id);
      folder = byFolderId.get(folder.parentId ?? '');
    }
    return ancestors;
  }
  function folderPath(id: string) {
    return folderAncestors(id)
      .reverse()
      .map((folder) => folder.name)
      .join(' / ');
  }
  const folderOptions = [
    { value: '', label: '根目录' },
    ...folders.map((folder) => ({
      value: folder.id,
      label: folderPath(folder.id),
    })),
  ];
  async function runMutation(mutation: () => Promise<void>) {
    setBusy(true);
    try {
      await mutation();
    } catch (error) {
      reportError(String(error));
    } finally {
      setBusy(false);
    }
  }
  function mutateLibrary(mutation: () => Promise<unknown>) {
    return runMutation(async () => {
      await mutation();
      await refresh();
    });
  }
  function createFolder() {
    setAction({
      title: '新建文件夹',
      initialName: '',
      run: (name) =>
        void mutateLibrary(async () => {
          const folder = await client.createFolder(name, currentFolderId);
          setFolderId(folder.id);
        }),
    });
  }
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const [data, directories] = await Promise.all([
        client.list(),
        client.listFolders(),
      ]);
      if (version === refreshVersion.current) {
        setFolders(directories);
        setNotes(data);
        reportError('');
      }
      return data;
    } catch (e) {
      if (version === refreshVersion.current) reportError(String(e));
      return null;
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, [client, reportError]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  function createNote() {
    void runMutation(async () => {
      const created = await client.create(
        undefined,
        undefined,
        currentFolderId,
      );
      setNotes((entries) => [created, ...entries]);
      openNote(created.id);
    });
  }
  function deleteNote(target: Note) {
    void runMutation(async () => {
      await client.delete(target.id);
      setNotes((entries) => entries.filter((entry) => entry.id !== target.id));
      if (location.hash.slice(1) === target.id)
        openNote(notes.find((entry) => entry.id !== target.id)?.id ?? '');
    });
  }
  function manageEntry(entry: Folder | Note, command: EntryCommand) {
    if ('parentId' in entry) {
      manageFolder(entry, command);
      return;
    }

    if (command === 'rename') {
      setAction({
        title: '重命名文档',
        initialName: entry.title,
        run: (name) => void mutateLibrary(() => client.rename(entry.id, name)),
      });
    } else if (command === 'move') {
      setAction({
        title: '移动文档',
        destination: {
          initialValue: entry.folderId ?? '',
          options: folderOptions,
        },
        run: (value) =>
          void mutateLibrary(() => client.move(entry.id, value || null)),
      });
    } else {
      setAction({
        title: `删除「${entry.title}」？`,
        description: '此操作无法撤销。',
        run: () => deleteNote(entry),
      });
    }
  }

  function manageFolder(folder: Folder, command: EntryCommand) {
    if (command === 'rename') {
      setAction({
        title: '重命名文件夹',
        initialName: folder.name,
        run: (name) =>
          void mutateLibrary(() => client.updateFolder(folder.id, { name })),
      });
    } else if (command === 'move') {
      setAction({
        title: '移动文件夹',
        destination: {
          initialValue: folder.parentId ?? '',
          options: folderOptions.filter(
            (option) =>
              !folderAncestors(option.value).some(
                (ancestor) => ancestor.id === folder.id,
              ),
          ),
        },
        run: (value) =>
          void mutateLibrary(() =>
            client.updateFolder(folder.id, { parentId: value || null }),
          ),
      });
    } else {
      setAction({
        title: `删除「${folderPath(folder.id) || folder.name}」？`,
        description:
          '只删除这个文件夹。里面的文档和子文件夹会移到上一级，同名子文件夹会自动加编号。',
        run: () =>
          void mutateLibrary(async () => {
            const { parentId = folder.parentId } = await client.deleteFolder(
              folder.id,
            );
            setFolderId((id) => (id === folder.id ? parentId : id));
            notify(`已删除「${folder.name}」，内容保留在上一级`);
          }),
      });
    }
  }

  return {
    notes,
    folders,
    selectedNote,
    currentFolder,
    currentFolderId,
    chooseFolder: setFolderId,
    view,
    setView,
    loading,
    busy,
    favorites,
    recent,
    folderPath,
    toggleFavorite,
    manageEntry,
    createFolder,
    createNote,
    refresh,
    action,
    dismissAction: () => setAction(null),
    updateNote: (updated: Note) =>
      setNotes((entries) =>
        entries.map((entry) => (entry.id === updated.id ? updated : entry)),
      ),
  };
}
