import { test as base, expect, type Page } from "@playwright/test";

const OWNER_TOKEN = "test-owner-token-for-e2e-0123456789";

export type AuthFixtures = {
  authedPage: Page;
};

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ page }, use) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Vocab Observatory");
    await page.fill("#owner-token", OWNER_TOKEN);
    await page.click('button[type="submit"]');
    await expect(page.locator(".session-toolbar")).toBeVisible({ timeout: 5_000 });
    await use(page);
  },
});

export { expect, OWNER_TOKEN };
