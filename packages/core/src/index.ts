export * from './presence';
export interface Note {
  id: string;
  title: string;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
}
export const MAX_TITLE_LENGTH = 160;
export const MAX_CONTENT_LENGTH = 1_000_000;
export function normalizeTitle(value: string): string {
  return value.trim().slice(0, MAX_TITLE_LENGTH) || '未命名文档';
}
export function isNoteId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}
export function markdownFilename(title: string): string {
  return normalizeTitle(title).replace(/[\\/:*?"<>|\x00-\x1f]/g, '-') + '.md';
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export function isFolderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
  );
}
