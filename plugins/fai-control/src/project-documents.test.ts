import { describe, expect, it } from "vitest";
import { addProjectDocument, emptyProjectDocumentState, missingMandatoryDocuments, prepareProjectContext } from "./project-documents.js";

const asset = (id: string, filename = "passport.txt") => ({assetId: id, originalFilename: filename, contentType: "text/plain", byteSize: 42, sha256: "a".repeat(64), createdAt: "2026-09-17T00:00:00.000Z"});
const extraction = {extractor: "browser-text" as const, totalCharacters: 13, contextCharacters: 13, truncated: false, contextText: "Project scope"};
const first = "10000000-0000-4000-8000-000000000001";

describe("project documents", () => {
  it("accepts a combined passport/specification source and builds source-linked compact context", () => {
    const state = addProjectDocument(emptyProjectDocumentState(), {category: "passport", satisfies: ["passport", "specification"], asset: asset(first), extraction, idempotencyKey: "upload-1", now: "2026-09-17T00:00:00.000Z"});
    expect(missingMandatoryDocuments(state)).toEqual([]);
    const prepared = prepareProjectContext(state, "2026-09-17T01:00:00.000Z");
    expect(prepared.context).toMatchObject({documentRevision: 1, sourceDocumentIds: [first]});
    expect(prepared.context?.content).toContain(`/api/assets/${first}/content`);
  });

  it("keeps an earlier original as a superseded revision and rejects empty derived text", () => {
    const state = addProjectDocument(emptyProjectDocumentState(), {category: "passport", satisfies: ["passport"], asset: asset(first), extraction, idempotencyKey: "upload-1", now: "2026-09-17T00:00:00.000Z"});
    const next = addProjectDocument(state, {category: "passport", satisfies: ["passport"], asset: asset("10000000-0000-4000-8000-000000000002", "passport-v2.txt"), extraction, idempotencyKey: "upload-2", now: "2026-09-17T01:00:00.000Z"});
    expect(next.documents.map((document) => [document.revision, document.status])).toEqual([[1, "superseded"], [2, "active"]]);
    expect(() => addProjectDocument(next, {category: "other", satisfies: [] as never[], asset: asset("10000000-0000-4000-8000-000000000003", "notes.txt"), extraction: {...extraction, contextText: "", contextCharacters: 0, totalCharacters: 0}, idempotencyKey: "bad", now: "2026-09-17T01:00:00.000Z"})).toThrow("document_extraction_invalid_or_unreadable");
  });

  it("keeps every active source link while bounding the prepared context explicitly", () => {
    let state = addProjectDocument(emptyProjectDocumentState(), {category: "passport", satisfies: ["passport", "specification"], asset: asset(first), extraction, idempotencyKey: "mandatory", now: "2026-09-17T00:00:00.000Z"});
    for (let index = 0; index < 30; index += 1) state = addProjectDocument(state, {category: "other", satisfies: [], asset: asset(`10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`, `note-${index}.txt`), extraction: {...extraction, totalCharacters: 16_000, contextCharacters: 16_000, truncated: false, contextText: "x".repeat(16_000)}, idempotencyKey: `note-${index}`, now: "2026-09-17T00:00:00.000Z"});
    const prepared = prepareProjectContext(state, "2026-09-17T01:00:00.000Z");
    expect(prepared.context?.content.length).toBeLessThan(96_001);
    expect(prepared.context?.content).toContain("Context excerpt limited");
    expect(prepared.context?.sourceDocumentIds).toHaveLength(31);
  });
});
