import { createHash } from "node:crypto";
import { projectDocumentCategories, type ProjectDocumentCategory, type ProjectDocumentExtractor } from "./project-document-contract.js";

export { projectDocumentCategories, type ProjectDocumentCategory, type ProjectDocumentExtractor } from "./project-document-contract.js";

export type ProjectDocument = Readonly<{
  id: string;
  category: ProjectDocumentCategory;
  satisfies: readonly ("passport" | "specification")[];
  revision: number;
  status: "active" | "superseded";
  asset: Readonly<{assetId: string; contentPath: string; originalFilename: string; contentType: string; byteSize: number; sha256: string; createdAt: string}>;
  extraction: Readonly<{extractor: ProjectDocumentExtractor; totalCharacters: number; contextCharacters: number; truncated: boolean; contextText: string}>;
  recordedAt: string;
}>;

export type ProjectDocumentContext = Readonly<{
  contract: "fai.project-context.v1";
  version: string;
  documentRevision: number;
  preparedAt: string;
  sourceDocumentIds: readonly string[];
  content: string;
}>;

export type ProjectDocumentState = Readonly<{
  contract: "fai.project-documents.v1";
  revision: number;
  documents: readonly ProjectDocument[];
  context: ProjectDocumentContext | null;
  receipts: Readonly<Record<string, Readonly<{documentId: string; revision: number}>>>;
}>;

const maxNameLength = 200;
const maxContextCharacters = 16_000;
const maxExtractedCharacters = 200_000;
const maxPreparedContextCharacters = 96_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/i;
const contentTypes = new Set(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/markdown", "text/plain"]);
const extensions = new Set(["pdf", "docx", "md", "txt"]);

export function emptyProjectDocumentState(): ProjectDocumentState {
  return {contract: "fai.project-documents.v1", revision: 0, documents: [], context: null, receipts: {}};
}

function isCategory(value: unknown): value is ProjectDocumentCategory {
  return typeof value === "string" && (projectDocumentCategories as readonly string[]).includes(value);
}

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length > maximum || value.includes("\u0000")) return null;
  return value.replace(/\r\n/g, "\n").trim();
}

function validAsset(value: unknown): ProjectDocument["asset"] | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const assetId = typeof raw.assetId === "string" && uuid.test(raw.assetId) ? raw.assetId : null;
  const originalFilename = cleanText(raw.originalFilename, maxNameLength);
  const contentType = typeof raw.contentType === "string" ? raw.contentType.toLowerCase() : "";
  const byteSize = typeof raw.byteSize === "number" && Number.isInteger(raw.byteSize) && raw.byteSize > 0 && raw.byteSize <= 10 * 1024 * 1024 ? raw.byteSize : null;
  const sha256 = typeof raw.sha256 === "string" && hash.test(raw.sha256) ? raw.sha256.toLowerCase() : null;
  const createdAt = typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : null;
  if (!assetId || !originalFilename || !contentTypes.has(contentType) || !byteSize || !sha256 || !createdAt) return null;
  const extension = originalFilename.toLowerCase().split(".").pop() ?? "";
  if (!extensions.has(extension)) return null;
  return {assetId, contentPath: `/api/assets/${assetId}/content`, originalFilename, contentType, byteSize, sha256, createdAt};
}

function validExtraction(value: unknown): ProjectDocument["extraction"] | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const extractor = raw.extractor === "browser-text" || raw.extractor === "browser-docx" || raw.extractor === "browser-pdf" ? raw.extractor : null;
  const totalCharacters = typeof raw.totalCharacters === "number" && Number.isInteger(raw.totalCharacters) && raw.totalCharacters > 0 && raw.totalCharacters <= maxExtractedCharacters ? raw.totalCharacters : null;
  const contextText = cleanText(raw.contextText, maxContextCharacters);
  const contextCharacters = typeof raw.contextCharacters === "number" && Number.isInteger(raw.contextCharacters) && raw.contextCharacters === (contextText?.length ?? -1) ? raw.contextCharacters : null;
  const truncated = typeof raw.truncated === "boolean" ? raw.truncated : null;
  if (!extractor || !totalCharacters || !contextText || contextCharacters === null || truncated === null || contextCharacters > totalCharacters || (truncated === false && contextCharacters !== totalCharacters)) return null;
  return {extractor, totalCharacters, contextCharacters, truncated, contextText};
}

