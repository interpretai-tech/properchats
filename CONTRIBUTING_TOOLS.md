# Adding a tool to ProperChats (the 10-minute recipe)

This is the marketplace recipe from [TOOL_MARKETPLACE.md](TOOL_MARKETPLACE.md)
(phases M1+M2): you contribute a tool by PR-ing **one binding file + one
registry entry + tests**. The bridge route, dispatch, rate limiting, discovery
endpoint, and chat-loop attachment already exist and are generic — you don't
touch them.

Since phase **M2**, registering a manifest makes your tool **model-callable
for free**: `manifestToToolDefs()` (`src/lib/tools/defs.ts`) turns every
registered webhook manifest into chat-loop tool definitions named
`<toolId>__<fn>`, attached on direct chat turns across all three providers.
The assistant calls your binding through the *same* `invokeTool` seam as
`POST /api/tools/<id>` — which also meters every invocation
(`tool_calls_total{tool,fn,pricing,key_alias}`) for you. Two consequences:

- **Your tool must tolerate being absent.** When a BYOK secret isn't
  configured on the server, the binding is *stripped* from the model's tool
  list for that request (union degradation) — your manifest `description`
  must never promise the model another specific tool exists.
- **Bindings never embed analytics.** Usage metering (cost plane) and product
  events come from the platform seams; a binding that phones home fails
  review.

Working examples to copy from: `weather` (hosted HTTP service, keyless),
`calculator` (embedded npm library), `finance` (npm library wrapping a public
API). All in `src/lib/tools/bindings/`.

## 0. What qualifies

- **Keyless or BYOK**: the binding must work with no secret, or with secrets
  resolved from env var **names** declared in the manifest (`auth.secrets`).
  Never hardcode or log a secret.
- **License-compatible**: if you wrap an open-source project or library,
  fill the manifest's `upstream` block (project, repo, license, author) and
  honor its license.
