import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractText } from './documentParser.js';

const { pdfText, destroy, docxText } = vi.hoisted(() => ({
  pdfText: vi.fn(), destroy: vi.fn(), docxText: vi.fn()
}));
vi.mock('pdf-parse', () => ({ PDFParse: class {
  constructor({ data }) { if (!Buffer.isBuffer(data)) throw new Error('Expected PDF bytes'); }
  getText = pdfText;
  destroy = destroy;
} }));
vi.mock('mammoth', () => ({ extractRawText: docxText }));
afterEach(() => vi.resetAllMocks());

describe('study material parsing without a local file', () => {
  it('extracts UTF-8 text and Markdown from upload bytes', async () => {
    expect(await extractText(Buffer.from('Hello, 世界'), 'notes.txt')).toBe('Hello, 世界');
    expect(await extractText(Buffer.from('# Notes'), 'notes.md')).toBe('# Notes');
  });

  it('parses PDF bytes and releases the parser even after extraction fails', async () => {
    pdfText.mockResolvedValueOnce({ text: 'PDF text' }).mockRejectedValueOnce(new Error('invalid PDF'));
    expect(await extractText(Buffer.from('pdf'), 'notes.pdf')).toBe('PDF text');
    await expect(extractText(Buffer.from('bad'), 'bad.pdf')).rejects.toThrow('invalid PDF');
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('passes DOCX bytes directly to the document parser', async () => {
    const bytes = Buffer.from('docx');
    docxText.mockResolvedValue({ value: 'DOCX text' });
    expect(await extractText(bytes, 'notes.docx')).toBe('DOCX text');
    expect(docxText).toHaveBeenCalledWith({ buffer: bytes });
  });
});
