import JSZip from "jszip";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

export type BrowserDocumentExtraction = Readonly<{
  extractor: "browser-text" | "browser-docx" | "browser-pdf";
  totalCharacters: number;
  contextCharacters: number;
  truncated: boolean;
  contextText: string;
}>;

const contextLimit = 16_000;
const extractionLimit = 200_000;
const docxXmlLimit = 1_000_000;
const documentTimeoutMs = 15_000;
const maxFileBytes = 10 * 1024 * 1024;

let workerSource: Promise<string> | null = null;

async function nativePdfWorkerSource(): Promise<string> {
  workerSource ??= fetch("/api/plugins/ui-contributions", {credentials: "same-origin"}).then(async (response) => {
    if (!response.ok) throw new Error("pdf_worker_unavailable");
    const contributions = await response.json() as Array<{pluginId?: unknown; pluginKey?: unknown}>;
    const contribution = contributions.find((entry) => entry.pluginKey === "vf78.fai-control" && typeof entry.pluginId === "string");
    if (!contribution) throw new Error("pdf_worker_unavailable");
    const pluginId = contribution.pluginId;
    if (typeof pluginId !== "string") throw new Error("pdf_worker_unavailable");
    return `/_plugins/${encodeURIComponent(pluginId)}/ui/pdf.worker.js`;
  });
  return await workerSource;
}

function normalized(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function timed<T>(work: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timeout = setTimeout(() => reject(new Error("document_extraction_timeout")), documentTimeoutMs); })]); }
  finally { if (timeout) clearTimeout(timeout); }
}

async function docxText(file: File): Promise<string> {
  const archive = await timed(JSZip.loadAsync(await file.arrayBuffer(), {checkCRC32: false, createFolders: false}));
  const xml = archive.file("word/document.xml");
  if (!xml || xml.dir) throw new Error("docx_document_xml_missing");
  const uncompressedSize = (xml as unknown as {_data?: {uncompressedSize?: unknown}})._data?.uncompressedSize;
  if (typeof uncompressedSize !== "number" || !Number.isSafeInteger(uncompressedSize) || uncompressedSize <= 0 || uncompressedSize > docxXmlLimit) throw new Error("docx_content_too_large");
  const source = await timed(new Promise<string>((resolve, reject) => {
    const stream = (xml as unknown as {internalStream(type: "uint8array"): {on(event: "data" | "error" | "end", listener: (value?: Uint8Array | Error) => void): unknown; pause(): void; resume(): void}}).internalStream("uint8array");
    const chunks: Uint8Array[] = []; let length = 0;
    stream.on("data", (value) => {
      const chunk = value instanceof Uint8Array ? value : new Uint8Array();
      length += chunk.byteLength;
      if (length > docxXmlLimit) { stream.pause(); reject(new Error("docx_content_too_large")); return; }
      chunks.push(chunk);
    });
    stream.on("error", (value) => reject(value instanceof Error ? value : new Error("docx_unreadable")));
    stream.on("end", () => {
      const output = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      resolve(new TextDecoder().decode(output));
    });
    stream.resume();
  }));
  const parsed = new DOMParser().parseFromString(source, "application/xml");
  if (parsed.querySelector("parsererror")) throw new Error("docx_xml_invalid");
  const namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const paragraphs = Array.from(parsed.getElementsByTagNameNS(namespace, "p"));
  return (paragraphs.length > 0 ? paragraphs.map((paragraph) => paragraph.textContent ?? "").join("\n") : parsed.documentElement.textContent) ?? "";
}

async function pdfText(file: File): Promise<string> {
  GlobalWorkerOptions.workerSrc = await nativePdfWorkerSource();
  const loadingTask = getDocument({data: new Uint8Array(await file.arrayBuffer()), disableAutoFetch: true, disableStream: true, isEvalSupported: false, useWorkerFetch: false, stopAtErrors: true});
  try {
    const pdf = await timed(loadingTask.promise);
    if (pdf.numPages < 1 || pdf.numPages > 200) throw new Error("pdf_page_count_unsupported");
    const parts: string[] = []; let length = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await timed(pdf.getPage(pageNumber));
      const content = await timed(page.getTextContent());
      const pageText = content.items.flatMap((item) => "str" in item && typeof item.str === "string" ? [item.str] : []).join(" ");
      length += pageText.length;
      if (length > extractionLimit) throw new Error("document_text_too_large");
      parts.push(pageText);
    }
    return parts.join("\n");
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException" || name === "InvalidPDFException" || name === "FormatError") throw new Error("pdf_unreadable_or_encrypted");
    throw error;
  } finally { await loadingTask.destroy(); }
}

export async function extractBrowserDocument(file: File): Promise<BrowserDocumentExtraction> {
  if (file.size <= 0) throw new Error("document_empty");
  if (file.size > maxFileBytes) throw new Error("document_file_too_large");
  const name = file.name.toLowerCase();
  let extractor: BrowserDocumentExtraction["extractor"]; let text: string;
  if (name.endsWith(".txt") || name.endsWith(".md")) { extractor = "browser-text"; text = await timed(file.text()); }
  else if (name.endsWith(".docx")) { extractor = "browser-docx"; text = await docxText(file); }
  else if (name.endsWith(".pdf")) { extractor = "browser-pdf"; text = await pdfText(file); }
  else throw new Error("document_type_unsupported");
  text = normalized(text);
  if (!text) throw new Error("document_unreadable_or_empty");
  if (text.length > extractionLimit) throw new Error("document_text_too_large");
  const contextText = text.slice(0, contextLimit);
  return {extractor, totalCharacters: text.length, contextCharacters: contextText.length, truncated: text.length > contextText.length, contextText};
}
