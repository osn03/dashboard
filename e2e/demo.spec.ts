// Demo mode in a real browser: sample data only, in its own database, no outside connections.
// This also exercises the screens that need integration data (Google calendars, training).
import { expect, test } from '@playwright/test';

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(new Date());
const plus = (n: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC' }).format(new Date(Date.parse(`${today()}T12:00:00Z`) + n * 864e5));

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/Demo mode: sample data in a separate database/)).toBeVisible();
  await page.getByLabel('Username').fill('demo');
  await page.getByLabel('Password', { exact: true }).fill('demo-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
});

test('demo mode is clearly labelled and integrations are marked as demo', async ({ page }) => {
  await expect(page.getByText(/DEMO MODE — sample data in a separate database/)).toBeVisible();
  await page.goto('/settings');
  const google = page.getByRole('region', { name: 'Google Calendar' });
  await expect(google.getByText('Demo data – not a real account')).toBeVisible();
  await expect(google.getByText('Team (demo, read-only)')).toBeVisible();
  await expect(google.getByText('Read-only', { exact: true })).toBeVisible();
  await expect(google.getByRole('button', { name: 'Sync now' })).toHaveCount(0); // nothing to contact
  await expect(page.getByRole('region', { name: 'Intervals.icu' }).getByText('Demo data', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Assistant', exact: true }).getByText('Off in demo mode')).toBeVisible();
});

test('Today and Training show planned and completed training, with missing values marked', async ({ page }) => {
  const card = page.getByRole('region', { name: "Today's training" });
  await expect(card.getByText('Endurance ride')).toBeVisible();
  await expect(card.getByText('No set time')).toBeVisible();
  await expect(card.getByText(/Demo training data/)).toBeVisible();

  await page.getByRole('link', { name: 'Training' }).first().click();
  await expect(page.getByRole('heading', { name: 'Training', level: 1 })).toBeVisible();
  const week = page.getByRole('region', { name: 'Weekly planned versus completed' });
  await expect(week.getByRole('columnheader', { name: 'Planned' })).toBeVisible();
  await expect(week.getByRole('columnheader', { name: 'Completed' })).toBeVisible();
  // "Strength" has no duration or load in the source: it must show as not recorded, never as 0.
  const upcoming = page.getByRole('region', { name: 'Upcoming training' });
  await expect(upcoming.locator('li', { hasText: 'Strength' }).getByText('duration not recorded')).toBeVisible();
  await expect(upcoming.locator('li', { hasText: 'Strength' })).not.toContainText('0 min');
  await expect(page.getByRole('region', { name: 'Load and recovery trends' }).getByRole('img', { name: /HRV/ })).toBeVisible();
});

test('calendar combines calendars with source labels, a Training row, and duplicate hiding', async ({ page }) => {
  const d0 = today();
  const d1 = plus(1);
  await page.goto(`/calendar?view=day&date=${d0}`);
  await expect(page.getByTestId(`training-${d0}`).getByText('Endurance ride')).toBeVisible(); // untimed training area
  await expect(page.getByTestId(`allday-${d0}`).getByText('Endurance ride')).toHaveCount(0);
  await expect(page.getByTestId(`tasks-${d0}`).getByText('Endurance ride')).toHaveCount(0);
  const grid = page.getByTestId(`grid-${d0}`);
  const review = grid.getByRole('button', { name: /Google calendar Team \(demo, read-only\), read-only: Design review/ });
  await expect(review).toBeVisible();
  await review.click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText('Event (read-only)')).toBeVisible();
  await expect(dlg.getByLabel('Title')).toBeDisabled();
  await expect(dlg.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Close' }).last().click();

  // Tomorrow: "Easy run" exists both as a timed planned workout and as a Google event.
  await page.goto(`/calendar?view=day&date=${d1}`);
  const g1 = page.getByTestId(`grid-${d1}`);
  await expect(g1.locator('.ev-training', { hasText: 'Easy run' })).toHaveCount(1);
  const dup = g1.locator('.ev-google', { hasText: 'Easy run' });
  await expect(dup).toHaveCount(1);
  await dup.click();
  await expect(dlg.getByText(/Possible duplicate: Intervals.icu has a planned workout/)).toBeVisible();
  await dlg.getByRole('button', { name: 'Hide here' }).click();
  await expect(g1.locator('.ev-google', { hasText: 'Easy run' })).toHaveCount(0);
  await expect(g1.locator('.ev-training', { hasText: 'Easy run' })).toHaveCount(1); // the workout itself stays
  await expect(g1.getByText('Lunch with Kari')).toBeVisible(); // unrelated items untouched

  await page.goto('/settings');
  const hidden = page.getByRole('region', { name: 'Google Calendar' }).locator('li', { hasText: 'Easy run' });
  await hidden.getByRole('button', { name: 'Show again' }).click();
  await page.goto(`/calendar?view=day&date=${d1}`);
  await expect(page.getByTestId(`grid-${d1}`).locator('.ev-google', { hasText: 'Easy run' })).toHaveCount(1);

  // Training opens as read-only details.
  await page.getByTestId(`grid-${d1}`).locator('.ev-training', { hasText: 'Easy run' }).click();
  await expect(dlg.getByText('Planned workout')).toBeVisible();
  await expect(dlg.getByText('8 km')).toBeVisible();
});

test('weekly review, notes on tasks and projects, and the assistant panel', async ({ page }) => {
  await page.getByRole('link', { name: 'Review' }).first().click();
  await expect(page.getByRole('heading', { name: 'Weekly review' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Training this week' }).getByRole('columnheader', { name: 'Completed' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Unfinished tasks' })).toContainText('Send invoice');

  await page.goto('/tasks?view=all');
  await page.getByRole('button', { name: 'Draft launch announcement' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText('Tone: friendly, short, one clear call to action.')).toBeVisible();
  await dlg.getByLabel('New note for this task').fill('Second note from the test');
  await dlg.getByRole('button', { name: 'Add note' }).click();
  await expect(dlg.getByText('Second note from the test')).toBeVisible();
  await dlg.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: /Website relaunch/ }).click();
  await page.getByText('Project notes').click();
  await expect(page.getByText('Stakeholders want a preview by Thursday.')).toBeVisible();
  await page.getByLabel('New note for this project').fill('Project note from the test');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Project note from the test')).toBeVisible();
  await page.reload();
  await page.getByText('Project notes').click();
  await expect(page.getByText('Project note from the test')).toBeVisible(); // persisted

  await page.getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByRole('complementary', { name: 'Assistant' });
  await expect(panel.getByText('The assistant is switched off in demo mode.')).toBeVisible();
  await panel.getByText('Action history').click();
  await expect(panel.getByText(/No actions yet/)).toBeVisible();
});
