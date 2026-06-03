"use client";

import { BarChart3, Eye, EyeOff, KeyRound, SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS } from "@/lib/constants";
import { useDismiss } from "@/lib/hooks";
import { MODELS_BY_PROVIDER, modelLabelFor, PROVIDERS } from "@/lib/models";
import { LINE_SPACING_MAX, LINE_SPACING_MIN, useStore } from "@/lib/store";
import { computeUsage } from "@/lib/usageStats";
import type { ApiKeys, ServerConfig } from "@/lib/types";

function statusFor(
  k: keyof ApiKeys,
  keys: ApiKeys,
  cfg: ServerConfig | null,
): { label: string; tone: "ok" | "server" | "off" } {
  if (keys[k]?.trim()) {
    return k === "interpret"
      ? { label: "Using your key", tone: "ok" }
      : { label: "This browser only", tone: "server" };
  }
  if (cfg?.[k]) return { label: "Server key active", tone: "server" };
  return { label: "Not configured", tone: "off" };
}

function KeyField({
  id,
  label,
  hint,
  value,
  status,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  status: { label: string; tone: "ok" | "server" | "off" };
  onChange: (v: string) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label htmlFor={id} className="text-[13px] font-medium text-ink">
          {label}
        </label>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            status.tone === "ok" && "bg-accent-soft text-accent",
            status.tone === "server" && "bg-surface-3 text-muted",
            status.tone === "off" && "bg-surface-3 text-faint",
          )}
        >
          {status.label}
        </span>
      </div>
      <div className="relative">
        <input
          id={id}
          data-testid={id}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={hint}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 pr-10 text-[13px] text-ink outline-none transition focus:border-faint"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-faint hover:text-ink"
          aria-label={show ? "Hide" : "Show"}
        >
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <p className="mt-0.5 text-[12px] text-muted">{hint}</p>
      </div>
      <button
        id={id}
        data-testid={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition",
          checked ? "bg-accent" : "bg-surface-3",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition",
            checked && "translate-x-5",
          )}
        />
      </button>
    </div>
  );
}

