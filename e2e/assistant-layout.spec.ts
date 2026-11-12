// Layout regression test for the assistant panel. The assistant's API responses are replaced
// in the browser (no model, no cost) so the test controls exactly what is on screen: several
// consecutive messages, long replies, multiple proposal cards, a reply in progress, and cards
// changing state. It runs at desktop width (narrow side panel) and on a phone-sized screen.
import { expect, test, type Page, type Route } from '@playwright/test';
import { signIn } from './helpers';

const LONG =
  'Here is a plan for tomorrow. ' +
  'You have a stand-up at 09:00, then a free block until lunch which fits the report draft. '.repeat(6) +
  '\n\n- 09:15–11:00 Write report\n- 13:00–13:45 Review pull requests\n- 15:00 Dentist (https://example.com/a/very/long/url/that/should/wrap/inside/the/panel/and/not/overflow/horizontally/at/all)\n\n```\nsome_code_block_with_a_very_long_unbroken_identifier_that_must_wrap_inside_the_panel_too()\n```';

const STATUS = {
  state: 'ready', provider: 'anthropic', providerName: 'Test assistant', model: 'test', billing: 'api', message: null, providers: [],
  claudeCode: null, claudeCodeModels: [], planLimitResetsAt: null, remoteBlocked: false, includeTraining: false,
};
const action = (id: string, summary: string, details: string[]) => ({
  id, createdAt: '2026-11-11T08:00:00.000Z', tool: 'propose_create_task', summary, details, external: false, status: 'proposed', result: null, canUndo: false, decidedAt: null, digest: 'a'.repeat(64),
});
const message = (id: string, role: 'user' | 'assistant', text: string, proposalIds: string[] = []) => ({
  id, createdAt: '2026-11-11T08:00:00.000Z', role, text, provider: role === 'assistant' ? 'anthropic' : null, model: null, proposalIds, imageIds: [], error: false,
});

/** Everything that would make the conversation unreadable, measured from real element boxes. */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const box = document.querySelector('[data-testid=chat-scroll]') as HTMLElement;
    const log = document.querySelector('[data-testid=chat-log]') as HTMLElement;
    const b = box.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(box).paddingLeft);
    const inFlow = (parent: Element, what: string) => {
      const kids = [...parent.children].filter((e) => (e as HTMLElement).offsetParent !== null) as HTMLElement[];
      kids.forEach((e, i) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        const name = `${what}[${i}] .${e.className.split(' ').join('.')}`;
        if (cs.position !== 'static' && cs.position !== 'relative') problems.push(`${name} is taken out of flow (position: ${cs.position})`);
        if (e.scrollHeight > e.clientHeight + 1) problems.push(`${name} is shorter than its content (${e.clientHeight} < ${e.scrollHeight})`);
        if (r.left < b.left - 0.5 || r.right > b.right + 0.5) problems.push(`${name} sticks out of the panel horizontally`);
        if (i > 0) {
          const prev = kids[i - 1].getBoundingClientRect();
          if (r.top < prev.bottom - 0.5) problems.push(`${name} overlaps the element before it by ${Math.round(prev.bottom - r.top)}px`);
        }
      });
      return kids;
    };
    const messages = inFlow(log, 'message');
    for (const m of messages) {
      inFlow(m, 'part');
      for (const card of m.querySelectorAll('.proposal')) inFlow(card, 'card-part');
      const r = m.getBoundingClientRect();
      // Assistant messages start at the left edge; user bubbles end at the right edge and do not span the full width.
      if (m.dataset.role === 'assistant' && Math.abs(r.left - (b.left + pad)) > 2) problems.push('assistant message is not left-aligned');
      if (m.dataset.role === 'user' && (Math.abs(r.right - (b.left + box.clientWidth - pad)) > 2 || r.left < b.left + pad + 8)) problems.push('user message is not right-aligned');
    }
    if (box.scrollWidth > box.clientWidth + 1) problems.push('the message area scrolls sideways');
    const input = document.querySelector('.assistant-input')!.getBoundingClientRect();
    if (input.top < b.bottom - 0.5) problems.push('the input area covers the messages');
    if (input.bottom > window.innerHeight + 0.5) problems.push('the input area is pushed off screen');
    if (document.documentElement.scrollHeight > window.innerHeight + 1) problems.push('the page itself scrolls instead of the message area');
    return problems;
  });
}
const distanceFromBottom = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid=chat-scroll]') as HTMLElement;
  return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
});
const scrollTop = (page: Page) => page.evaluate(() => Math.round((document.querySelector('[data-testid=chat-scroll]') as HTMLElement).scrollTop));

