# Adding a tool to ProperChats (the 10-minute recipe)

This is marketplace phase **M1** from [TOOL_MARKETPLACE.md](TOOL_MARKETPLACE.md):
you contribute a tool by PR-ing **one binding file + one registry entry + one
test**. The bridge route, dispatch, rate limiting, and discovery endpoint
already exist and are generic — you don't touch them.

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

## 1. Write the binding — `src/lib/tools/bindings/<id>.ts`

A binding exports one async function per tool function. Shape rules, all
visible in `weather.ts`:

- Validate args first; throw `ToolError(message, status)` from
  `../manifest` for bad input (400) or upstream failure (502).
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

## 3. Prove it — `tests/tools-registry.spec.ts`

Add two specs, mirroring the existing ones:

1. **Discovery**: `GET /api/tools/<id>` returns your manifest, secret-free.
2. **Dispatch**: `POST /api/tools/<id>` with `{ function, args }` returns a
   real result (live call if keyless; skip-if-unconfigured when a key is
   needed: `test.skip(!process.env.MYTOOL_API_KEY, …)`).

Run: `npx playwright test tests/tools-registry.spec.ts`. CI runs the same
spec on your PR.

## 4. PR checklist

- [ ] One binding file, one registry entry (+ `invokeTool` arm), tests pass.
- [ ] `npx tsc --noEmit` clean.
- [ ] No secrets in code, logs, or test fixtures; env var names only.
- [ ] `upstream` attribution filled for wrapped OSS (and be a good citizen:
      tell the upstream author — see the notes in
      [TOOL-OPENSOURCE-properchats.md](TOOL-OPENSOURCE-properchats.md)).
- [ ] Manifest `description` reviewed as prompt text, not just docs.

That's the whole surface. When phase **M2** lands (manifests auto-attached as
model tools in the chat loop), tools added this way become directly callable
by the assistant with no further work from you.
