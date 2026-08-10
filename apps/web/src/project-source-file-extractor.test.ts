import {expect, it, vi} from 'vitest';
import JSZip from 'jszip';
import {createProjectSourceFileExtractor, SourceFileExtractionError, sourceFileParserLimits} from './project-source-file-extractor';

const bytes = (text: string) => new TextEncoder().encode(text);
const realPdf = () => {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '5 0 obj\n<< /Length 48 >>\nstream\nBT /F1 18 Tf 72 72 Td (PDF golden requirement) Tj ET\nendstream\nendobj\n'
  ];
  const header = '%PDF-1.4\n'; const offsets: number[] = []; let body = header;
  for (const object of objects) { offsets.push(Buffer.byteLength(body, 'utf8')); body += object; }
  const xref = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytes(body);
};
const realDocx = async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX golden acceptance</w:t></w:r></w:p></w:body></w:document>');
  return new Uint8Array(await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'}));
};
const encryptedZip = (source: Uint8Array) => {
  const output = new Uint8Array(source); const setFlag = (signature: readonly number[], offset: number) => {
    for (let index = 0; index <= output.length - signature.length; index += 1) if (signature.every((byte, position) => output[index + position] === byte)) output[index + offset] = (output[index + offset] ?? 0) | 1;
  };
  setFlag([0x50, 0x4b, 0x03, 0x04], 6); setFlag([0x50, 0x4b, 0x01, 0x02], 8); return output;
};
const oversizedDocx = async () => {
  const zip = await JSZip.loadAsync(await realDocx());
  zip.file('word/expanded.txt', 'x'.repeat(sourceFileParserLimits.docxUncompressedBytes + 1));
  return new Uint8Array(await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'}));
};
const manyEntryDocx = async () => {
  const zip = await JSZip.loadAsync(await realDocx());
  for (let index = 0; index <= sourceFileParserLimits.docxEntries; index += 1) zip.file(`word/entry-${index}.txt`, 'x');
  return new Uint8Array(await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'}));
};

it('extracts bounded text, JSON, PDF and DOCX into text only', async () => {
  const pdf = vi.fn().mockResolvedValue('PDF requirements'); const docx = vi.fn().mockResolvedValue('DOCX acceptance');
  const extractor = createProjectSourceFileExtractor({pdf, docx});
  await expect(extractor.extract({filename: 'brief.txt', mediaType: 'text/plain', rawBytes: bytes('plain')})).resolves.toMatchObject({content: 'plain', extractionMethod: 'utf8_text_v1'});
  await expect(extractor.extract({filename: 'brief.json', mediaType: 'application/json', rawBytes: bytes('{"scope":"confirmed"}')})).resolves.toMatchObject({mediaType: 'application/json', extractionMethod: 'json_utf8_v1'});
  await expect(extractor.extract({filename: 'brief.pdf', mediaType: 'application/pdf', rawBytes: bytes('%PDF-1.7')})).resolves.toMatchObject({content: 'PDF requirements', mediaType: 'text/plain', extractionMethod: 'pdfjs_text_v1'});
  await expect(extractor.extract({filename: 'brief.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rawBytes: bytes('PK\u0003\u0004')})).resolves.toMatchObject({content: 'DOCX acceptance', mediaType: 'text/plain', extractionMethod: 'mammoth_text_v1'});
  expect(pdf).toHaveBeenCalledOnce(); expect(docx).toHaveBeenCalledOnce();
});

it('uses the real default PDF.js and Mammoth parser paths on tiny valid documents', async () => {
  const extractor = createProjectSourceFileExtractor();
  await expect(extractor.extract({filename: 'golden.pdf', mediaType: 'application/pdf', rawBytes: realPdf()})).resolves.toMatchObject({content: expect.stringContaining('PDF golden requirement'), extractionMethod: 'pdfjs_text_v1'});
  await expect(extractor.extract({filename: 'golden.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rawBytes: await realDocx()})).resolves.toMatchObject({content: expect.stringContaining('DOCX golden acceptance'), extractionMethod: 'mammoth_text_v1'});
});

it('rejects malformed, corrupt or encrypted-like files without returning their bytes', async () => {
  const extractor = createProjectSourceFileExtractor({pdf: async () => { throw new Error('encrypted'); }});
  await expect(extractor.extract({filename: 'brief.json', mediaType: 'application/json', rawBytes: bytes('{')})).rejects.toBeInstanceOf(SourceFileExtractionError);
  await expect(extractor.extract({filename: 'brief.pdf', mediaType: 'application/pdf', rawBytes: bytes('%PDF-1.7')})).rejects.toBeInstanceOf(SourceFileExtractionError);
  await expect(extractor.extract({filename: 'brief.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rawBytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])})).rejects.toBeInstanceOf(SourceFileExtractionError);
  await expect(extractor.extract({filename: 'encrypted.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rawBytes: encryptedZip(await realDocx())})).rejects.toBeInstanceOf(SourceFileExtractionError);
  await expect(extractor.extract({filename: 'expanded.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rawBytes: await oversizedDocx()})).rejects.toBeInstanceOf(SourceFileExtractionError);
  await expect(extractor.extract({filename: 'many.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rawBytes: await manyEntryDocx()})).rejects.toBeInstanceOf(SourceFileExtractionError);
  await expect(extractor.extract({filename: 'brief.txt', mediaType: 'text/plain', rawBytes: new Uint8Array([0, 1])})).rejects.toBeInstanceOf(SourceFileExtractionError);
});