- **Agent-sized output**: trim upstream responses to what a model turn needs
  (see `weather.ts` — it cuts wttr.in's JSON to ~20 fields). No multi-MB blobs.
- **Binary output (audio/images/files)**: never put bytes in the model-visible
  result. Park the heavy payload (e.g. a `data:` URL) under the reserved
  `UI_PAYLOAD_KEY` (`"_ui"`, exported from `../manifest`): `runToolDef` strips
  it before the model loop sees the result, while `POST /api/tools/<id>`
  passes it through to UI callers. The model-visible side carries compact
  metadata only (`elevenlabs.ts` is the template: `{voiceId, characters,
  contentType, bytes, audio: "<omitted: N bytes audio/mpeg>"}`). Cap the
  *input* side too (tts refuses >2,500 chars with instructive copy).

## 1. Write the binding — `src/lib/tools/bindings/<vendor>.ts`

(Name the file after the vendor/product you wrap — `firecrawl.ts` serves the
`web_scrape` tool id, `elevenlabs.ts` serves `tts`. The registry entry, not
the filename, owns the tool id.)

A binding exports one async function per tool function. Shape rules, all
visible in `weather.ts`:

- Validate args first; throw `ToolError(message, status)` from
  `../manifest` for bad input (400) or upstream failure (502).
- **The normalizer owns all user-facing copy.** Every error the model or UI
  can see must be a `ToolError` with *your* message — never re-throw or
  string-interpolate the raw vendor response body (vendor prose changes under
  your feet and may leak internals). See `firecrawl.ts`: a 500 upstream
  becomes `"Firecrawl responded 500"`, full stop.
- Resolve `auth.secrets` env vars *before* the upstream-fetch `try` block —
  otherwise your 503 "not configured" refusal gets re-wrapped as a 502
  (see the comment in `firecrawl.ts`).
- Time-box upstream fetches (`AbortSignal.timeout(...)`, ~15s).
- Allow self-hosting where possible: read the base URL from an env var with
  the public default (`const BASE = process.env.MYTOOL_BASE_URL || "https://…"`).
- Return a small, typed, JSON-serializable result object.

## 2. Register the manifest — `src/lib/tools/registry.ts`

Add one `ToolManifest` object to `TOOL_MANIFESTS` (contract:
`src/lib/tools/manifest.ts`). The fields that matter for a webhook tool:

```ts
{
  id: "<id>",                        // wire token; permanent, never reuse
  display: { label, hint, icon },    // picker entry (lucide icon name)
  description: "…",                  // teaches the AGENT when/how to call it
  binding: {
    kind: "webhook",
    endpoint: "/api/tools/<id>",
    functions: [{ name, description, parameters /* JSON Schema */ }],
  },
  providers: ["anthropic", "openai", "gemini"],
  auth: { requiresSignIn: false, secrets: ["MYTOOL_API_KEY"] /* names only */ },
  policy: { allowance: { free: "unmetered", … }, meterMode: "per-turn" },
  upstream: { project, repo, license, author },   // if wrapping OSS
}
```

Then wire dispatch: add your `<id> → binding function` arm to `invokeTool`
in the same file (follow the existing three).

Write the agent-facing `description` and per-function `description`s
carefully — they are the system-prompt text that decides whether the model
uses your tool well. Say *when* to call it, not just what it does.

## 3. Prove it — `tests/tools-registry.spec.ts` + shape tests

Add the bridge specs, mirroring the existing ones:

1. **Discovery**: `GET /api/tools/<id>` returns your manifest, secret-free.
2. **Dispatch**: `POST /api/tools/<id>` with `{ function, args }` returns a
   real result (live call if keyless; skip-if-unconfigured when a key is
   needed: `test.skip(!process.env.MYTOOL_API_KEY, …)`).

And — required since M2 — **shape tests** against *recorded* vendor
responses (`tests/tool-defs.spec.ts` is the template):

3. **Shape**: stub `globalThis.fetch` with the vendor's recorded response
   JSON and drive the FULL model-tool path —
   `manifestToToolDefs()` → `runToolDef("<id>__<fn>", args)` → typed result.
   A live key being dead (quota, revoked) must never be able to mask an
   endpoint/protocol mismatch in your binding.
4. **Strip (BYOK only)**: with your secret env var deleted, prove your
   functions are absent from `manifestToToolDefs()` and that a forced
   dispatch returns normalized `{ error }` data instead of throwing.

Put your tests in a standalone per-tool spec (`tests/<vendor>-<id>.spec.ts`,
e.g. `tests/elevenlabs-tts.spec.ts`) rather than editing the shared spec
files — it avoids contributor merge conflicts; the shared specs cover the
platform seams, yours covers your binding.

Run: `npx playwright test tests/<your-spec>.spec.ts tests/tool-defs.spec.ts`.
CI runs the same specs on your PR. (If your PR *deletes* files, run
typecheck from a clean build dir — `rm -rf .next && npx tsc --noEmit` —
stale `.next/types` validators produce phantom errors.)

## 4. PR checklist

- [ ] One binding file, one registry entry (+ `invokeTool` arm), tests pass —
      including a shape test on recorded vendor responses (and a strip test
      if BYOK).
- [ ] `npx tsc --noEmit` clean.
- [ ] No secrets in code, logs, or test fixtures; env var names only.
- [ ] All error copy is yours (`ToolError`), no raw vendor prose; no
      analytics/telemetry SDKs in the binding.
- [ ] `upstream` attribution filled **if** you wrap an OSS project — omit it
      for plain vendor-API bindings (and be a good citizen:
      tell the upstream author — see the notes in
      [TOOL-OPENSOURCE-properchats.md](TOOL-OPENSOURCE-properchats.md)).
- [ ] Manifest `description` reviewed as prompt text, not just docs.
- [ ] `npm run gen:tools` run so TOOLS.md reflects your entry.
- [ ] Vendor pricing details (free tier, unit prices) go in `display.hint` —
      the manifest's `pricing` field is the coarse class (`keyless`/`byok`/…)
      until a structured pricing-details field lands.

That's the whole surface. Merging the PR makes your tool BOTH a webhook
capability (`POST /api/tools/<id>`) and directly callable by the assistant in
the chat loop — no further work from you.
