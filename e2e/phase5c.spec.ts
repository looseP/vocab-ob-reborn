import { test, expect } from "./fixtures";

const DELETE_ID = "00000000-0000-4000-8000-000000000050";

async function openDeleteForm(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Manual Editor", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Delete active row", exact: true })).toBeVisible();

  const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Delete active row", exact: true }) });
  await form.getByRole("combobox", { name: "Entity type", exact: true }).selectOption("source");
  await form.getByRole("textbox", { name: "Explicit id", exact: true }).fill(DELETE_ID);
  return form;
}

test.describe("Phase 5C parent-delete UI", () => {
  test("unconfirmed delete does not send a request", async ({ authedPage: page }) => {
    const form = await openDeleteForm(page);
    let deleteCount = 0;
    page.on("request", (request) => {
      if (request.method() === "DELETE" && request.url().includes("/api/l3/sources/")) {
        deleteCount += 1;
      }
    });

    const confirmation = form.getByRole("checkbox", { name: "Confirm delete for this explicit id.", exact: true });
    const deleteButton = form.getByRole("button", { name: "Delete row", exact: true });
    await expect(confirmation).not.toBeChecked();
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();

    await expect(form.getByText("Status: failed", { exact: true })).toBeVisible();
    expect(deleteCount).toBe(0);
  });

  test("confirmed delete sends exactly one request", async ({ authedPage: page }) => {
    const form = await openDeleteForm(page);
    let deleteCount = 0;
    await page.route(`**/api/l3/sources/${DELETE_ID}`, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue();
        return;
      }
      deleteCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          deleted: { entityType: "source", id: DELETE_ID },
          activeReadInvalidation: true,
        }),
      });
    });

    await form.getByRole("checkbox", { name: "Confirm delete for this explicit id.", exact: true }).check();
    const deleteButton = form.getByRole("button", { name: "Delete row", exact: true });
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();

    await expect(form.getByText(`Deleted source: ${DELETE_ID}`, { exact: true })).toBeVisible();
    expect(deleteCount).toBe(1);
    await expect(deleteButton).toBeDisabled();
  });
});
