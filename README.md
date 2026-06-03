# ProperChat

One chat surface, every model - with **Slack-style threads**. Talk to Claude, ChatGPT, and Gemini in a claude.ai-grade UI, **branch any message into a thread**, and **switch providers mid-conversation** while the (optionally compacted) history carries over.

## Why

The big chat UIs lock you into one linear conversation with one model. ProperChat models a conversation as a **tree**: the main chat is the root, and any message can spawn a thread (Slack-style), which can spawn one more sub-thread - `main -> thread -> sub-thread` (depth capped at `MAX_THREAD_BRANCHING = 2`). Each turn records which model/provider produced it, and you can collapse old history into a **compacted node** (a summary) that future turns continue from.

## Features

- **Every provider, one picker** - switch between Claude / ChatGPT / Gemini at any point; history is passed to the new provider automatically.
- **Threads** - branch any message into a side-panel thread; a "Threads" popover shows the whole conversation tree with a summary + model badge per node.
- **Compaction** - summarize a conversation into a compacted node; later turns continue from the leaf back to the nearest compaction.
- **claude.ai-style rendering** - GFM markdown, KaTeX math, dark code blocks with a language label + copy button, streamed token-by-token.
- **Bring your own keys** - add Anthropic / OpenAI / Google keys in Settings to call those providers directly, or use the shared InterpretAI backend.
- Light/dark themes, persistent chats, regenerate, stop.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

That's it - no configuration required. Open the app and add your own provider keys (Anthropic / OpenAI / Google) in **Settings**; they stay in your browser. To use the shared InterpretAI backend instead, mint an `iai_` key by signing up at [properchats.ai](https://properchats.ai) and paste it into Settings too. No keys are required to run the app - only to send a message to a given provider.

## Capabilities (and what's next)

ProperChat ships **plain chat** today and a set of provider-native **agent capabilities** that are wired but currently route differently:

| Capability | Status | Routing |
|------------|--------|---------|
| Chat | Live | Through the interpret backend by default, or direct with a BYO key |
| Web search | Live | **Direct only** (needs a key for a provider that supports it) |
| Image generation | Live | **Direct only** |
| Deep research | Live | **Direct only** (OpenAI) |
| Code interpreter | Live | **Direct only** |

The capability matrix (which providers serve which capability) lives in [`src/lib/capabilities.ts`](src/lib/capabilities.ts).

**What's next:**

- **Render designs in the chat** - display generated UI designs/artifacts (HTML/CSS/React) live inline in the conversation, not just static markdown and code blocks.
- **Route agent capabilities through the interpret backend** - so they are metered and logged like plain chat instead of going direct and bypassing it.

## Model catalog

12 tiers (`{provider} x {small, medium, large, xlarge}`). Each maps to a concrete model on the **interpret** backend and to a public model id for a **direct** call.

| Tier | Interpret (default) | Direct (BYO key) |
|------|---------------------|------------------|
| `cl-small`  | claude-haiku-3-5      | claude-haiku-4-5 |
| `cl-medium` | claude-sonnet-4-5     | claude-sonnet-4-6 |
| `cl-large`  | claude-opus-4-8       | claude-opus-4-8 |
| `cl-xlarge` | claude-opus-4-8 (1M)  | claude-opus-4-8 (1M) |
| `gp-small`  | gpt-5.4-nano          | gpt-5.4-nano |
| `gp-medium` | gpt-5.4-mini          | gpt-5.4-mini |
| `gp-large`  | gpt-5.5               | gpt-5.5 |
| `gp-xlarge` | gpt-5.5-pro           | gpt-5.5-pro |
| `ge-small`  | gemini-3.1-flash-lite | gemini-3.1-flash-lite |
| `ge-medium` | gemini-3.5-flash      | gemini-3.5-flash |
| `ge-large`  | gemini-3.1-pro-preview | gemini-3.1-pro-preview |
| `ge-xlarge` | gemini-3.1-pro-preview | gemini-3.1-pro-preview |

**Routing.** Gemini goes through the interpret backend by default; Claude/ChatGPT prefer a direct call when a key is available, else fall back to interpret. The picker shows a route badge and a ready/needs-key dot per model. The catalog is the single source of truth in [`src/lib/models.ts`](src/lib/models.ts).

## Architecture

- **[`src/lib/tree.ts`](src/lib/tree.ts)** - the conversation tree. `buildContext` walks root->leaf, inherits each thread's parent history up to its anchor message, and collapses prefixes at the closest compaction into the system prompt.
- **[`src/lib/store.ts`](src/lib/store.ts)** - Zustand store (localStorage-persisted): chats, the node tree, model segments, compactions, and the streaming send flow.
- **[`src/app/api/chat`](src/app/api/chat/route.ts)** - unified streaming proxy. Adapters translate the interpret SSE and direct Anthropic/OpenAI/Gemini streams into one `start/delta/done/error` protocol. Secrets stay server-side.
- **[`src/components/`](src/components/)** - `App`, `Sidebar`, `ChatPane`, `ThreadPanel`, `MessageList`, `Composer`, `ModelPicker`, `Markdown` + `CodeBlock`, `SettingsModal`.

## Testing

```bash
npm test            # Playwright E2E (auto-starts the dev server)
```

The default suite is an offline smoke test ([`tests/app.spec.ts`](tests/app.spec.ts)): it mocks the chat proxy, so it needs no keys or network and verifies the app boots, settings/BYO keys persist, theme toggles, new chats, and streaming all work. A manual model-matrix check ([`tests/all-models.spec.ts`](tests/all-models.spec.ts)) spawns every catalog model against the real backend - run it with `RUN_MODEL_MATRIX=1 npm test` and a dev server started with a valid `INTERPRETAI_API_KEY`.

## License

MIT - see [`LICENSE`](LICENSE).
