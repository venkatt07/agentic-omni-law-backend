import PDFDocument from "pdfkit";

export function toSingleLine(value: unknown, fallback = "N/A") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

export function toDateTime(value?: string | number | Date | null) {
  if (!value) return "N/A";
  const dt = new Date(value);
  if (!Number.isFinite(dt.getTime())) return "N/A";
  return dt.toLocaleString();
}

export function shortenText(value: unknown, max = 420) {
  const text = toSingleLine(value, "");
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...` : text;
}

export type PdfHelpers = {
  pageWidth: number;
  pageBottomY: number;
  ensureSpace: (minHeight?: number) => void;
  heading: (text: string) => void;
  subheading: (text: string) => void;
  line: (label: string, value: unknown) => void;
  paragraph: (value: unknown) => void;
  bullets: (items: unknown[], maxItems?: number) => void;
};

export function createPdfBuffer(render: (doc: any, helpers: PdfHelpers) => void) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 42, bottom: 42, left: 42, right: 42 },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pageBottomY = doc.page.height - doc.page.margins.bottom;

    const ensureSpace = (minHeight = 28) => {
      if (doc.y + minHeight > pageBottomY) doc.addPage();
    };
    const heading = (text: string) => {
      ensureSpace(26);
      doc.moveDown(0.1);
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a").text(text, { width: pageWidth });
      doc.moveDown(0.15);
    };
    const subheading = (text: string) => {
      ensureSpace(22);
      doc.moveDown(0.08);
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111827").text(text, { width: pageWidth });
      doc.moveDown(0.08);
    };
    const line = (label: string, value: unknown) => {
      ensureSpace(16);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(`${label}: `, { continued: true, width: pageWidth });
      doc.font("Helvetica").fontSize(10).fillColor("#111827").text(toSingleLine(value), { width: pageWidth });
    };
    const paragraph = (value: unknown) => {
      ensureSpace(16);
      doc.font("Helvetica").fontSize(10).fillColor("#111827").text(toSingleLine(value), {
        width: pageWidth,
        lineGap: 1.2,
      });
    };
    const bullets = (items: unknown[], maxItems = 8) => {
      const list = (items || []).map((x) => toSingleLine(x, "")).filter(Boolean).slice(0, maxItems);
      if (!list.length) {
        paragraph("N/A");
        return;
      }
      for (const item of list) {
        ensureSpace(14);
        doc.font("Helvetica").fontSize(10).fillColor("#111827").text(`- ${item}`, {
          width: pageWidth,
          lineGap: 1.1,
          indent: 8,
        });
      }
    };

    render(doc, { pageWidth, pageBottomY, ensureSpace, heading, subheading, line, paragraph, bullets });
    doc.end();
  });
}
