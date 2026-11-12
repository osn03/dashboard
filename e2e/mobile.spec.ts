// Core task and calendar workflows on a phone-sized touch viewport (tap alternatives, no drag).
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

const THU = '2027-03-11';

test('mobile: add a task, schedule it by tapping, and unschedule it', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.getByRole('link', { name: 'Calendar' }).tap();
  await page.goto(`/calendar?date=${THU}`); // defaults to day view on narrow screens
  await expect(page.getByTestId(`tasks-${THU}`)).toBeVisible();

  const add = page.getByLabel(/Add task for Thursday 11 March 2027/);
  await add.fill('Phone task');
  await add.press('Enter');
  const chip = page.getByTestId(`tasks-${THU}`).getByRole('button', { name: /Phone task/ });
  await expect(chip).toBeVisible();

  await chip.tap();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Start').fill('07:00');
  await dlg.getByRole('button', { name: 'Add time block' }).tap();
  await dlg.getByRole('button', { name: 'Cancel' }).tap();
  const block = page.getByTestId(`grid-${THU}`).locator('.ev-block');
  await expect(block).toContainText('Phone task');
  await expect(page.getByTestId(`tasks-${THU}`).getByText('Phone task')).toHaveCount(0);

  await block.tap();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove from schedule' }).tap();
  await expect(page.getByTestId(`tasks-${THU}`).getByText('Phone task')).toBeVisible();

  // No horizontal overflow of the page itself.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
