// Main user journey against the real server and a real (throwaway) SQLite database.
// The browser runs in America/Los_Angeles on purpose: the app must use the configured
// zone (Europe/Oslo), not the browser's.
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

const TUE = '2027-03-09';
const WED = '2027-03-10';
const FRI = '2027-03-12';

test.describe.configure({ mode: 'serial' });

test('first run: create account, capture a task, complete it', async ({ page }) => {
  await signIn(page);
  await page.getByLabel('New task', { exact: true }).fill('Buy milk');
  await page.getByLabel('New task', { exact: true }).press('Enter');
  const todays = page.getByRole('region', { name: 'Tasks today without a set time' });
  await expect(todays.getByText('Buy milk')).toBeVisible();

  await todays.getByRole('checkbox', { name: 'Complete "Buy milk"' }).click();
  await expect(page.getByText('Task completed')).toBeVisible();
  await expect(todays.getByRole('checkbox', { name: 'Mark "Buy milk" as not done' })).toBeVisible();
});

test('planned Tuesday, due Friday: shown under Tuesday; moving keeps the deadline', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New task' }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Title').fill('Write report');
  await dlg.getByLabel('Planned day').fill(TUE);
  await dlg.getByLabel('Deadline', { exact: true }).fill(FRI);
  await dlg.getByRole('button', { name: 'Add task' }).click();
  await expect(dlg).toBeHidden();

  await page.goto(`/calendar?view=week&date=${TUE}`);
  await expect(page.getByTestId(`tasks-${TUE}`).getByText('Write report')).toBeVisible();
  await expect(page.getByTestId(`tasks-${FRI}`).getByText('Write report')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Due: Write report/ })).toBeVisible();

  // Click alternative to dragging between days: change the planned day in the editor.
  await page.getByTestId(`tasks-${TUE}`).getByRole('button', { name: /Write report/ }).click();
  await dlg.getByLabel('Planned day').fill(WED);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId(`tasks-${WED}`).getByText('Write report')).toBeVisible();
  await expect(page.getByTestId(`tasks-${TUE}`).getByText('Write report')).toHaveCount(0);

  // Drag between days.
  await page.getByTestId(`tasks-${WED}`).locator('.task-chip', { hasText: 'Write report' }).dragTo(page.getByTestId(`tasks-${TUE}`));
  await expect(page.getByTestId(`tasks-${TUE}`).getByText('Write report')).toBeVisible();

  // Deadline is still Friday.
  await page.getByTestId(`tasks-${TUE}`).getByRole('button', { name: /Write report/ }).click();
  await expect(dlg.getByLabel('Deadline', { exact: true })).toHaveValue(FRI);
  await expect(dlg.getByLabel('Planned day')).toHaveValue(TUE);
});

test('dragging a task into the schedule creates one linked block; it can be moved back', async ({ page }) => {
  await signIn(page);
  await page.goto(`/calendar?view=week&date=${TUE}`);
  const chip = page.getByTestId(`tasks-${TUE}`).locator('.task-chip', { hasText: 'Write report' });
  const grid = page.getByTestId(`grid-${TUE}`);
  await chip.dragTo(grid, { targetPosition: { x: 40, y: 9 * 44 + 2 } }); // 09:00

  const block = grid.locator('.ev-block');
  await expect(block).toHaveCount(1);
  await expect(block).toContainText('Write report');
  await expect(block).toContainText('09:00–10:00'); // Oslo wall time, although the browser is in Los Angeles
  await expect(page.getByTestId(`tasks-${TUE}`).getByText('Write report')).toHaveCount(0);

  // Exactly one task with that title exists, and its deadline is unchanged.
  const tasks = await page.evaluate(() => fetch('/api/tasks').then((r) => r.json()));
  const reports = tasks.filter((t: any) => t.title === 'Write report');
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ plannedDate: TUE, dueDate: FRI });

  // Move the block with drag and drop to Wednesday 13:00.
  await block.dragTo(page.getByTestId(`grid-${WED}`), { sourcePosition: { x: 30, y: 4 }, targetPosition: { x: 40, y: 13 * 44 + 6 } });
  const moved = page.getByTestId(`grid-${WED}`).locator('.ev-block');
  await expect(moved).toContainText('13:00–14:00');
  await expect(grid.locator('.ev-block')).toHaveCount(0);

  // Click alternative: open the block and remove it from the schedule. The task returns to the day's tasks.
  await moved.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove from schedule' }).click();
  await expect(page.getByTestId(`grid-${WED}`).locator('.ev-block')).toHaveCount(0);
  await expect(page.getByTestId(`tasks-${WED}`).getByText('Write report')).toBeVisible();
  const after = await page.evaluate(() => fetch('/api/tasks').then((r) => r.json()));
  expect(after.filter((t: any) => t.title === 'Write report')[0]).toMatchObject({ plannedDate: WED, dueDate: FRI });
});

