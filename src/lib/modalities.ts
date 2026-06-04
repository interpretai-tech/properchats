import { getModel, MODELS, type ModelDef, PROVIDER_ORDER, PROVIDERS } from "./models";
import type { Modality, Provider } from "./types";

export type { Modality };

/**
 * INPUT modalities and which models can accept them. This is distinct from
 * capabilities.ts (which is about provider-native OUTPUT tools like web search
 * and image generation). Here we answer: "the user attached a video, which
 * models can actually read it?" so the composer can auto-detect an upload's type
 * and restrict the model picker accordingly.
 *
 * Grounding (input understanding, verified against current provider docs):
 * - Gemini: text, image, audio, video, pdf (native multimodal).
 * - Claude: text, image, pdf (all active models read PDFs). No video, no audio.
 * - OpenAI: text, image, pdf (gpt-4o and later are vision-capable and accept
 *   PDF file inputs via chat/completions `file` parts). No video/audio.
 *
 * NOTE: pdf/video/audio cannot travel through the interpret route today (its
 * ChatTurn only carries text + image_urls), so those uploads must go DIRECT to a
 * provider that supports them. PDFs are sent as native document blocks; see
 * server/providers.ts.
 */
const PROVIDER_INPUTS: Record<Provider, Modality[]> = {
  gemini: ["text", "image", "audio", "video", "pdf"],
  anthropic: ["text", "image", "pdf"],
  openai: ["text", "image", "pdf"],
};

const EXT_MODALITY: Record<string, Modality> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", heic: "image", bmp: "image", svg: "image",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video", m4v: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", ogg: "audio", flac: "audio",
  pdf: "pdf",
};

/** Detect the input modality of an uploaded file from its MIME type, then extension. */
export function detectModality(file: { type?: string | null; name?: string | null }): Modality {
  const mime = (file.type ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  const ext = (file.name ?? "").toLowerCase().split(".").pop() ?? "";
  return EXT_MODALITY[ext] ?? "text";
}

/** Input modalities a catalog model can accept. */
export function modelInputModalities(modelId: string): Modality[] {
  return PROVIDER_INPUTS[getModel(modelId).provider] ?? ["text"];
}

export function modelSupportsModality(modelId: string, modality: Modality): boolean {
  return modelInputModalities(modelId).includes(modality);
}

/** True if a provider can accept the given input modality (provider-level check). */
export function providerSupportsModality(provider: Provider, modality: Modality): boolean {
  return (PROVIDER_INPUTS[provider] ?? ["text"]).includes(modality);
}

/** Catalog models that can accept the given input modality. */
export function modelsForModality(modality: Modality): ModelDef[] {
  return MODELS.filter((m) => (PROVIDER_INPUTS[m.provider] ?? ["text"]).includes(modality));
}

/** Distinct modalities required to handle a set of attachments. */
export function requiredModalities(files: { type?: string | null; name?: string | null }[]): Modality[] {
  const set = new Set<Modality>();
  for (const f of files) set.add(detectModality(f));
  return [...set];
}

/** True if a model can read every modality in the set. */
export function modelHandlesModalities(modelId: string, mods: Modality[]): boolean {
  const supported = modelInputModalities(modelId);
  return mods.every((m) => supported.includes(m));
}

/** Catalog model ids that can handle ALL the given modalities (intersection). */
export function allowedModelsForModalities(mods: Modality[]): string[] {
  if (!mods.length) return MODELS.map((m) => m.id);
  return MODELS.filter((m) => modelHandlesModalities(m.id, mods)).map((m) => m.id);
}

/**
 * Human explanation when a set of modalities narrows the model choice, e.g.
 * "video can be read by Gemini models." Returns null when nothing is restricted.
 */
export function restrictionForModalities(mods: Modality[]): string | null {
  const nonText = mods.filter((m) => m !== "text");
  if (!nonText.length) return null;
  const providersFor = (m: Modality) =>
    PROVIDER_ORDER.filter((p) => PROVIDER_INPUTS[p].includes(m));
  const parts = nonText.map((m) => {
    const provs = providersFor(m).map((p) => PROVIDERS[p].label).join(", ") || "no available";
    return `${m} can be read by ${provs} models`;
  });
  return `${parts.join("; ")}.`;
}

/** File-shaped wrappers (detect modality first), for the composer's raw uploads. */
export function modelHandlesFiles(
  modelId: string,
  files: { type?: string | null; name?: string | null }[],
): boolean {
  return modelHandlesModalities(modelId, requiredModalities(files));
}

export function allowedModelsForFiles(files: { type?: string | null; name?: string | null }[]): string[] {
  return allowedModelsForModalities(requiredModalities(files));
}

export function restrictionReason(files: { type?: string | null; name?: string | null }[]): string | null {
  return restrictionForModalities(requiredModalities(files));
}
