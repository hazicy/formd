import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { Input } from '@base-ui/react/input';
import { Select } from '@base-ui/react/select';
import { hotkeysCoreFeature, syncDataLoaderFeature } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import type { Folder, Note } from '@formd/client';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderClosed,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import styles from './App.module.css';

export type WorkspaceAction = {
  title: string;
  description?: string;
  initialName?: string;
  run: (name: string) => void;
};

export function ActionDialog({
  action,
  close,
}: {
  action: WorkspaceAction;
  close: () => void;
}) {
  const [name, setName] = useState(action.initialName ?? '');
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
              action.run(name.trim());
            }}
          >
            {naming && (
              <Input
                aria-label="文件夹名称"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
            <div className={styles['dialog-actions']}>
              <Dialog.Close render={<Button />}>取消</Dialog.Close>
              <Button
                type="submit"
                className={styles.primary}
                disabled={naming && !name.trim()}
              >
                {naming ? '保存' : '删除'}
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

export function FolderTree({
  folders,
  notes,
  selected,
  activeNote,
  onChoose,
  onOpen,
}: {
  folders: Folder[];
  notes: Note[];
  activeNote: string;
  onOpen: (id: string) => void;
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
    >
      {tree.getItems().map((item) => {
        const props = item.getProps();
        return (
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
            {'parentId' in item.getItemData() ? (
              <FolderClosed size={15} />
            ) : (
              <FileText size={15} />
            )}
            <span>{item.getItemName()}</span>
          </Button>
        );
      })}
    </div>
  );
}
