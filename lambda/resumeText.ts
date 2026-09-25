import mammoth from "mammoth";
import { extractText } from "unpdf";

/** Supports `data:application/pdf;base64,` and `data:application/pdf;charset=utf-8;base64,` */
function parseDataUrl(
  dataUrl: string,
): { mime: string; buffer: Buffer } | null {
  const s = dataUrl.trim();
  if (!s.toLowerCase().startsWith("data:")) return null;
  const marker = ";base64,";
  const idx = s.indexOf(marker);
  if (idx === -1) return null;
  const header = s.slice(5, idx);
  const mime = header.split(";")[0].trim().toLowerCase();
  const b64 = s.slice(idx + marker.length).replace(/\s/g, "");
  try {
    const buffer = Buffer.from(b64, "base64");
    if (!buffer.length) return null;
    return { mime, buffer };
  } catch {
    return null;
  }
}

/** Copy bytes so the PDF engine does not detach the underlying ArrayBuffer. */
function bufferToUint8Array(buf: Buffer): Uint8Array {
  return Uint8Array.from(buf);
}

async function tryExtractPdfText(buf: Buffer): Promise<string> {
  const data = bufferToUint8Array(buf);
  try {
    const { text } = await extractText(data, { mergePages: true });
    return (text ?? "").trim();
  } catch {
    return "";
  }
}

async function tryExtractDocxText(buf: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer: buf });
    return (result.value ?? "").trim();
  } catch {
    return "";
  }
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Turns client-sent resume (plain text or data URL base64 for PDF/DOCX) into plain text.
 * Does not throw — callers check length.
 *
 * Copied from Applyfy `lib/resumeText.ts` for use in the parseResume Lambda.
 */
export async function cleanResumeToPlainText(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const parsed = parseDataUrl(trimmed);
  if (parsed) {
    const { mime, buffer: buf } = parsed;
    const head = buf.subarray(0, 8);
    const magic4 = head.subarray(0, 4).toString("ascii");
    const isPdfMagic = magic4 === "%PDF";
    const isZipMagic = head[0] === 0x50 && head[1] === 0x4b;

    const treatAsPdf =
      mime.includes("pdf") ||
      mime === "application/x-pdf" ||
      isPdfMagic;
    const treatAsDocx =
      mime.includes("wordprocessingml") ||
      mime.includes("officedocument.wordprocessingml") ||
      (isZipMagic && !isPdfMagic);

    if (treatAsPdf) {
      const text = await tryExtractPdfText(buf);
      return normalizeWhitespace(text);
    }

    if (treatAsDocx) {
      const text = await tryExtractDocxText(buf);
      return normalizeWhitespace(text);
    }

    const isLegacyWord =
      mime.includes("msword") && !mime.includes("openxml");
    const isOleCompound =
      head[0] === 0xd0 &&
      head[1] === 0xcf &&
      head[2] === 0x11 &&
      head[3] === 0xa0;
    if (isLegacyWord || isOleCompound) {
      return "";
    }

    try {
      return normalizeWhitespace(buf.toString("utf8"));
    } catch {
      return "";
    }
  }

  let text = trimmed;
  text = text.replace(/data:[a-z]+\/[^;]+;base64,[A-Za-z0-9+/=\s]+/gi, " ");
  text = text.replace(/[A-Za-z0-9+/=\s]{300,}/g, (block) => {
    const compact = block.replace(/\s/g, "");
    if (/^[A-Za-z0-9+/]+=*$/.test(compact) && compact.length > 200) return " ";
    return block;
  });
  text = text.replace(/<[^>]{1,200}>/g, " ");
  return normalizeWhitespace(text);
}
