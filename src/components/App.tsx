"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { useStore } from "@/lib/store";
import { ChatPane } from "./ChatPane";
import { SelectionBranch } from "./SelectionBranch";
import { Sidebar } from "./Sidebar";
import { SettingsModal } from "./SettingsModal";
import { ThreadPanel } from "./ThreadPanel";

function LoadingShell() {
  return (
    <div className="grid h-dvh place-items-center bg-bg">
      <div className="flex items-center gap-2 text-faint">
        <span className="h-2 w-2 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-current" />
      </div>
    </div>
  );
}

export function App() {
  const hydrated = useStore((s) => s.hydrated);
  const activeChatId = useStore((s) => s.activeChatId);
  const lineSpacing = useStore((s) => s.settings.lineSpacing);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Hydrate from localStorage and ensure a chat exists, once on mount.
  useEffect(() => {
    void useStore.getState().bootstrap();
  }, []);

  // Drive message line spacing from settings. Both assistant prose and user
  // bubbles read --prose-leading, so this single var retunes the whole chat.
  useEffect(() => {
    document.documentElement.style.setProperty("--prose-leading", String(lineSpacing));
  }, [lineSpacing]);

  if (!hydrated || !activeChatId) return <LoadingShell />;

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-ink">
      {/* Sidebar - static on desktop, drawer on mobile */}
      <div
        className={cn(
          "z-40 h-full shrink-0 md:static md:block",
          sidebarOpen ? "fixed inset-y-0 left-0 block" : "hidden md:block",
        )}
      >
        <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      </div>
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
        />
      )}

      {/* Chat area + thread panel */}
      <div className="relative flex min-w-0 flex-1">
        <ChatPane chatId={activeChatId} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        <ThreadPanel />
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <SelectionBranch />
    </div>
  );
}
