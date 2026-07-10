import { test, expect, loginAsOwner, OWNER_TOKEN } from "./fixtures";

test.describe("Browser authentication E2E", () => {
  test("login page is shown to anonymous visitors", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Vocab Observatory");
    await expect(page.locator("#owner-token")).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test("HttpOnly session cookie is set after login", async ({ page }) => {
    await loginAsOwner(page);

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name === "vocab_session");
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie!.httpOnly).toBe(true);
    expect(sessionCookie!.sameSite).toBe("Lax");
  });

  test("session persists across page refresh", async ({ page }) => {
    await loginAsOwner(page);

    await page.reload();
    await expect(page.locator(".session-toolbar")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#owner-token")).not.toBeVisible();
  });

  test("CSRF token is required for state-changing requests", async ({ page }) => {
    await loginAsOwner(page);

    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const response = await page.request.post("/api/l3/proposals", {
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:3099",
      },
      data: {},
    });
    expect(response.status()).toBe(403);
  });

  test("cross-site Origin is rejected for mutations", async ({ page }) => {
    await loginAsOwner(page);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "vocab_csrf");
    expect(csrfCookie).toBeDefined();

    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const response = await page.request.post("/api/l3/proposals", {
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        "X-CSRF-Token": csrfCookie!.value,
      },
      data: {},
    });
    expect(response.status()).toBe(403);
  });

  test("logout revokes session and clears cookies", async ({ page }) => {
    await loginAsOwner(page);

    await page.click(".session-toolbar button");
    await expect(page.locator("#owner-token")).toBeVisible({ timeout: 5_000 });

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name === "vocab_session");
    expect(sessionCookie?.value).toBeFalsy();

    await page.reload();
    await expect(page.locator("#owner-token")).toBeVisible({ timeout: 5_000 });
  });

  test("owner token never appears in browser storage, DOM, or bundle", async ({ page }) => {
    await loginAsOwner(page);

    const localStorageKeys = await page.evaluate(() => Object.keys(localStorage));
    const sessionStorageKeys = await page.evaluate(() => Object.keys(sessionStorage));
    for (const key of [...localStorageKeys, ...sessionStorageKeys]) {
      const value = await page.evaluate(
        (k) => localStorage.getItem(k) ?? sessionStorage.getItem(k),
        key,
      );
      expect(value).not.toContain(OWNER_TOKEN);
    }

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain(OWNER_TOKEN);

    const scripts = await page.locator("script").all();
    for (const script of scripts) {
      const src = await script.getAttribute("src");
      if (!src) continue;
      const response = await page.request.get(src);
      const text = await response.text();
      expect(text).not.toContain(OWNER_TOKEN);
    }
  });
});