test('assistant conversation: messages and cards stack without overlapping, the list scrolls on its own, and it only follows when at the bottom', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // --- what the (replaced) server returns ---
  const actions = [0, 1, 2].flatMap((r) => [
    action(`a${r}1`, `Create task "Renew passport ${r}"`, ['Planned day: none', 'Deadline: Fri 13 Nov']),
    action(`a${r}2`, `Create task "Book flights ${r}" with a deliberately long title that has to wrap inside the card`, ['Planned day: Thu 12 Nov', 'Deadline: none', 'Estimate: 30 min']),
  ]);
  const history = [0, 1, 2].flatMap((r) => [
    message(`m${r}1`, 'user', `Plan tomorrow around my meetings and training (${r})`),
    message(`m${r}2`, 'assistant', LONG, [`a${r}1`, `a${r}2`]),
    message(`m${r}3`, 'user', 'Thanks. And what about Thursday?'),
    message(`m${r}4`, 'assistant', 'Thursday is light: only the team stand-up.'),
  ]);
  let held: Route | null = null;
  await page.route('**/api/assistant/status*', (r) => r.fulfill({ json: STATUS }));
  await page.route('**/api/assistant/history', (r) => r.fulfill({ json: history }));
  await page.route('**/api/assistant/actions', (r) => r.fulfill({ json: [...actions].reverse() }));
  await page.route('**/api/assistant/actions/*/confirm', (r) => {
    const a = actions.find((x) => r.request().url().includes(`/${x.id}/`))!;
    Object.assign(a, { status: 'executed', canUndo: true, result: 'Task created: "A task with quite a long confirmation message that wraps over several lines in a narrow panel" (planned no day, deadline 2026-11-13).' });
    return r.fulfill({ json: a });
  });
  await page.route('**/api/assistant/send', (r) => {
    held = r; // answered later, so the "reply in progress" state can be inspected
  });

  await signIn(page);
  await page.getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByRole('complementary', { name: 'Assistant' });
  await expect(panel.locator('.proposal')).toHaveCount(6);

  // 1. A long stored conversation: readable, and opened at the newest message.
  expect(await layoutProblems(page)).toEqual([]);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(4);
  expect(await page.evaluate(() => {
    const el = document.querySelector('[data-testid=chat-scroll]') as HTMLElement;
    return el.scrollHeight > el.clientHeight * 2;
  })).toBe(true); // there really is something to scroll

  // 2. Reading earlier messages: confirming a card up there makes it taller, but the view stays put.
  await page.evaluate(() => { (document.querySelector('[data-testid=chat-scroll]') as HTMLElement).scrollTop = 0; });
  await expect(panel.getByRole('button', { name: /Jump to latest/ })).toBeVisible();
  const firstCard = panel.locator('.proposal').first();
  await firstCard.getByRole('button', { name: 'Confirm' }).scrollIntoViewIfNeeded(); // the reader scrolls to an early card
  await expect(panel.getByRole('button', { name: /Jump to latest/ })).toBeVisible();
  const readingAt = await scrollTop(page);
  expect(await distanceFromBottom(page)).toBeGreaterThan(500); // far from the newest message
  const before = await firstCard.evaluate((e) => e.getBoundingClientRect().height);
  await firstCard.getByRole('button', { name: 'Confirm' }).click();
  await expect(firstCard.getByText(/Task created: "A task with quite a long confirmation message/)).toBeVisible();
  expect(await firstCard.evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThan(before); // the card grew with its content
  expect(await layoutProblems(page)).toEqual([]);
  expect(Math.abs((await scrollTop(page)) - readingAt)).toBeLessThan(4); // position preserved
  await panel.getByRole('button', { name: /Jump to latest/ }).click();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(4);

  // 3. A reply in progress: the new bubble and the placeholder take their place at the end.
  await panel.getByLabel('Message to the assistant').fill('Add two more tasks for Friday, please, and explain your reasoning in detail.');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByTestId('streaming')).toContainText('Thinking…');
  await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible();
  expect(await layoutProblems(page)).toEqual([]);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(4);

  // The reply arrives (text, then two new proposal cards) while the reader is at the bottom: the view follows.
  actions.push(action('a91', 'Create task "Friday task one"', ['Planned day: Fri 13 Nov']), action('a92', 'Create task "Friday task two"', ['Planned day: Fri 13 Nov']));
  history.push(message('m91', 'user', 'Add two more tasks for Friday, please, and explain your reasoning in detail.'), message('m92', 'assistant', LONG, ['a91', 'a92']));
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  await held!.fulfill({
    contentType: 'text/event-stream',
    body: sse('tool', { name: 'get_schedule', ok: true }) + LONG.match(/.{1,80}/gs)!.map((t) => sse('delta', { text: t })).join('') + sse('done', { message: history.at(-1), proposals: actions.slice(-2) }),
  });
  await expect(panel.locator('.proposal')).toHaveCount(8);
  await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible();
  expect(await layoutProblems(page)).toEqual([]);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(4);

  // 4. Confirming the newest cards (they grow) while at the bottom keeps the end in view and nothing collides.
  await panel.locator('.proposal').last().getByRole('button', { name: 'Confirm' }).click();
  await expect(panel.locator('.proposal').last().getByText(/Task created/)).toBeVisible();
  await panel.locator('.proposal').nth(6).getByRole('button', { name: 'Confirm' }).click();
  await expect(panel.locator('.proposal.executed')).toHaveCount(3);
  expect(await layoutProblems(page)).toEqual([]);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(4);
  await expect(panel.locator('.proposal.proposed')).toHaveCount(5); // the other pending confirmations are untouched

  // 5. A reply that arrives while the reader has scrolled up does not pull them back down.
  held = null;
  await panel.getByLabel('Message to the assistant').fill('One more question');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByTestId('streaming')).toBeVisible();
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=chat-scroll]') as HTMLElement;
    el.scrollTop = 200;
    el.dispatchEvent(new Event('scroll'));
  });
  history.push(message('m93', 'user', 'One more question'), message('m94', 'assistant', LONG));
  await held!.fulfill({ contentType: 'text/event-stream', body: sse('delta', { text: LONG }) + sse('done', { message: history.at(-1), proposals: [] }) });
  await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(panel.locator('[data-role=assistant]')).toHaveCount(8);
  expect(Math.abs((await scrollTop(page)) - 200)).toBeLessThan(4);
  expect(await layoutProblems(page)).toEqual([]);
  expect(errors).toEqual([]);
});
