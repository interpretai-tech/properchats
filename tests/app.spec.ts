import { expect, type Page, test } from "@playwright/test";

/**
 * Offline smoke tests for the standalone app: no Supabase, no accounts, no
 * billing, no keys required. The streaming test mocks `/api/chat`, so the whole
 * suite runs without touching a real model backend. This is the safety net that
 * proves the app boots and the core surfaces work even when nothing is
 * configured.
 */

const composer = (page: Page) => page.getByTestId("composer-main");

async function openSettings(page: Page) {
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
}

test("boots into the chat UI with no auth gate and no keys", async ({ page }) => {
  await page.goto("/");
  // The app shell renders straight into the chat (no sign-in screen).
  await expect(page.getByTestId("chat-pane")).toBeVisible();
  await expect(composer(page).getByTestId("composer-input")).toBeVisible();
  // A default chat exists in the sidebar.
  await expect(page.getByTestId("new-chat")).toBeVisible();
});

test("/api/config reports server-key booleans only", async ({ request }) => {
  const res = await request.get("/api/config");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(Object.keys(body).sort()).toEqual(["anthropic", "gemini", "interpret", "openai"]);
  for (const v of Object.values(body)) expect(typeof v).toBe("boolean");
  // No account/billing fields leak into the public config.
  expect(body).not.toHaveProperty("storedProviders");
});

test("settings has General/API/Usage tabs and no Billing tab", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await expect(page.getByTestId("settings-tab-general")).toBeVisible();
  await expect(page.getByTestId("settings-tab-api")).toBeVisible();
  await expect(page.getByTestId("settings-tab-usage")).toBeVisible();
  await expect(page.getByTestId("settings-tab-billing")).toHaveCount(0);
});

test("a BYO provider key persists across reopen (localStorage)", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await page.getByTestId("settings-tab-api").click();
  const field = page.getByTestId("key-anthropic");
  await field.fill("sk-ant-test-key");
  await page.getByTestId("settings-close").click();
  // Reopen: the key was committed to the store (and localStorage), so it's back.
  await openSettings(page);
  await page.getByTestId("settings-tab-api").click();
  await expect(page.getByTestId("key-anthropic")).toHaveValue("sk-ant-test-key");
});

test("theme toggle flips the dark class", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const before = await html.evaluate((el) => el.classList.contains("dark"));
  await page.getByTestId("theme-toggle").click();
  await expect
    .poll(() => html.evaluate((el) => el.classList.contains("dark")))
    .toBe(!before);
});

test("new chat creates an empty conversation", async ({ page }) => {
  await page.goto("/");
  const before = await page.getByTestId("chat-item").count();
  await page.getByTestId("new-chat").click();
  await expect(composer(page).getByTestId("composer-input")).toHaveValue("");
  // The active chat is fresh: no assistant messages yet.
  await expect(
    page.getByTestId("chat-pane").locator('[data-testid="message"]'),
  ).toHaveCount(0);
  expect(before).toBeGreaterThanOrEqual(0);
});

test("streams an assistant reply through the proxy (mocked backend)", async ({ page }) => {
  // Mock the chat proxy with a canned SSE stream so this exercises the full
  // client streaming pipeline without a real model backend or any key.
  await page.route("**/api/chat", async (route) => {
    const body = [
      `data: ${JSON.stringify({ type: "start", provider: "gemini", route: "interpret" })}`,
      "",
      `data: ${JSON.stringify({ type: "delta", text: "Hello from the mock." })}`,
      "",
      `data: ${JSON.stringify({ type: "done" })}`,
      "",
      "",
    ].join("\n");
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      body,
    });
  });

  await page.goto("/");
  await page.getByTestId("new-chat").click();
  const input = composer(page).getByTestId("composer-input");
  await input.fill("hi");
  await composer(page).getByTestId("send-button").click();

  const assistant = page
    .getByTestId("chat-pane")
    .locator('[data-testid="message"][data-role="assistant"]')
    .last();
  await expect(assistant).toContainText("Hello from the mock.");
  await expect(assistant.getByTestId("message-error")).toHaveCount(0);
});
