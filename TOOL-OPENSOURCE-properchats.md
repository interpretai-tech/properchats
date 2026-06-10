# Open-source tools enabled in ProperChats

Three open-source, keyless, individually-authored tools are now enabled in
this repo through the tool-manifest contract from
[docs/PUBLIC_TOOL_ECOSYSTEM.md](docs/PUBLIC_TOOL_ECOSYSTEM.md). Each is
registered in the typed manifest registry and callable end-to-end through the
webhook bridge route:

```
GET  /api/tools/<id>   → the tool's manifest (discovery, secret-free)
POST /api/tools/<id>   → { "function": "<fn>", "args": { ... } }
```

Shared wiring (new in this change):

| File | Role |
|---|---|
| `src/lib/tools/manifest.ts` | The `ToolManifest` contract from the design doc, as code (+ `ToolError`) |
| `src/lib/tools/registry.ts` | `TOOL_MANIFESTS` array, lookup helpers, and the `invokeTool` dispatch seam |
| `src/app/api/tools/[tool]/route.ts` | The webhook bridge route (rate-limited, keyless) |
| `tests/tools-registry.spec.ts` | End-to-end proof: discovery, dispatch, and real live calls (all passing) |

None of the upstream code is vendored — `mathjs` and `yahoo-finance2` are
plain npm dependencies (declared in `package.json`); wttr.in is consumed as a
hosted HTTP service. Licenses are honored via dependency metadata and the
attribution below; each manifest also carries an `upstream` block crediting
the project, repo, license, and author in code.

---

## 1. wttr.in — Weather (`weather`)

- **Repo:** https://github.com/chubin/wttr.in
- **License:** Apache-2.0
- **What it does:** Open-source, keyless weather service. `GET
  https://wttr.in/<location>?format=j1` returns JSON current conditions and a
  3-day forecast for any city, airport code, or lat,lng.
- **What was enabled:** `src/lib/tools/bindings/weather.ts` — a `get_weather`
  bridge function that calls the public wttr.in JSON endpoint (override with
  `WTTR_BASE_URL` to self-host) and trims the response to agent-friendly
  current conditions + 3-day forecast. Registered as the `weather` manifest in
  `src/lib/tools/registry.ts`; live-call test in `tests/tools-registry.spec.ts`
  passes against the real service.
- **Author:** Igor Chubin
- **Email:** `igor@chub.in` — publicly listed as his git commit author
  identity on the wttr.in repository itself (every commit by @chubin), and
  long published on his projects.
- **Ready-to-send note:**

  > Hi Igor — I run ProperChats, an open-source threaded chat app
  > (https://github.com/interpretai-tech/properchats), and I just enabled
  > wttr.in as the app's built-in weather tool: the assistant now answers
  > weather questions with live conditions and forecasts from your service
  > instead of guessing. Thank you for keeping such a genuinely useful service
  > open and keyless all these years — and if you'd ever like attribution
  > handled differently (or want us to point at a self-hosted instance by
  > default), just say the word.

## 2. mathjs — Calculator (`calculator`)

- **Repo:** https://github.com/josdejong/mathjs
- **License:** Apache-2.0
- **What it does:** Extensive math library with a parser designed for safely
  evaluating untrusted expressions: arithmetic, unit conversion
  ("12.5 cm to inch"), big numbers, matrices, statistics.
- **What was enabled:** `src/lib/tools/bindings/calculator.ts` — a `calculate`
  bridge function that evaluates expressions in-process with mathjs, following
  the project's security guidance (capture `evaluate`, then disable `import`,
  `createUnit`, `parse`, `evaluate`, `simplify`, `derivative`, `resolve`,
  `reviver`). Registered as the `calculator` manifest; deterministic tests
  (including the security lockdown) pass.
- **Author:** Jos de Jong
- **Email:** `wjosdejong@gmail.com` — published in the `author` field of the
  mathjs `package.json` on the npm registry (verified against
  `https://registry.npmjs.org/mathjs/latest`, v15.2.0).
- **Ready-to-send note:**

  > Hi Jos — I just enabled mathjs as the built-in calculator tool in
  > ProperChats, an open-source threaded chat app
  > (https://github.com/interpretai-tech/properchats). The assistant now hands
  > every numeric question to math.evaluate (locked down per your security
  > docs) instead of doing LLM arithmetic, which makes a real difference in
  > answer quality. Thanks for a decade-plus of maintaining such a dependable
  > library — happy to adjust attribution however you'd like.

## 3. yahoo-finance2 — Stocks (`stock_quote`)

- **Repo:** https://github.com/gadicc/yahoo-finance2
- **License:** MIT
- **What it does:** Unofficial TypeScript Yahoo Finance client: live quotes,
  search, historical/chart data for stocks, indices, FX, and crypto. No API
  key.
- **What was enabled:** `src/lib/tools/bindings/finance.ts` — a `stock_quote`
  bridge function wrapping `YahooFinance#quote`, returning price, change, day
  range, market cap, market state, and exchange for a ticker. Registered as
  the `stock_quote` manifest; live-call test passes (AAPL quote in USD).
  Note: v3 recommends Node >= 22 (runs on 20 with an advisory).
- **Author:** Gadi Cohen
- **Email:** `dragon@wastelands.net` — published in the `author` field of the
  yahoo-finance2 `package.json` on the npm registry (verified against
  `https://registry.npmjs.org/yahoo-finance2/latest`, v3.15.2).
- **Ready-to-send note:**

  > Hi Gadi — I just enabled yahoo-finance2 as the live market-quote tool in
  > ProperChats, an open-source threaded chat app
  > (https://github.com/interpretai-tech/properchats). When users ask about a
  > stock, index, FX pair, or crypto price, the assistant now calls your
  > client instead of quoting stale numbers from memory. Thanks for keeping
  > the library so well maintained and typed — if there's anything you'd like
  > changed about how we credit or use it, I'm all ears.

---

## How a tool is "enabled" here

Per the manifest lifecycle (register → discover → invoke → render → meter) in
`docs/PUBLIC_TOOL_ECOSYSTEM.md`:

- **Register / discover / invoke are real today:** each manifest lives in
  `TOOL_MANIFESTS`, is served at `GET /api/tools/<id>`, and its functions
  execute server-side via `POST /api/tools/<id>` → `invokeTool` → binding.
  All three tools are keyless (`auth.secrets` empty) and unmetered.
- **Deferred (tracked in the doc):** deriving `Capability` union members,
  `CAPABILITIES` picker entries, and policy/gate rows from manifests, and
  teaching the agent loop to call the bridge mid-turn. The registry was built
  so that derivation step is purely mechanical.