function validSatisfies(category: ProjectDocumentCategory, value: unknown): readonly ("passport" | "specification")[] | null {
  if (!Array.isArray(value) || value.length > 2 || value.some((entry) => entry !== "passport" && entry !== "specification")) return null;
  if ((category === "architecture" || category === "other") && value.length === 0) return [];
  if (value.length < 1) return null;
  const satisfies = [...new Set(value)] as ("passport" | "specification")[];
  if (satisfies.length !== value.length || (category !== "passport" && category !== "specification") || !satisfies.includes(category)) return null;
  return satisfies;
}

export function parseProjectDocumentState(value: unknown): ProjectDocumentState {
  if (!value || typeof value !== "object") return emptyProjectDocumentState();
  const raw = value as Record<string, unknown>;
  if (raw.contract !== "fai.project-documents.v1" || !Number.isInteger(raw.revision) || (raw.revision as number) < 0 || !Array.isArray(raw.documents)) return emptyProjectDocumentState();
  const documents: ProjectDocument[] = [];
  for (const value of raw.documents) {
    if (!value || typeof value !== "object") continue;
    const document = value as Record<string, unknown>;
    const category = isCategory(document.category) ? document.category : null;
    const asset = validAsset(document.asset); const extraction = validExtraction(document.extraction);
    const id = typeof document.id === "string" && uuid.test(document.id) ? document.id : null;
    const revision = typeof document.revision === "number" && Number.isInteger(document.revision) && document.revision > 0 ? document.revision : null;
    const status = document.status === "active" || document.status === "superseded" ? document.status : null;
    const satisfies = category ? validSatisfies(category, document.satisfies) : null;
    const recordedAt = typeof document.recordedAt === "string" && Number.isFinite(Date.parse(document.recordedAt)) ? document.recordedAt : null;
    if (category && asset && extraction && id === asset.assetId && revision && status && satisfies && recordedAt) documents.push({id, category, satisfies, revision, status, asset, extraction, recordedAt});
  }
  const receipts: Record<string, {documentId: string; revision: number}> = {};
  if (raw.receipts && typeof raw.receipts === "object") for (const [key, receipt] of Object.entries(raw.receipts as Record<string, unknown>)) {
    if (key.length > 0 && key.length <= 120 && receipt && typeof receipt === "object") {
      const item = receipt as Record<string, unknown>;
      if (typeof item.documentId === "string" && uuid.test(item.documentId) && typeof item.revision === "number" && Number.isInteger(item.revision)) receipts[key] = {documentId: item.documentId, revision: item.revision};
    }
  }
  const stateRevision = raw.revision as number;
  let context: ProjectDocumentContext | null = null;
  if (raw.context && typeof raw.context === "object") {
    const candidate = raw.context as Record<string, unknown>;
    const content = cleanText(candidate.content, 100_000);
    const sourceDocumentIds = Array.isArray(candidate.sourceDocumentIds) && candidate.sourceDocumentIds.every((id) => typeof id === "string" && uuid.test(id)) ? candidate.sourceDocumentIds as string[] : null;
    if (candidate.contract === "fai.project-context.v1" && typeof candidate.version === "string" && hash.test(candidate.version) &&
      typeof candidate.documentRevision === "number" && Number.isInteger(candidate.documentRevision) && candidate.documentRevision <= stateRevision &&
      typeof candidate.preparedAt === "string" && Number.isFinite(Date.parse(candidate.preparedAt)) && content && sourceDocumentIds &&
      sourceDocumentIds.every((id) => documents.some((document) => document.id === id))) {
      context = {contract: "fai.project-context.v1", version: candidate.version, documentRevision: candidate.documentRevision,
        preparedAt: candidate.preparedAt, sourceDocumentIds, content};
    }
  }
  return {contract: "fai.project-documents.v1", revision: stateRevision, documents, context, receipts};
}

