import { expect, type Page, test } from "@playwright/test";

/**
 * Spawns every one of the 12 catalog models through the real UI + proxy and
 * reports per-model status. Models expected to work live in this environment:
 * all except ge-large / ge-xlarge, whose interpret tiers map to deprecated
 * Gemini models on the staging backend (out of our control) - those must fail
 * *gracefully* (a clean error bubble), not crash.
 */

const MODELS = [
  "cl-small", "cl-medium", "cl-large", "cl-xlarge",
  "gp-small", "gp-medium", "gp-large", "gp-xlarge",
  "ge-small", "ge-medium", "ge-large", "ge-xlarge",
];
const EXPECT_OK = new Set(MODELS.filter((m) => m !== "ge-large" && m !== "ge-xlarge"));

const assistants = (page: Page) =>
  page.getByTestId("chat-pane").locator('[data-testid="message"][data-role="assistant"]');

test("all 12 models spawn through the proxy", async ({ page }) => {
  // Manual integration check: spawns every catalog model against the real
  // interpret backend, so results depend on that backend's live model
  // availability (not on this repo). Opt in explicitly with RUN_MODEL_MATRIX=1
  // and a dev server started with a valid INTERPRETAI_API_KEY; the default
  // `npm test` runs the offline smoke suite (app.spec.ts) only.
  test.skip(process.env.RUN_MODEL_MATRIX !== "1", "set RUN_MODEL_MATRIX=1 to run the model matrix");
  test.setTimeout(540_000);
  await page.goto("/");
  await expect(page.getByTestId("composer-main")).toBeVisible({ timeout: 45_000 });

  const results: Record<string, string> = {};

  for (const id of MODELS) {
    await page.getByTestId("new-chat").click();
    const composer = page.getByTestId("composer-main");
    await composer.getByTestId("model-picker").click();
    await composer.getByTestId(`model-option-${id}`).click();
    await composer.getByTestId("composer-input").fill("Reply with the single word: ok");
    await composer.getByTestId("send-button").click();

    let status: string;
    try {
      // streaming finished when the send button returns
      await expect(composer.getByTestId("send-button")).toBeVisible({ timeout: 90_000 });
      const reply = assistants(page).last();
      const errored = (await reply.getByTestId("message-error").count()) > 0;
      const text = (await reply.innerText()).trim();
      status = errored ? "ERR" : text.length > 0 ? "OK" : "EMPTY";
    } catch {
      status = "TIMEOUT";
    }
    results[id] = status;
    console.log(`MODEL ${id.padEnd(10)} -> ${status}`);
  }

  console.log("SUMMARY", JSON.stringify(results));

  for (const id of MODELS) {
    if (EXPECT_OK.has(id)) {
      expect(results[id], `${id} should stream a reply`).toBe("OK");
    } else {
      // ge-large / ge-xlarge: must spawn and fail gracefully, not crash/hang.
      expect(["ERR", "OK"], `${id} should at least dispatch cleanly`).toContain(results[id]);
    }
  }
});
