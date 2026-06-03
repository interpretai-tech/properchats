"use client";

import { ArrowUp, FileText, Film, Loader2, Music, Paperclip, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { capabilityAvailable } from "@/lib/capabilities";
import { cn } from "@/lib/cn";
import { uploadFile } from "@/lib/media";
import {
  allowedModelsForModalities,
  modelHandlesModalities,
  restrictionForModalities,
} from "@/lib/modalities";
import { getModel, MODELS } from "@/lib/models";
import { useStore } from "@/lib/store";
import type { Capability, MediaAttachment } from "@/lib/types";
import { CapabilityPicker } from "./CapabilityPicker";
import { ModelPicker } from "./ModelPicker";

export function Composer({
  nodeId,
  placeholder = "Message ProperChat…",
  autoFocus = false,
  testId,
}: {
  nodeId: string;
  placeholder?: string;
  autoFocus?: boolean;
  testId?: string;
}) {
  const [text, setText] = useState("");
  const [capability, setCapability] = useState<Capability>("chat");
  const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sendMessage = useStore((s) => s.sendMessage);
  const stopStream = useStore((s) => s.stopStream);
  const setNodeModel = useStore((s) => s.setNodeModel);
  const isStreaming = useStore((s) => Boolean(s.streamingNodeIds[nodeId]));
  const currentModelId = useStore((s) => s.nodes[nodeId]?.currentModelId);
  const keys = useStore((s) => s.settings.keys);
  const cfg = useStore((s) => s.serverConfig);

  const avail = {
    anthropic: Boolean(keys.anthropic || cfg?.anthropic),
    openai: Boolean(keys.openai || cfg?.openai),
    gemini: Boolean(keys.gemini || cfg?.gemini),
  };
  const effectiveCapability: Capability = capabilityAvailable(capability, avail) ? capability : "chat";

  // Restrict the picker to models that can read the attached media; auto-switch
  // when the current model can't (e.g. attach a video -> jump to Gemini).
  const mods = attachments.map((a) => a.modality);
  const restrictIds = attachments.length ? new Set(allowedModelsForModalities(mods)) : null;
  const restriction = attachments.length ? restrictionForModalities(mods) : null;

  useEffect(() => {
    if (!attachments.length || !currentModelId) return;
    const need = attachments.map((a) => a.modality);
    if (modelHandlesModalities(currentModelId, need)) return;
    const allowed = allowedModelsForModalities(need);
    if (!allowed.length) return;
    const cur = getModel(currentModelId);
    const pick = MODELS.find((m) => allowed.includes(m.id) && m.size === cur.size) ?? getModel(allowed[0]);
    setNodeModel(nodeId, pick.id);
  }, [attachments, currentModelId, nodeId, setNodeModel]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus, nodeId]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading((n) => n + list.length);
    await Promise.all(
      list.map(async (file) => {
        try {
          const desc = await uploadFile(file);
          setAttachments((prev) => [...prev, desc]);
        } catch {
          /* skip a file that failed to read/upload */
        } finally {
          setUploading((n) => Math.max(0, n - 1));
        }
      }),
    );
  };

  const removeAttachment = (i: number) =>
    setAttachments((prev) => prev.filter((_, idx) => idx !== i));

  const submit = () => {
    const value = text.trim();
    if ((!value && !attachments.length) || isStreaming || uploading > 0) return;
    const media = attachments;
    setText("");
    setAttachments([]);
    void sendMessage(nodeId, value, effectiveCapability, media);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const canSend = (text.trim().length > 0 || attachments.length > 0) && uploading === 0;

  return (
    <div data-testid={testId} className="mx-auto w-full max-w-chat px-4 pb-4 md:px-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "rounded-[24px] border border-line bg-surface shadow-sm transition focus-within:border-faint",
          dragOver && "border-accent ring-2 ring-accent/30",
        )}
      >
        {(attachments.length > 0 || uploading > 0) && (
          <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="composer-attachments">
            {attachments.map((a, i) => (
              <div
                key={`${a.sha256}-${i}`}
                className="group/att relative flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-1 pl-1.5 pr-6 text-[12px] text-muted"
              >
                {a.modality === "image" && /^(data:|https?:)/.test(a.uri) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.uri} alt="" className="h-8 w-8 rounded object-cover" />
                ) : a.modality === "video" ? (
                  <Film size={14} className="text-accent" />
                ) : a.modality === "audio" ? (
                  <Music size={14} className="text-accent" />
                ) : a.modality === "pdf" ? (
                  <FileText size={14} className="text-accent" />
                ) : (
                  <Paperclip size={14} className="text-accent" />
                )}
                <span className="max-w-[120px] truncate">{a.modality}</span>
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => removeAttachment(i)}
                  className="absolute right-1 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-faint hover:text-danger"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {uploading > 0 && (
              <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1 text-[12px] text-faint">
                <Loader2 size={13} className="animate-spin" />
                Uploading…
              </div>
            )}
          </div>
        )}

        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          rows={1}
          data-testid="composer-input"
          className="block max-h-[220px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint scrollbar-thin"
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
          <div className="flex min-w-0 items-center gap-1">
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,video/*,audio/*,application/pdf"
              className="hidden"
              data-testid="file-input"
              onChange={(e) => {
                if (e.target.files?.length) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              data-testid="attach-button"
              onClick={() => fileRef.current?.click()}
              title="Attach files"
              aria-label="Attach files"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-ink"
            >
              <Paperclip size={17} />
            </button>
            <CapabilityPicker value={effectiveCapability} onChange={setCapability} up />
            <ModelPicker nodeId={nodeId} up restrictTo={restrictIds ?? undefined} />
          </div>
          {isStreaming ? (
            <button
              type="button"
              onClick={() => stopStream(nodeId)}
              data-testid="stop-button"
              aria-label="Stop"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-bg transition hover:opacity-80"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              data-testid="send-button"
              aria-label="Send"
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full transition",
                canSend
                  ? "bg-accent text-accent-fg hover:opacity-90"
                  : "cursor-not-allowed bg-surface-3 text-faint",
              )}
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      {restriction ? (
        <p className="mt-2 text-center text-[11px] text-faint" data-testid="modality-restriction">
          {restriction}
        </p>
      ) : (
        <p className="mt-2 text-center text-[11px] text-faint">
          Branch any message into a thread · switch models mid-conversation
        </p>
      )}
    </div>
  );
}
