import { test as base, expect, type Page } from "@playwright/test";
import { E2E_OWNER_TOKEN } from "./constants";

const OWNER_TOKEN = E2E_OWNER_TOKEN;

export type AuthFixtures = {
  authedPage: Page;
};

export async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Vocab Observatory");
  await page.fill("#owner-token", OWNER_TOKEN);
  const loginResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/session") && response.request().method() === "POST",
  );
  await page.click('button[type="submit"]');
  const loginResponse = await loginResponsePromise;
  if (loginResponse.status() !== 201) {
    throw new Error(`Browser session login failed: ${loginResponse.status()} ${await loginResponse.text()}`);
  }
  await expect(page.locator(".session-toolbar")).toBeVisible({ timeout: 10_000 });
}

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ page }, use) => {
    await loginAsOwner(page);
    await use(page);
  },
});

export { expect, OWNER_TOKEN };