type Tab = "general" | "api" | "usage";
const TABS: { id: Tab; label: string; Icon: typeof SlidersHorizontal }[] = [
  { id: "general", label: "General", Icon: SlidersHorizontal },
  { id: "api", label: "API", Icon: KeyRound },
  { id: "usage", label: "Usage", Icon: BarChart3 },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const ref = useDismiss<HTMLDivElement>(true, onClose);
  const keys = useStore((s) => s.settings.keys);
  const settings = useStore((s) => s.settings);
  const cfg = useStore((s) => s.serverConfig);
  const setKeys = useStore((s) => s.setKeys);
  const updateSettings = useStore((s) => s.updateSettings);
  const nodes = useStore((s) => s.nodes);
  const usage = computeUsage(nodes);
  const [tab, setTab] = useState<Tab>("general");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div
        ref={ref}
        data-testid="settings-modal"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[16px] font-semibold text-ink">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            data-testid="settings-close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink"
            aria-label="Close settings"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="w-40 shrink-0 overflow-y-auto border-r border-line p-2">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                data-testid={`settings-tab-${t.id}`}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition",
                  tab === t.id
                    ? "bg-surface-3 text-ink"
                    : "text-muted hover:bg-surface-3/60 hover:text-ink",
                )}
              >
                <t.Icon size={15} />
                {t.label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain scrollbar-thin px-5 py-5">
            {tab === "general" && (
              <>
                <div>
                  <label htmlFor="default-model" className="mb-1.5 block text-[13px] font-medium text-ink">
                    Default model for new chats
                  </label>
                  <select
                    id="default-model"
                    data-testid="default-model"
                    value={settings.defaultModelId}
                    onChange={(e) => updateSettings({ defaultModelId: e.target.value })}
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-faint"
                  >
                    {MODELS_BY_PROVIDER.map(({ provider, models }) => (
                      <optgroup key={provider} label={PROVIDERS[provider].label}>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {modelLabelFor(m, keys, cfg)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="system-prompt" className="mb-1.5 block text-[13px] font-medium text-ink">
                    System prompt
                  </label>
                  <textarea
                    id="system-prompt"
                    data-testid="system-prompt"
                    value={settings.systemPrompt}
                    onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
                    rows={3}
                    placeholder="Optional. Applied to every model, on top of compaction summaries."
                    className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none scrollbar-thin focus:border-faint"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="temperature" className="mb-1.5 block text-[13px] font-medium text-ink">
                      Temperature: {settings.temperature.toFixed(1)}
                    </label>
                    <input
                      id="temperature"
                      type="range"
                      min={0}
                      max={1}
                      step={0.1}
                      value={settings.temperature}
                      onChange={(e) => updateSettings({ temperature: Number(e.target.value) })}
                      className="w-full accent-accent"
                    />
                  </div>
                  <div>
                    <label htmlFor="max-tokens" className="mb-1.5 block text-[13px] font-medium text-ink">
                      Max tokens
                    </label>
                    <input
                      id="max-tokens"
                      type="number"
                      min={MIN_OUTPUT_TOKENS}
                      max={MAX_OUTPUT_TOKENS}
                      step={256}
                      value={settings.maxTokens}
                      onChange={(e) =>
                        updateSettings({
                          maxTokens: Math.max(
                            MIN_OUTPUT_TOKENS,
                            Number(e.target.value) || DEFAULT_OUTPUT_TOKENS,
                          ),
                        })
                      }
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-faint"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="line-spacing" className="mb-1.5 block text-[13px] font-medium text-ink">
                    Line spacing: {settings.lineSpacing.toFixed(2)}
                  </label>
                  <input
                    id="line-spacing"
                    data-testid="line-spacing"
                    type="range"
                    min={LINE_SPACING_MIN}
                    max={LINE_SPACING_MAX}
                    step={0.05}
                    value={settings.lineSpacing}
                    onChange={(e) => updateSettings({ lineSpacing: Number(e.target.value) })}
                    className="w-full accent-accent"
                  />
                  <p className="mt-1 text-[12px] text-muted">
                    Vertical spacing between lines in messages. Lower is more compact.
                  </p>
                </div>
                <div className="space-y-4 border-t border-line pt-4">
                  <Toggle
                    id="toggle-autocompact"
                    label="Auto-compact long conversations"
                    hint="When a chat nears the model's context window, older messages are summarized automatically so it keeps flowing."
                    checked={settings.autoCompact}
                    onChange={(v) => updateSettings({ autoCompact: v })}
                  />
                  <Toggle
                    id="toggle-nerdtools"
                    label="Nerd tools"
                    hint="Show power-user controls like the manual Compact button and conversation internals."
                    checked={settings.nerdTools}
                    onChange={(v) => updateSettings({ nerdTools: v })}
                  />
                </div>
              </>
            )}

            {tab === "api" && (
              <>
                <p className="text-[12px] text-muted">
                  The interpret backend is the default. Add a provider key to use Claude, ChatGPT,
                  or Gemini. Keys live only in this browser and are sent to the server proxy with
                  each request.
                </p>

                <KeyField
                  id="key-interpret"
                  label="InterpretAI API key"
                  hint="iai_…"
                  value={keys.interpret ?? ""}
                  status={statusFor("interpret", keys, cfg)}
                  onChange={(v) => setKeys({ interpret: v })}
                />
                <KeyField
                  id="key-anthropic"
                  label={`${PROVIDERS.anthropic.label}`}
                  hint="sk-ant-…"
                  value={keys.anthropic ?? ""}
                  status={statusFor("anthropic", keys, cfg)}
                  onChange={(v) => setKeys({ anthropic: v })}
                />
                <KeyField
                  id="key-openai"
                  label={`${PROVIDERS.openai.label}`}
                  hint="sk-…"
                  value={keys.openai ?? ""}
                  status={statusFor("openai", keys, cfg)}
                  onChange={(v) => setKeys({ openai: v })}
                />
                <KeyField
                  id="key-gemini"
                  label={`${PROVIDERS.gemini.label}`}
                  hint="AIza…"
                  value={keys.gemini ?? ""}
                  status={statusFor("gemini", keys, cfg)}
                  onChange={(v) => setKeys({ gemini: v })}
                />

                <div className="rounded-lg border border-line bg-surface-2/50 p-3 text-[12px] leading-relaxed text-muted">
                  Need a key? Mint a free InterpretAI key at{" "}
                  <a
                    href="https://www.properchats.ai"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-accent hover:underline"
                  >
                    properchats.ai
                  </a>
                  , or paste your own provider key above.
                </div>
              </>
            )}

            {tab === "usage" && (
              <div className="space-y-3" data-testid="usage-section">
                <p className="text-[12px] text-muted">
                  Model calls made from this browser this month ({usage.period}). Counted locally;
                  nothing is reported to a server.
                </p>
                <div className="text-[13px] font-medium text-ink">{usage.total} calls</div>
                <div className="rounded-lg border border-line bg-surface-2/50 p-3" data-testid="usage-breakdown">
                  <div className="mb-2 text-[12px] font-semibold text-ink">By model</div>
                  {usage.byModel.length === 0 ? (
                    <p className="text-[12px] text-faint">No messages yet this month.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {usage.byModel.map((m) => (
                        <li
                          key={m.modelId}
                          className="flex items-center justify-between gap-2 text-[12px] text-muted"
                        >
                          <span className="min-w-0 truncate">{m.label}</span>
                          <span className="shrink-0 tabular-nums text-faint">{m.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