export function addProjectDocument(state: ProjectDocumentState, input: Readonly<{category: ProjectDocumentCategory; satisfies: readonly ("passport" | "specification")[]; asset: unknown; extraction: unknown; idempotencyKey: string; now: string}>): ProjectDocumentState {
  const asset = validAsset(input.asset); const extraction = validExtraction(input.extraction); const satisfies = validSatisfies(input.category, input.satisfies);
  if (!asset) throw new Error("native_asset_response_invalid");
  if (!extraction) throw new Error("document_extraction_invalid_or_unreadable");
  if (!satisfies) throw new Error("document_category_invalid");
  if (!input.idempotencyKey || input.idempotencyKey.length > 120) throw new Error("idempotency_key_invalid");
  if (state.receipts[input.idempotencyKey]) return state;
  if (state.documents.some((document) => document.id === asset.assetId)) throw new Error("document_already_recorded");
  const revision = Math.max(0, ...state.documents.filter((document) => document.category === input.category).map((document) => document.revision)) + 1;
  const fixed = input.category !== "other";
  const documents = state.documents.map((document) => fixed && document.category === input.category && document.status === "active" ? {...document, status: "superseded" as const} : document);
  documents.push({id: asset.assetId, category: input.category, satisfies, revision, status: "active", asset, extraction, recordedAt: input.now});
  const nextRevision = state.revision + 1;
  return {contract: "fai.project-documents.v1", revision: nextRevision, documents, context: state.context, receipts: {...state.receipts, [input.idempotencyKey]: {documentId: asset.assetId, revision: nextRevision}}};
}

export function activeProjectDocuments(state: ProjectDocumentState): readonly ProjectDocument[] { return state.documents.filter((document) => document.status === "active"); }

export function missingMandatoryDocuments(state: ProjectDocumentState): readonly ("passport" | "specification")[] {
  const satisfied = new Set(activeProjectDocuments(state).flatMap((document) => document.satisfies));
  return (["passport", "specification"] as const).filter((category) => !satisfied.has(category));
}

export function prepareProjectContext(state: ProjectDocumentState, now: string): ProjectDocumentState {
  const missing = missingMandatoryDocuments(state);
  if (missing.length) throw new Error(`mandatory_documents_missing:${missing.join(",")}`);
  const documents = activeProjectDocuments(state);
  const sourceBlocks = documents.map((document) => [
    `## ${document.category} · ${document.asset.originalFilename} (revision ${document.revision})`,
    `Source: ${document.asset.contentPath} · sha256:${document.asset.sha256}`,
    `Extraction: ${document.extraction.extractor}; ${document.extraction.contextCharacters}/${document.extraction.totalCharacters} characters${document.extraction.truncated ? " (source compact context truncated)" : ""}.`
  ].join("\n"));
  const headersLength = sourceBlocks.reduce((total, block) => total + block.length + 2, 0);
  if (headersLength >= maxPreparedContextCharacters) throw new Error("context_sources_too_many");
  // Reserve the explicit omission notice for every source before allocating
  // excerpts, so the saved context never crosses the parser's hard limit.
  let remaining = maxPreparedContextCharacters - headersLength - documents.length * 200;
  if (remaining < 0) throw new Error("context_sources_too_many");
  const content = sourceBlocks.map((source, index) => {
    const document = documents[index]!;
    const limit = Math.min(4_000, remaining);
    const excerpt = document.extraction.contextText.slice(0, limit);
    remaining -= excerpt.length;
    const omitted = document.extraction.contextText.length - excerpt.length;
    return `${source}\n${excerpt}${omitted > 0 ? `\n[Context excerpt limited to ${excerpt.length}/${document.extraction.contextText.length} characters; use the native source link for the original.]` : ""}`;
  }).join("\n\n");
  const version = createHash("sha256").update(content).digest("hex");
  return {...state, context: {contract: "fai.project-context.v1", version, documentRevision: state.revision, preparedAt: now, sourceDocumentIds: documents.map((document) => document.id), content}};
}
