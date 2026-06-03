"use client";

import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { useDismiss } from "@/lib/hooks";
import { cn } from "@/lib/cn";
import {
  chooseRoute,
  getModel,
  MODELS_BY_PROVIDER,
  modelLabel,
  PROVIDERS,
  SIZE_LABEL,
  type ModelDef,
} from "@/lib/models";
import { useStore } from "@/lib/store";
import type { ApiKeys, Route, ServerConfig } from "@/lib/types";
import { ProviderDot } from "./ProviderDot";

function routeBadge(model: ModelDef, route: Route, keys: ApiKeys): string {
  if (route === "interpret") return "Interpret";
  return keys[model.provider] ? "Your key" : "Direct";
}

function isUsable(
  model: ModelDef,
  route: Route,
  keys: ApiKeys,
  cfg: ServerConfig | null,
): boolean {
  if (route === "interpret") return Boolean(cfg?.interpret || keys.interpret);
  return Boolean(keys[model.provider] || cfg?.[model.provider]);
}

export function ModelPicker({
  nodeId,
  up = false,
  restrictTo,
}: {
  nodeId: string;
  up?: boolean;
  /** When set, only these model ids are selectable (others are greyed out). */
  restrictTo?: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const node = useStore((s) => s.nodes[nodeId]);
  const keys = useStore((s) => s.settings.keys);
  const cfg = useStore((s) => s.serverConfig);
  const setNodeModel = useStore((s) => s.setNodeModel);

  if (!node) return null;
  const current = getModel(node.currentModelId);
  const currentRoute = chooseRoute(current.provider, keys, cfg);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        data-testid="model-picker"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-muted transition hover:bg-surface-3 hover:text-ink"
      >
        <ProviderDot provider={current.provider} size="md" />
        <span className="max-w-[180px] truncate">{modelLabel(current, currentRoute)}</span>
        <ChevronDown size={14} className="opacity-60" />
      </button>

      {open && (
        <div
          role="listbox"
          className={cn(
            "absolute z-40 w-[290px] overflow-hidden rounded-xl border border-line bg-surface shadow-xl",
            up ? "bottom-full mb-3" : "top-full mt-2",
            "left-0",
          )}
        >
          <div className="max-h-[min(22rem,60vh)] overflow-y-auto overscroll-contain scrollbar-thin py-1">
            {MODELS_BY_PROVIDER.map(({ provider, models }) => (
              <div key={provider} className="py-1">
                <div className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
                  <ProviderDot provider={provider} size="md" />
                  {PROVIDERS[provider].label}
                </div>
                {models.map((m) => {
                  const route = chooseRoute(m.provider, keys, cfg);
                  const usable = isUsable(m, route, keys, cfg);
                  const selected = m.id === node.currentModelId;
                  const blocked = restrictTo ? !restrictTo.has(m.id) : false;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-disabled={blocked}
                      disabled={blocked}
                      data-testid={`model-option-${m.id}`}
                      onClick={() => {
                        if (blocked) return;
                        setNodeModel(nodeId, m.id);
                        setOpen(false);
                      }}
                      title={blocked ? "Cannot read the attached file type" : undefined}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] transition hover:bg-surface-2",
                        selected && "bg-surface-2",
                        blocked && "cursor-not-allowed opacity-40 hover:bg-transparent",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="w-3.5 shrink-0">
                          {selected && <Check size={14} className="text-accent" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-ink">{modelLabel(m, route)}</span>
                          <span className="block text-[11px] text-faint">
                            {SIZE_LABEL[m.size]}
                          </span>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          title={usable ? "Ready" : "No key configured"}
                          style={{ background: usable ? "#3fae6e" : "#d9a441" }}
                        />
                        <span className="text-[10px] uppercase tracking-wide text-faint">
                          {routeBadge(m, route, keys)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