test('all-day events, timed events and untimed tasks are separate; overlaps are flagged', async ({ page }) => {
  await signIn(page);
  await page.goto(`/calendar?view=day&date=${WED}`);
  const dlg = page.getByRole('dialog');

  await page.getByRole('button', { name: 'New event' }).click();
  await dlg.getByLabel('Title').fill('Conference');
  await dlg.getByLabel('All-day event').check();
  await dlg.getByLabel('From').fill(WED);
  await dlg.getByRole('button', { name: 'Add event' }).click();
  await expect(page.getByTestId(`allday-${WED}`).getByRole('button', { name: 'Conference' })).toBeVisible();

  for (const [title, start, end] of [['Dentist', '10:00', '11:00'], ['Call', '10:30', '11:30']]) {
    await page.getByRole('button', { name: 'New event' }).click();
    await dlg.getByLabel('Title').fill(title);
    await dlg.getByLabel('Date').fill(WED);
    await dlg.getByLabel('Start').fill(start);
    await dlg.getByLabel('End').fill(end);
    await dlg.getByRole('button', { name: 'Add event' }).click();
    await expect(dlg).toBeHidden();
  }
  const grid = page.getByTestId(`grid-${WED}`);
  await expect(grid.locator('.ev-event')).toHaveCount(2);
  await expect(grid.locator('.ev-event.conflict')).toHaveCount(2);
  await expect(grid.getByRole('button', { name: /Dentist, 10:00–11:00, overlaps another item/ })).toBeVisible();

  // Each kind lives only in its own area.
  await expect(page.getByTestId(`tasks-${WED}`).getByText('Conference')).toHaveCount(0);
  await expect(page.getByTestId(`allday-${WED}`).getByText('Write report')).toHaveCount(0);
  await expect(page.getByTestId(`tasks-${WED}`).getByText('Write report')).toBeVisible();
  await expect(grid.getByText('Conference')).toHaveCount(0);

  // Keyboard: create an untimed task directly in the day's task area.
  const add = page.getByLabel(/Add task for Wednesday 10 March 2027/);
  await add.focus();
  await page.keyboard.type('Keyboard task');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`tasks-${WED}`).getByText('Keyboard task')).toBeVisible();

  // Month and agenda views render the same items.
  await page.getByText('Month', { exact: true }).click();
  await expect(page.getByTestId(`month-${WED}`).getByText('Conference')).toBeVisible();
  await page.getByText('Agenda', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Timed schedule' }).first()).toBeVisible();
});

test('data persists after reload and sign-in again', async ({ page }) => {
  await signIn(page);
  await page.goto('/tasks?view=all');
  await expect(page.getByText('Write report')).toBeVisible();
  await expect(page.getByText('Keyboard task')).toBeVisible();
  await page.getByLabel('Search tasks').fill('report');
  await expect(page.getByText('Keyboard task')).toHaveCount(0);
  await expect(page.getByText('Write report')).toBeVisible();
});

test('assistant panel: sending a message shows the exchange (or a clear error) and never blanks the page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);

  // Default provider is Claude Code; here it is deliberately not installed.
  await page.getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByRole('complementary', { name: 'Assistant' });
  await expect(panel.getByText(/is not ready/)).toBeVisible();
  await expect(panel.getByLabel('Message to the assistant')).toHaveCount(0);

  // Switch to the pay-per-use provider, which has a key that is rejected (no cost, no real account).
  await page.goto('/settings');
  await page.getByLabel('Assistant runs on').selectOption('anthropic');
  await expect(page.getByText('Settings saved')).toBeVisible();
  await page.getByRole('button', { name: 'Assistant' }).click();
  await panel.getByLabel('Message to the assistant').fill('What is on today?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByText('What is on today?')).toBeVisible();
  await expect(panel.getByText(/Anthropic rejected the API key|Could not reach Anthropic/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible(); // the app is still there
  await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible(); // and ready for another message

  // The exchange is stored and shown again after a reload.
  await page.reload();
  await page.getByRole('button', { name: 'Assistant' }).click();
  await expect(panel.getByText('What is on today?')).toBeVisible();

  // Screenshots: attach one through the file chooser and one by pasting, remove one, send.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await panel.getByLabel('Choose images to attach').setInputFiles({ name: 'timetable.png', mimeType: 'image/png', buffer: png });
  const toSend = panel.getByLabel('Images to send');
  await expect(toSend.locator('img')).toHaveCount(1);
  await panel.getByLabel('Message to the assistant').focus();
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png.toString('base64'));
  await expect(toSend.locator('img')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Remove pasted.png' }).click();
  await expect(toSend.locator('img')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Send' }).click(); // an image alone can be sent
  const stored = panel.locator('.msg-user', { hasText: 'Please look at the attached image.' }).locator('img');
  await expect(stored).toHaveCount(1, { timeout: 30_000 });
  await expect(stored).toHaveAttribute('src', /\/api\/assistant\/images\//);
  await expect.poll(() => stored.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1); // served back from the server
  await expect(toSend).toHaveCount(0);
  expect(errors).toEqual([]);
});
