import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { Input } from '@base-ui/react/input';
import { Menu } from '@base-ui/react/menu';
import { Select } from '@base-ui/react/select';
import { hotkeysCoreFeature, syncDataLoaderFeature } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import type { Folder, Note } from '@formd/client';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderClosed,
  Ellipsis,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import styles from '../../styles/workspace.module.css';

export type LibraryAction = {
  title: string;
  description?: string;
  initialName?: string;
  destination?: { initialValue: string; options: FolderOption[] };
  run: (name: string) => void;
};

export function ActionDialog({
  action,
  close,
}: {
  action: LibraryAction;
  close: () => void;
}) {
  const [name, setName] = useState(action.initialName ?? '');
  const [destination, setDestination] = useState(
    action.destination?.initialValue ?? '',
  );
  const naming = action.initialName !== undefined;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Popup className={styles['action-dialog']}>
          <Dialog.Title>{action.title}</Dialog.Title>
          {action.description && (
            <Dialog.Description>{action.description}</Dialog.Description>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (naming && !name.trim()) return;
              close();
              action.run(action.destination ? destination : name.trim());
            }}
          >
            {naming && (
              <Input
                aria-label="文件夹名称"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
            {action.destination && (
              <FolderSelect
                label="移动文件夹到"
                value={destination}
                options={action.destination.options}
                onChange={(id) => setDestination(id ?? '')}
              />
            )}
            <div className={styles['dialog-actions']}>
              <Dialog.Close render={<Button />}>取消</Dialog.Close>
              <Button
                type="submit"
                className={styles.primary}
                disabled={naming && !name.trim()}
              >
                {action.destination ? '移动' : naming ? '保存' : '删除'}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export type FolderOption = { value: string; label: string };

export function FolderSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: FolderOption[];
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <Select.Root
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next || null)}
    >
      <Select.Trigger aria-label={label} className={styles['folder-select']}>
        <Select.Value />
        <Select.Icon>
          <ChevronDown size={13} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          className={styles['select-positioner']}
          sideOffset={5}
          alignItemWithTrigger={false}
        >
          <Select.Popup className={styles['select-popup']}>
            <Select.List>
              {options.map((item) => (
                <Select.Item
                  key={item.value}
                  value={item.value}
                  className={styles['select-item']}
                >
                  <Select.ItemText>{item.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

const ROOT = 'workspace-root';
const ROOT_FOLDER: Folder = {
  id: ROOT,
  name: '文档库',
  parentId: null,
  createdAt: '',
  updatedAt: '',
};

export type EntryCommand = 'rename' | 'move' | 'delete';

export function EntryMenu({
  name,
  busy,
  onManage,
  favorite,
  onDownload,
}: {
  name: string;
  busy: boolean;
  onManage: (command: EntryCommand) => void;
  favorite?: { active: boolean; toggle: () => void };
  onDownload?: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className={styles['tree-more']}
        aria-label={`「${name}」的更多操作`}
        disabled={busy}
        render={<Button />}
      >
        <Ellipsis size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className={styles['select-positioner']}
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className={styles['select-popup']}>
            {favorite && (
              <Menu.Item
                className={styles['select-item']}
                onClick={favorite.toggle}
              >
                {favorite.active ? '取消收藏' : '收藏'}
              </Menu.Item>
            )}
            <Menu.Item
              className={styles['select-item']}
              onClick={() => onManage('rename')}
            >
              重命名
            </Menu.Item>
            <Menu.Item
              className={styles['select-item']}
              onClick={() => onManage('move')}
            >
              移动到…
            </Menu.Item>
            {onDownload && (
              <Menu.Item className={styles['select-item']} onClick={onDownload}>
                下载 Markdown
              </Menu.Item>
            )}
            <Menu.Item
              className={styles['select-item']}
              onClick={() => onManage('delete')}
            >
              删除
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function FolderTree({
  folders,
  notes,
  selected,
  activeNote,
  hidden,
  busy,
  onManage,
  onChoose,
  onOpen,
  onDownload,
}: {
  folders: Folder[];
  notes: Note[];
  activeNote: string;
  hidden: boolean;
  busy: boolean;
  onManage: (entry: Folder | Note, command: EntryCommand) => void;
  onOpen: (id: string) => void;
  onDownload: (note: Note) => void;
  selected: string | null;
  onChoose: (id: string) => void;
}) {
  const data = useMemo(() => {
    const items = new Map<string, Folder | Note>([[ROOT, ROOT_FOLDER]]);
    const children = new Map<string, string[]>();
    for (const entry of [...folders, ...notes]) {
      items.set(entry.id, entry);
      const parent =
        ('parentId' in entry ? entry.parentId : entry.folderId) ?? ROOT;
      const siblings = children.get(parent) ?? [];
      siblings.push(entry.id);
      children.set(parent, siblings);
    }
    return { items, children };
  }, [folders, notes]);

  const tree = useTree<Folder | Note>({
    rootItemId: ROOT,
    getItemName: (item) => {
      const entry = item.getItemData();
      return 'name' in entry ? entry.name : entry.title;
    },
    isItemFolder: (item) => data.children.has(item.getId()),
    onPrimaryAction: (item) => {
      if ('parentId' in item.getItemData()) onChoose(item.getId());
      else onOpen(item.getId());
    },
    dataLoader: {
      getItem: (id) => data.items.get(id) ?? ROOT_FOLDER,
      getChildren: (id) => data.children.get(id) ?? [],
    },
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  });
  useEffect(() => {
    tree.rebuildTree();
  }, [tree, data]);

  return (
    <div
      {...tree.getContainerProps('文档库文件树')}
      className={styles['folder-tree']}
      hidden={hidden}
    >
      {tree.getItems().map((item) => {
        const props = item.getProps();
        const entry = item.getItemData();
        const row = (
          <Button
            {...props}
            key={item.getId()}
            aria-current={
              activeNote === item.getId()
                ? 'page'
                : !activeNote && selected === item.getId()
                  ? 'location'
                  : undefined
            }
            className={styles['tree-item']}
            style={{
              paddingInlineStart: `calc(var(--space-2) + ${item.getItemMeta().level} * var(--space-4))`,
            }}
          >
            {item.isFolder() ? (
              item.isExpanded() ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )
            ) : (
              <span className={styles['tree-indent']} />
            )}
            {'parentId' in entry ? (
              <FolderClosed size={15} />
            ) : (
              <FileText size={15} />
            )}
            <span>{item.getItemName()}</span>
          </Button>
        );
        return (
          <div
            key={item.getId()}
            className={styles['tree-entry-row']}
            role="presentation"
          >
            {row}
            <EntryMenu
              name={item.getItemName()}
              busy={busy}
              onManage={(command) => onManage(entry, command)}
              onDownload={
                'parentId' in entry ? undefined : () => onDownload(entry)
              }
            />
          </div>
        );
      })}
    </div>
  );
}
