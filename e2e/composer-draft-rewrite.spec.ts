import { expect, test } from '@playwright/test';

/**
 * The composer's ✦ draft-rewrite arm in a real Chromium page.
 *
 * WHY IT IS OPT-IN. A full-tree Playwright run starts one isolated server per invocation, and
 * the fixture project/session this spec must open is seeded by whichever selection needs it —
 * naming them here would make the spec depend on another criterion's fixture. So the spec runs
 * only when the caller names both (`QUAY_E2E_DRAFT_REWRITE_PROJECT` / `..._SESSION`), and skips
 * with a stated reason otherwise. The always-run page arm for this feature is
 * `scripts/scenarios/composer-draft-rewrite.json` through `scripts/ui-scenario.mjs`.
 *
 * WHAT IT PROVES. On a real page: a non-blank draft draws the ✦ chip; pressing it sends exactly
 * one POST to the draft-rewrite endpoint; the candidate appears with only two icon controls; a
 * press on the panel folds it without a second request; and applying replaces the draft without
 * sending a message. The gateway is a LOCAL route mock (`page.route`), so this says nothing
 * about model quality. All draft text is synthetic.
 */

const PROJECT = process.env.QUAY_E2E_DRAFT_REWRITE_PROJECT ?? '';
const SESSION = process.env.QUAY_E2E_DRAFT_REWRITE_SESSION ?? '';
const DRAFT = 'we meet thursday at three  discuss the payment flow  bring the last spreadsheet';
const REWRITTEN = 'We meet Thursday at three to discuss the payment flow; please bring the last spreadsheet.';

test('composer draft rewrite: chip, one request, preview, cache, apply-without-send', async ({ page }) => {
  test.skip(
    PROJECT === '' || SESSION === '',
    'set QUAY_E2E_DRAFT_REWRITE_PROJECT and QUAY_E2E_DRAFT_REWRITE_SESSION to a seeded fixture',
  );

  let requests = 0;
  await page.route('**/api/reply-suggestions/draft-rewrite', async (route) => {
    requests += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rewrittenText: REWRITTEN }),
    });
  });

  // Enable the dev-only scenario surface and sign in with the run's token, as the other specs do.
  const token = process.env.QUAY_E2E_AUTH_TOKEN ?? '';
  await page.addInitScript(({ authToken }) => {
    window.localStorage.setItem('ui-scenario', 'on');
    window.localStorage.setItem('auth-token', authToken);
    window.localStorage.setItem('userLanguage', 'en');
  }, { authToken: token });

  await page.goto('/');
  await page.getByText(PROJECT, { exact: false }).first().click();
  await page.getByText(SESSION, { exact: false }).first().click();

  const textarea = page.locator('[data-slot="prompt-input-textarea"]');
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });
  await textarea.fill(DRAFT);

  const chip = page.locator('[data-slot="draft-rewrite-chip"]');
  await expect(chip).toBeVisible();
  await chip.click();

  const panel = page.locator('[data-slot="draft-rewrite-panel"]');
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-slot="draft-rewrite-candidate"]')).toHaveText(REWRITTEN);
  expect(requests).toBe(1);
  // No heading, no status copy — only the candidate body and the two icon controls.
  await expect(panel.locator('h1,h2,h3,h4,h5,h6')).toHaveCount(0);
  await expect(panel.locator('button')).toHaveCount(2);

  // A press on the panel's non-button area folds it; re-opening is free.
  await panel.locator('[data-slot="draft-rewrite-candidate"]').click();
  await expect(chip).toBeVisible();
  expect(requests).toBe(1);
  await chip.click();
  await expect(page.locator('[data-slot="draft-rewrite-candidate"]')).toHaveText(REWRITTEN);
  expect(requests, 'the cached candidate spends no second request').toBe(1);

  // Apply replaces the draft and sends nothing.
  const messagesBefore = await page.locator('[data-message-style]').count();
  await page.locator('[data-slot="draft-rewrite-apply"]').click();
  await expect(textarea).toHaveValue(REWRITTEN);
  expect(requests).toBe(1);
  expect(await page.locator('[data-message-style]').count()).toBe(messagesBefore);
});
