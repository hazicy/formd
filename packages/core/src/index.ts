export * from './presence.js';
export interface Note {
  id: string;
  title: string;
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
export const welcomeMarkdown = `# 欢迎来到 Typo 👋

把想法写下来，和团队一起让它成形。

## 开始创作

- 在左侧创建一篇文档
- 用 **Markdown** 专注写作
- 分享文档链接，实时协作
- 在 Web、手机和 VS Code 之间切换

> 好的想法，值得一个安静的地方。

\`\`\`typescript
const idea = 'Write something wonderful';
console.log(idea);
\`\`\`

## 下一步

试着编辑这篇文档，再在另一个窗口打开它。
`;
