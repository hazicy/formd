import { test, expect } from '@playwright/test';
test('edit, preview, collaborate, export and delete a document', async ({
  page,
  context,
  request,
}) => {
  const response = await request.post('http://127.0.0.1:3002/api/notes', {
    data: { title: 'Browser collaboration', content: '# Initial' },
  });
  const note = await response.json();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#${note.id}`);
  const editor = page.getByRole('textbox', { name: 'Markdown 编辑器' });
  await expect(editor).toBeEnabled();
  await editor.fill('# Browser test\n\n**Shared** ideas.');
  await expect(page.locator('article h1')).toHaveText('Browser test');
  const second = await context.newPage();
  await second.goto(`/#${note.id}`);
  const otherEditor = second.getByRole('textbox', { name: 'Markdown 编辑器' });
  await expect(otherEditor).toBeEnabled();
  await expect(otherEditor).toHaveValue('# Browser test\n\n**Shared** ideas.');
  await otherEditor.fill(
    '# Browser test\n\n**Shared** ideas.\n\nFrom another window.',
  );
  await expect(editor).toHaveValue(
    '# Browser test\n\n**Shared** ideas.\n\nFrom another window.',
  );
  const title = page.getByRole('textbox', { name: '文档标题' });
  await title.fill('Shared browser note');
  await title.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Shared browser note' }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown' }).click();
  expect((await downloadEvent).suggestedFilename()).toBe(
    'Shared browser note.md',
  );
  await page.screenshot({
    path: 'test-results/workspace-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('article h1')).toBeVisible();
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await expect(
    page.getByRole('navigation', { name: '文档列表' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '关闭侧栏' }).click();
  await page.screenshot({
    path: 'test-results/workspace-mobile.png',
    fullPage: true,
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除文档', exact: true }).click();
  await expect(second.getByRole('status')).toContainText('文档已被删除');
});
