"use client";

import { Moon, Plus, Settings, Sun, Trash2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { useStore } from "@/lib/store";
import { Logo } from "./Logo";

function ChatRow({
  id,
  active,
  onSelect,
}: {
  id: string;
  active: boolean;
  onSelect: () => void;
}) {
  const chat = useStore((s) => s.chats[id]);
  const renameChat = useStore((s) => s.renameChat);
  const deleteChat = useStore((s) => s.deleteChat);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!chat) return null;

  const commit = () => {
    if (draft.trim()) renameChat(id, draft.trim());
    setEditing(false);
  };

  return (
    <div
      data-testid="chat-item"
      onClick={onSelect}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] transition",
        active ? "bg-surface-3 text-ink" : "text-muted hover:bg-surface-3/60 hover:text-ink",
      )}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[13.5px] text-ink outline-none"
        />
      ) : (
        <span
          className="min-w-0 flex-1 truncate"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(chat.title);
            setEditing(true);
          }}
        >
          {chat.title}
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          deleteChat(id);
        }}
        aria-label="Delete chat"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint opacity-0 transition hover:bg-surface hover:text-danger group-hover:opacity-100"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const chatOrder = useStore((s) => s.chatOrder);
  const activeChatId = useStore((s) => s.activeChatId);
  const newChat = useStore((s) => s.newChat);
  const selectChat = useStore((s) => s.selectChat);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);

  return (
    <div className="flex h-full w-[260px] flex-col border-r border-line bg-surface-2">
      <div className="flex items-center gap-2 px-3.5 py-3.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-fg">
          <Logo size={18} />
        </div>
        <span className="text-[15px] font-semibold tracking-tight text-ink">ProperChat</span>
      </div>

      <div className="px-2.5">
        <button
          type="button"
          data-testid="new-chat"
          onClick={() => newChat()}
          className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] font-medium text-ink transition hover:bg-surface-3"
        >
          <Plus size={16} className="text-accent" />
          New chat
        </button>
      </div>

      <nav className="mt-3 flex-1 overflow-y-auto scrollbar-thin px-2.5 pb-2">
        <p className="px-1 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
          Chats
        </p>
        <div className="flex flex-col gap-0.5">
          {chatOrder.map((id) => (
            <ChatRow
              key={id}
              id={id}
              active={id === activeChatId}
              onSelect={() => selectChat(id)}
            />
          ))}
        </div>
      </nav>

      <div className="space-y-1 border-t border-line px-2.5 py-2.5">
        <div className="flex items-center justify-between">
          <button
            type="button"
            data-testid="open-settings"
            onClick={onOpenSettings}
            className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition hover:bg-surface-3 hover:text-ink"
          >
            <Settings size={16} />
            Settings
          </button>
          <button
            type="button"
            data-testid="theme-toggle"
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-ink"
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
