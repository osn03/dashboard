import { expect, type Page } from '@playwright/test';

export const USER = { username: 'me', password: 'correct horse battery' };
export async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Username').fill(USER.username);
  await page.getByLabel('Password', { exact: true }).fill(USER.password);
  const repeat = page.getByLabel('Repeat password');
  if (await repeat.isVisible()) {
    await repeat.fill(USER.password);
    await page.getByRole('button', { name: 'Create account' }).click();
  } else {
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
}
