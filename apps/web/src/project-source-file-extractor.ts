import {sourceFileMediaTypeForFilename, sourceFileUploadLimits, type SourceArtifactMediaType, type SourceFileProvenance} from '@fai-control-plane/domain';
import JSZip from 'jszip';

export class SourceFileExtractionError extends Error {
  constructor() { super('The source file could not be safely extracted.'); }
}

type PdfExtractor = (bytes: Uint8Array) => Promise<string>;
type DocxExtractor = (bytes: Uint8Array) => Promise<string>;
export const sourceFileParserLimits = Object.freeze({pdfPages: 32, docxEntries: 128, docxUncompressedBytes: 4 * 1024 * 1024});
export type ProjectSourceFileExtractor = Readonly<{
  extract(input: Readonly<{filename: string; mediaType: string; rawBytes: Uint8Array}>): Promise<Readonly<{
    content: string;
    mediaType: SourceArtifactMediaType;
    extractionMethod: SourceFileProvenance['extractionMethod'];
  }>>;
}>;

const invalid = (): never => { throw new SourceFileExtractionError(); };
const utf8 = (bytes: Uint8Array) => {
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { return invalid(); }
};
const extracted = (content: string) => {
  if (content.includes('\u0000') || Buffer.byteLength(content, 'utf8') < 1 || Buffer.byteLength(content, 'utf8') > sourceFileUploadLimits.extractedTextBytes) invalid();
  return content;
};
const defaultPdfExtractor: PdfExtractor = async (bytes) => {
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') invalid();
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({data: new Uint8Array(bytes)});
    const document = await task.promise;
    try {
      if (document.numPages < 1 || document.numPages > sourceFileParserLimits.pdfPages) invalid();
      const chunks: string[] = []; let totalBytes = 0;
      for (let index = 0; index < document.numPages; index += 1) {
        const page = await document.getPage(index + 1);
        const reader = page.streamTextContent().getReader(); let complete = false;
        try {
          for (;;) {
            const next = await reader.read(); if (next.done) { complete = true; break; }
            const items = (next.value as Readonly<{items?: unknown}>).items;
            if (!Array.isArray(items)) invalid();
            for (const item of items as unknown[]) {
              if (typeof item !== 'object' || item === null || !('str' in item) || typeof item.str !== 'string') continue;
              const prefix = chunks.length === 0 ? '' : ' ';
              totalBytes += Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(item.str, 'utf8');
              if (totalBytes > sourceFileUploadLimits.extractedTextBytes) invalid();
              chunks.push(prefix, item.str);
            }
          }
        } finally { if (!complete) await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        if (index < document.numPages - 1) { totalBytes += 1; if (totalBytes > sourceFileUploadLimits.extractedTextBytes) invalid(); chunks.push('\n'); }
      }
      return chunks.join('');
    } finally { document.cleanup(); }
  } catch { return invalid(); }
};
const preflightDocxZip = async (bytes: Uint8Array) => {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes, {createFolders: false, checkCRC32: false}); } catch { return invalid(); }
  const entries = Object.values(zip.files);
  if (entries.length < 1 || entries.length > sourceFileParserLimits.docxEntries) invalid();
  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const metadata = (entry as unknown as Readonly<{_data?: Readonly<{compressedSize?: unknown; uncompressedSize?: unknown}>}>)._data;
    const compressedSize = metadata?.compressedSize; const uncompressedSize = metadata?.uncompressedSize;
    if (typeof compressedSize !== 'number' || typeof uncompressedSize !== 'number' || !Number.isSafeInteger(compressedSize) || !Number.isSafeInteger(uncompressedSize) || compressedSize < 0 || uncompressedSize < 0) invalid();
    totalUncompressedBytes += uncompressedSize as number;
    if (totalUncompressedBytes > sourceFileParserLimits.docxUncompressedBytes) invalid();
  }
};
const defaultDocxExtractor: DocxExtractor = async (bytes) => {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) invalid();
  try {
    await preflightDocxZip(bytes);
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({buffer: Buffer.from(bytes)})).value;
  } catch { return invalid(); }
};
const safelyExtract = async (extractor: PdfExtractor | DocxExtractor, bytes: Uint8Array) => {
  try { return await extractor(bytes); } catch { return invalid(); }
};

export const createProjectSourceFileExtractor = (overrides: Readonly<{pdf?: PdfExtractor; docx?: DocxExtractor}> = {}): ProjectSourceFileExtractor => ({
  async extract({filename, mediaType, rawBytes}) {
    const expectedMediaType = sourceFileMediaTypeForFilename(filename);
    if (expectedMediaType === null || expectedMediaType !== mediaType || rawBytes.byteLength < 1 || rawBytes.byteLength > sourceFileUploadLimits.rawBytes) invalid();
    if (mediaType === 'text/plain' || mediaType === 'text/markdown') return {content: extracted(utf8(rawBytes)), mediaType, extractionMethod: 'utf8_text_v1'};
    if (mediaType === 'application/json') {
      const content = extracted(utf8(rawBytes));
      try { JSON.parse(content); } catch { return invalid(); }
      return {content, mediaType, extractionMethod: 'json_utf8_v1'};
    }
    if (mediaType === 'application/pdf') return {content: extracted(await safelyExtract(overrides.pdf ?? defaultPdfExtractor, rawBytes)), mediaType: 'text/plain', extractionMethod: 'pdfjs_text_v1'};
    return {content: extracted(await safelyExtract(overrides.docx ?? defaultDocxExtractor, rawBytes)), mediaType: 'text/plain', extractionMethod: 'mammoth_text_v1'};
  }
});
