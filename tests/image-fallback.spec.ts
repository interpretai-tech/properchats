import { expect, type Page, test } from "@playwright/test";

/**
 * Image generation on a model that can't make images (Claude) must NOT silently
 * reroute to another provider. It surfaces a helpful message and offers the
 * image-capable providers (ChatGPT + Gemini) as explicit picks; the turn only
 * reaches the backend once the user chooses. Capabilities run as direct provider
 * calls, so picking ChatGPT routes to a direct OpenAI model. Fully offline —
 * /api/{config,chat} are mocked, so it's deterministic and key-free.
 */

// 1x1 PNG (red) so an <img> actually renders.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Ev = Record<string, unknown>;
const sse = (events: Ev[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const composer = (page: Page) => page.getByTestId("composer-main");
const assistants = (page: Page) =>
  page.getByTestId("chat-pane").locator('[data-testid="message"][data-role="assistant"]');

test("image on Claude warns + offers image-capable providers instead of silently rerouting", async ({
  page,
}) => {
  const chatCalls: { provider?: string; model?: string; route?: string; capability?: string }[] = [];
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/config", (r) =>
    r.fulfill({ json: { interpret: true, anthropic: true, openai: true, gemini: true } }),
  );
  await page.route("**/api/model-window", (r) => r.fulfill({ json: { window: 1_000_000 } }));
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as {
      provider?: string;
      model?: string;
      route?: string;
      capability?: string;
    };
    chatCalls.push({
      provider: body.provider,
      model: body.model,
      route: body.route,
      capability: body.capability,
    });
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
      body: sse([
        { type: "start", provider: "openai", route: "direct", model: "gpt-5.5" },
        { type: "image", b64: PNG_1x1, mime: "image/png" },
        { type: "delta", text: "Here is the image you asked for." },
        { type: "done", usage: { input: 10, output: 20 }, stopReason: "stop" },
      ]),
    });
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 45_000 });

  // Select a Claude (anthropic) model — it can't generate images.
  await composer(page).getByTestId("model-picker").click();
  await composer(page).getByTestId("model-option-cl-large").click();

  // Choose the Image capability and send.
  await composer(page).getByTestId("capability-picker").click();
  await page.getByTestId("capability-option-image").click();
  await composer(page).getByTestId("composer-input").fill("Draw a red square.");
  await composer(page).getByTestId("send-button").click();

  // Blocked client-side: helpful error + fallback chips, and no backend call yet.
  const reply = assistants(page).last();
  await expect(reply.getByTestId("message-error")).toContainText(/can't generate images/i);
  await expect(reply.getByTestId("capability-fallback-openai")).toBeVisible();
  await expect(reply.getByTestId("capability-fallback-gemini")).toBeVisible();
  expect(chatCalls, "no backend call for a blocked image turn").toHaveLength(0);

  // Pick ChatGPT: a direct OpenAI image call, the error clears, the image renders.
  await reply.getByTestId("capability-fallback-openai").click();
  await expect(reply.getByTestId("message-error")).toHaveCount(0);
  await expect(reply.locator('img[alt="Generated image"]')).toBeVisible({ timeout: 30_000 });

  expect(chatCalls).toHaveLength(1);
  expect(chatCalls[0].provider).toBe("openai");
  expect(chatCalls[0].route).toBe("direct");
  expect(chatCalls[0].model).toBe("gpt-5.5");
  expect(chatCalls[0].capability).toBe("image");
});
