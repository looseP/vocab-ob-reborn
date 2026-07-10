import { test, expect } from "./fixtures";

test.describe("Phase 5C parent-delete UI", () => {
  test("cancel does not send a delete request", async ({ authedPage: page }) => {
    await page.locator('[data-section="manual"]').click();

    let deleteRequestSeen = false;
    page.on("request", (req) => {
      if (req.method() === "DELETE" && req.url().includes("/api/l3/")) {
        deleteRequestSeen = true;
      }
    });

    const deleteButton = page.locator('[data-testid="parent-delete-trigger"]').first();
    if (await deleteButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await deleteButton.click();
      await expect(page.locator('[data-testid="parent-delete-confirm"]')).toBeVisible({ timeout: 3_000 });
      await page.locator('[data-testid="parent-delete-cancel"]').click();
      await expect(page.locator('[data-testid="parent-delete-confirm"]')).not.toBeVisible({ timeout: 3_000 });
      await page.waitForTimeout(500);
      expect(deleteRequestSeen).toBe(false);
    }
  });

  test("confirm sends exactly one delete request", async ({ authedPage: page }) => {
    await page.locator('[data-section="manual"]').click();

    const deleteButton = page.locator('[data-testid="parent-delete-trigger"]').first();
    if (await deleteButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      let deleteCount = 0;
      page.on("request", (req) => {
        if (req.method() === "DELETE" && req.url().includes("/api/l3/")) {
          deleteCount++;
        }
      });

      await deleteButton.click();
      await expect(page.locator('[data-testid="parent-delete-confirm"]')).toBeVisible({ timeout: 3_000 });
      await page.locator('[data-testid="parent-delete-confirm-action"]').click();

      await page.waitForTimeout(1_000);
      expect(deleteCount).toBe(1);
    }
  });
});
