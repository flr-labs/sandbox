const PAGE_W = 792;
const PAGE_H = 612;
const MARGIN = 40;
const PINE = "0.078 0.169 0.149";
const MUTED = "0.361 0.420 0.400";
const IVORY = "0.965 0.957 0.933";
const SAGE = "0.855 0.902 0.863";
const LINE = "0.843 0.878 0.855";

function pdfSafe(value) {
  return String(value ?? "")
    .replaceAll("—", "-")
    .replaceAll("–", "-")
    .replaceAll("’", "'")
    .replaceAll("“", "\"")
    .replaceAll("”", "\"")
    .replaceAll("…", "...")
    .replace(/[^\x00-\xff]/g, "");
}

function pdfLiteral(value) {
  return pdfSafe(value).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function wrap(value, size, width) {
  const max = Math.max(4, Math.floor(width / (size * 0.5)));
  const words = pdfSafe(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function buildItineraryPdf(model) {
  const pages = [];
  let ops = [];
  let top = MARGIN;

  const pdfY = (fromTop, size = 0) => PAGE_H - fromTop - size;
  const startPage = () => {
    ops = [`${IVORY} rg`, `0 0 ${PAGE_W} ${PAGE_H} re f`];
    top = MARGIN;
  };
  const finishPage = () => pages.push(ops.join("\n"));
  const room = (need) => {
    if (top + need <= PAGE_H - MARGIN) return;
    finishPage();
    startPage();
  };
  const text = (value, x, size, font, color) => {
    const lines = Array.isArray(value) ? value : [value];
    for (const line of lines) {
      room(size + 3);
      const baseline = pdfY(top, size);
      ops.push(`${color} rg`);
      ops.push(`BT /${font} ${size} Tf 1 0 0 1 ${x} ${baseline.toFixed(2)} Tm (${pdfLiteral(line)}) Tj ET`);
      top += size + 3;
    }
  };
  const gap = (amount) => {
    top += amount;
  };
  startPage();
  text(model.kicker || "ParkPilot", MARGIN, 9, "F1", MUTED);
  gap(2);
  text(model.title || "Itinerary", MARGIN, 22, "F2", PINE);
  gap(2);
  if (model.subtitle) text(wrap(model.subtitle, 11, PAGE_W - MARGIN * 2), MARGIN, 11, "F1", PINE);
  gap(10);

  for (const section of model.sections || []) {
    text(section.heading || "", MARGIN, 14, "F2", PINE);
    gap(2);
    for (const paragraph of section.paragraphs || []) text(wrap(paragraph, 10, PAGE_W - MARGIN * 2), MARGIN, 10, "F1", PINE);
    if (section.table?.headers?.length) drawTable(section.table);
    if (section.cards?.length) drawCards(section.cards);
    gap(8);
  }
  if (model.footer) {
    gap(4);
    text(wrap(model.footer, 9, PAGE_W - MARGIN * 2), MARGIN, 9, "F1", MUTED);
  }
  finishPage();
  return assemble(pages);

  function columnWidths(count) {
    if (count === 6) return [88, 170, 78, 72, 78, PAGE_W - MARGIN * 2 - 486];
    const width = (PAGE_W - MARGIN * 2) / Math.max(count, 1);
    return Array.from({ length: count }, () => width);
  }

  function drawTable(table) {
    const widths = columnWidths(table.headers.length);
    const size = 9;
    const lineH = 12;
    const drawRow = (cells, header) => {
      const wrapped = cells.map((cell, index) => wrap(cell, size, widths[index] - 8));
      const lines = Math.max(1, ...wrapped.map((item) => item.length));
      const height = lines * lineH + 8;
      room(height);
      const y = pdfY(top, height);
      ops.push(header ? `${SAGE} rg` : "1 1 1 rg");
      ops.push(`${MARGIN} ${y.toFixed(2)} ${PAGE_W - MARGIN * 2} ${height} re f`);
      ops.push(`${LINE} RG 0.4 w`);
      ops.push(`${MARGIN} ${y.toFixed(2)} ${PAGE_W - MARGIN * 2} ${height} re S`);
      let x = MARGIN;
      wrapped.forEach((item, index) => {
        item.forEach((line, lineIndex) => {
          const baseline = pdfY(top + 6 + lineIndex * lineH, size);
          ops.push(`${header ? MUTED : PINE} rg`);
          ops.push(`BT /${header ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${(x + 4).toFixed(2)} ${baseline.toFixed(2)} Tm (${pdfLiteral(line)}) Tj ET`);
        });
        x += widths[index];
      });
      top += height;
    };
    drawRow(table.headers, true);
    for (const row of table.rows || []) drawRow(table.headers.map((_, index) => row[index] || ""), false);
    gap(4);
  }

  function drawCards(cards) {
    const columns = Math.min(3, Math.max(cards.length, 1));
    const gapX = 8;
    const width = (PAGE_W - MARGIN * 2 - gapX * (columns - 1)) / columns;
    for (let index = 0; index < cards.length; index += columns) {
      const slice = cards.slice(index, index + columns);
      const blocks = slice.map((card) => ({
        title: wrap(card.title, 9, width - 12),
        body: wrap(card.body, 9, width - 12).filter(Boolean),
      }));
      const lines = Math.max(1, ...blocks.map((block) => block.title.length + block.body.length));
      const height = lines * 12 + 12;
      room(height);
      slice.forEach((_, column) => {
        const x = MARGIN + column * (width + gapX);
        const y = pdfY(top, height);
        ops.push(`${IVORY} rg ${LINE} RG 0.4 w`);
        ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height} re B`);
        const linesForCard = [
          ...blocks[column].title.map((line) => ({ line, font: "F2", color: PINE })),
          ...blocks[column].body.map((line) => ({ line, font: "F1", color: MUTED })),
        ];
        linesForCard.forEach((item, lineIndex) => {
          const baseline = pdfY(top + 6 + lineIndex * 12, 9);
          ops.push(`${item.color} rg`);
          ops.push(`BT /${item.font} 9 Tf 1 0 0 1 ${(x + 6).toFixed(2)} ${baseline.toFixed(2)} Tm (${pdfLiteral(item.line)}) Tj ET`);
        });
      });
      top += height + 6;
    }
  }
}

function assemble(pageStreams) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const font1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const font2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pageIds = pageStreams.map((stream) => {
    const contents = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent @@PAGEPARENT@@ /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contents} 0 R /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> >>`);
  });
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const withParent = objects.map((body) => body.replaceAll("@@PAGEPARENT@@", `${pagesId} 0 R`));
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  withParent.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes = new Uint8Array(pdf.length);
  for (let index = 0; index < pdf.length; index += 1) bytes[index] = pdf.charCodeAt(index) & 0xff;
  return bytes;
}

export { buildItineraryPdf };
