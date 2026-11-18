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

test('online members, names, colored selections and wrapped/scrolled remote cursors', async ({
  page,
  context,
  request,
}) => {
  const content = Array.from(
    { length: 65 },
    (_, i) =>
      `${i + 1}. A long collaborative line with several words and 中文文字, wrapping across the editor at narrow widths. Keep writing together.`,
  ).join('\n');
  const response = await request.post('http://127.0.0.1:3002/api/notes', {
    data: { title: 'Presence and cursors', content },
  });
  const note = await response.json();
  await page.addInitScript(() =>
    localStorage.setItem(
      'typo.profile',
      JSON.stringify({ name: 'Alice', color: '#537fba', client: 'web' }),
    ),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#${note.id}`);
  const first = page.getByRole('textbox', { name: 'Markdown 编辑器' });
  await expect(first).toBeEnabled();
  const second = await context.newPage();
  await second.addInitScript(() =>
    localStorage.setItem(
      'typo.profile',
      JSON.stringify({ name: 'Bob', color: '#b45e46', client: 'web' }),
    ),
  );
  await second.setViewportSize({ width: 1440, height: 900 });
  await second.goto(`/#${note.id}`);
  const other = second.getByRole('textbox', { name: 'Markdown 编辑器' });
  await expect(other).toBeEnabled();
  await expect(
    page.getByRole('button', { name: '在线成员 2 人' }),
  ).toBeVisible();
  await first.focus();
  await first.evaluate((element) =>
    (element as HTMLTextAreaElement).setSelectionRange(85, 85),
  );
  await first.press('Shift+ArrowRight');
  await first.press('Shift+ArrowRight');
  const cursor = second.getByRole('img', { name: /Alice 的光标/ });
  await expect(cursor).toBeVisible();
  await expect(cursor.locator('.remote-selection')).toHaveText(
    content.slice(85, 87),
  );
  const inputBounds = await other.boundingBox();
  const labelBounds = await cursor.locator('.remote-label').boundingBox();
  expect(labelBounds!.x).toBeGreaterThanOrEqual(inputBounds!.x);
  expect(labelBounds!.x).toBeLessThan(inputBounds!.x + inputBounds!.width);
  expect(labelBounds!.y).toBeGreaterThan(inputBounds!.y);
  expect(labelBounds!.y).toBeLessThan(inputBounds!.y + inputBounds!.height);
  await second.getByRole('button', { name: '在线成员 2 人' }).click();
  await expect(
    second
      .getByRole('region', { name: '在线成员列表' })
      .getByText('Alice', { exact: true }),
  ).toBeVisible();
  await second.getByRole('textbox', { name: '我的显示名称' }).fill('Bobby');
  await second.getByRole('textbox', { name: '我的显示名称' }).press('Enter');
  await second.getByRole('button', { name: '关闭在线成员' }).click();
  await other.focus();
  await other.press('ArrowRight');
  await expect(page.getByRole('img', { name: /Bobby 的光标/ })).toBeVisible();
  await page.getByRole('button', { name: '在线成员 2 人' }).click();
  await page.screenshot({
    path: 'test-results/presence-members.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '关闭在线成员' }).click();
  const line20 = content.split('\n').slice(0, 20).join('\n').length + 1;
  await first.focus();
  await first.evaluate(
    (element, offset) =>
      (element as HTMLTextAreaElement).setSelectionRange(offset, offset),
    line20,
  );
  await first.press('ArrowRight');
  await other.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.scrollTop = 1000;
    input.dispatchEvent(new Event('scroll'));
  });
  await expect(cursor).toHaveAttribute('aria-label', /第 21 行/);
  await second.screenshot({
    path: 'test-results/presence-scrolled.png',
    fullPage: true,
  });
  await second.close();
  await expect(
    page.getByRole('button', { name: '在线成员 1 人' }),
  ).toBeVisible();
  await request.delete(`http://127.0.0.1:3002/api/notes/${note.id}`);
});
