const AppError = require("../../utils/AppError");
const {
  sheetToMatrix,
  normalizeHeader,
  toNumber,
  toIsoDate,
  isTotalRow,
  isBlankRow,
  buildHeaders,
} = require("./spreadsheet.helper");
const { isZomatoSettlementWorkbook, parseZomatoSettlementWorkbook } = require("./zomatoSettlement.helper");
const { isSwiggyAnnexureWorkbook, parseSwiggyAnnexureWorkbook } = require("./swiggyAnnexure.helper");

/**
 * Field dictionary for Swiggy / Zomato / Ownly payout & settlement exports.
 * `exclude`: header is rejected for that field if it contains any of these words.
 * `multi`: all matching columns are summed (e.g. CGST + SGST on commission).
 */
const FIELDS = {
  orderId: { cands: ["order id", "order no", "order number", "orderid", "order ref"], kind: "text" },
  orderDate: { cands: ["order date", "order placed date", "order time", "order placed at", "date", "created at", "transaction date", "bill date"], kind: "date", exclude: ["payout", "settlement", "utr", "credit"] },
  payoutDate: { cands: ["payout date", "settlement date", "utr date", "credit date", "transfer date", "payment date"], kind: "date" },
  outlet: { cands: ["outlet name", "restaurant name", "res name", "outlet", "restaurant", "branch", "location", "store name"], kind: "text", exclude: ["id", "discount", "share"] },
  accountId: { cands: ["res id", "restaurant id", "outlet id", "store id", "rest id"], kind: "text" },
  weekLabel: { cands: ["payout period", "settlement period", "week", "period", "date range", "payout cycle", "cycle"], kind: "text" },
  orderStatus: { cands: ["order status", "status"], kind: "text" },
  orderCount: { cands: ["total orders", "order count", "no of orders", "number of orders", "orders"], kind: "num" },
  grossSales: {
    cands: ["gross sales", "item total", "items total", "subtotal", "sub total", "food sales", "order value", "total order value", "bill value", "item value", "gross amount", "bill subtotal", "customer payable", "gross order value"],
    kind: "num",
    exclude: ["gst", "tax", "commission", "discount"],
  },
  customerDiscounts: { cands: ["merchant discount", "restaurant discount", "merchant share of discount", "discount", "promo", "coupon", "offer"], kind: "num", exclude: ["gst", "tax", "commission", "platform"] },
  commissionAmount: { cands: ["commission", "platform fee", "platform fees", "service fee", "service fees", "take rate", "swiggy fee", "zomato fee", "ownly fee"], kind: "num", exclude: ["gst", "tax", "rate %", "%"] },
  commissionRate: { cands: ["commission rate", "commission %", "commission percentage"], kind: "num" },
  paymentGatewayFee: { cands: ["payment gateway", "pg fee", "pg charges", "payment mechanism fee", "payment processing", "gateway fee", "collection charges"], kind: "num", exclude: ["gst", "tax"] },
  deliveryChargesCollected: { cands: ["delivery charge", "delivery charges", "delivery fee", "long distance", "customer delivery"], kind: "num", exclude: ["gst", "tax"] },
  advertisingSpend: { cands: ["ads", "ad spend", "advertisement", "advertising", "marketing", "promotion fee", "cpc", "boost"], kind: "num", exclude: ["gst", "tax"] },
  cancellationCharges: { cands: ["cancellation", "cancellation charges", "penalty", "rejection", "refund", "customer complaint"], kind: "num", exclude: ["gst", "tax", "status"] },
  otherPlatformFees: { cands: ["other charges", "other fees", "other deductions", "misc", "miscellaneous", "adjustment", "adjustments"], kind: "num", exclude: ["gst", "tax"] },
  gstOnCommission: {
    cands: ["gst on commission", "gst on service fee", "gst on platform fee", "gst on fees", "gst on fee", "taxes on service fee", "tax on service", "tax on fee", "tax on commission", "cgst on", "sgst on", "igst on", "18% gst"],
    kind: "num",
    multi: true,
  },
  tcsDeduction: { cands: ["tcs", "tax collected at source"], kind: "num" },
  tdsDeduction: { cands: ["tds", "tax deducted at source"], kind: "num" },
  hyperpureRecovery: { cands: ["hyperpure", "supplier recovery", "procurement recovery", "vendor offset", "hyperpure recovery", "recovery"], kind: "num" },
  netPayout: {
    cands: ["net payout", "final payout", "net payable", "payout amount", "settlement amount", "amount transferred", "net settlement", "bank credit", "net receivable", "payable amount", "net amount payable", "amount credited", "net amount"],
    kind: "num",
  },
};

const scoreAgainst = (norm, cands) => {
  let best = 0;
  for (const raw of cands) {
    const c = normalizeHeader(raw);
    if (!c) continue;
    if (norm === c) best = Math.max(best, 100);
    else if (norm.startsWith(`${c} `) || norm.endsWith(` ${c}`)) best = Math.max(best, 85);
    else if (` ${norm} `.includes(` ${c} `)) best = Math.max(best, 70);
  }
  return best;
};

const isExcluded = (norm, exclude = []) => exclude.some((e) => ` ${norm} `.includes(` ${normalizeHeader(e) || e} `) || (e === "%" && norm.includes("%")));

/** Maps headers to fields; each header is used once, best score wins. */
const mapHeaders = (headers) => {
  const norms = headers.map(normalizeHeader);
  const candidates = [];
  for (const [field, def] of Object.entries(FIELDS)) {
    norms.forEach((n, idx) => {
      if (!n || isExcluded(n, def.exclude)) return;
      const s = scoreAgainst(n, def.cands);
      if (s >= 70) candidates.push({ field, idx, score: s });
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  const used = new Set();
  const map = {};
  for (const c of candidates) {
    if (used.has(c.idx)) continue;
    const def = FIELDS[c.field];
    if (map[c.field] && !def.multi) continue;
    map[c.field] = map[c.field] ? [...map[c.field], c.idx] : [c.idx];
    used.add(c.idx);
  }
  return map;
};

const HEADER_SCAN_ROWS = 40;

/** Picks the sheet + header row that maps the most money fields. */
const locateTable = (wb) => {
  let best = null;
  for (const sheetName of wb.SheetNames) {
    const matrix = sheetToMatrix(wb, sheetName);
    const limit = Math.min(matrix.length, HEADER_SCAN_ROWS);
    for (let r = 0; r < limit; r++) {
      const row = matrix[r];
      if (isBlankRow(row)) continue;
      const textCells = row.filter((c) => typeof c === "string" && c.trim()).length;
      if (textCells < 3) continue;
      const headers = buildHeaders(row);
      const map = mapHeaders(headers);
      const hasAnchor = map.grossSales || map.netPayout;
      if (!hasAnchor) continue;
      const moneyFields = Object.keys(map).filter((f) => FIELDS[f].kind === "num").length;
      const score = moneyFields * 10 + Object.keys(map).length;
      const dataRows = matrix.length - r - 1;
      if (moneyFields >= 2 && dataRows > 0 && (!best || score > best.score)) {
        best = { sheetName, matrix, headerIdx: r, headers, map, score };
      }
    }
  }
  return best;
};

/** Fallback for vertical "Label | Value" summary statements. */
const parseSummaryLayout = (wb) => {
  for (const sheetName of wb.SheetNames) {
    const matrix = sheetToMatrix(wb, sheetName);
    const metrics = {};
    const textBlob = [];
    for (const row of matrix) {
      if (isBlankRow(row)) continue;
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (typeof cell !== "string" || !cell.trim()) continue;
        textBlob.push(cell);
        const n = normalizeHeader(cell);
        let matched = null;
        let matchedScore = 0;
        for (const [field, def] of Object.entries(FIELDS)) {
          if (def.kind !== "num" || isExcluded(n, def.exclude)) continue;
          const s = scoreAgainst(n, def.cands);
          if (s >= 85 && s > matchedScore) {
            matched = field;
            matchedScore = s;
          }
        }
        if (!matched) continue;
        const valueCell = row.slice(c + 1).find((v) => toNumber(v) !== null);
        if (valueCell === undefined) continue;
        const v = toNumber(valueCell);
        if (FIELDS[matched].multi) metrics[matched] = (metrics[matched] || 0) + v;
        else if (metrics[matched] === undefined) metrics[matched] = v;
      }
    }
    if ((metrics.grossSales || metrics.netPayout) && Object.keys(metrics).length >= 2) {
      return { sheetName, metrics, text: textBlob.join(" ") };
    }
  }
  return null;
};

const MONEY_FIELDS = Object.keys(FIELDS).filter((f) => FIELDS[f].kind === "num" && f !== "commissionRate" && f !== "orderCount");

const readCell = (row, idxs, kind) => {
  if (!idxs) return kind === "num" ? null : null;
  if (kind === "num") {
    let sum = null;
    for (const i of idxs) {
      const v = toNumber(row[i]);
      if (v !== null) sum = (sum || 0) + v;
    }
    return sum;
  }
  if (kind === "date") return toIsoDate(row[idxs[0]]);
  const v = row[idxs[0]];
  return v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim();
};

const detectPlatform = (fileName, sampleText) => {
  const f = String(fileName || "").toLowerCase();
  for (const p of ["swiggy", "zomato", "ownly"]) if (f.includes(p)) return p;
  const t = String(sampleText || "").toLowerCase();
  const counts = ["swiggy", "zomato", "ownly"].map((p) => [p, (t.match(new RegExp(p, "g")) || []).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : null;
};

const isWeeklyHint = (fileName, text) => /\bweek(ly)?\b|\bw[1-5]\b/i.test(`${fileName} ${text || ""}`);

/**
 * Parses a payout statement workbook.
 * Returns raw normalized lines; month/outlet resolution and aggregation are done by the service.
 */
const parsePayoutWorkbook = (wb, fileName) => {
  if (isSwiggyAnnexureWorkbook(wb)) return parseSwiggyAnnexureWorkbook(wb, fileName);
  if (isZomatoSettlementWorkbook(wb)) {
    try {
      return parseZomatoSettlementWorkbook(wb, fileName);
    } catch (err) {
      // Other Zomato exports (e.g. monthly annexures) share sheet names but not the order layout:
      // fall back to the generic statement reader unless the orders were found and failed verification.
      if (!err.zomatoNoOrders) throw err;
    }
  }

  const table = locateTable(wb);

  if (table) {
    const { sheetName, matrix, headerIdx, headers, map } = table;
    const lines = [];
    let skipped = 0;
    const sampleText = matrix.slice(0, Math.min(matrix.length, 60)).flat().filter((c) => typeof c === "string").join(" ");

    for (let r = headerIdx + 1; r < matrix.length; r++) {
      const row = matrix[r];
      if (isBlankRow(row) || isTotalRow(row)) continue;

      const line = { rowNumber: r + 1 };
      for (const [field, def] of Object.entries(FIELDS)) {
        line[field] = readCell(row, map[field], def.kind);
      }

      const hasMoney = MONEY_FIELDS.some((f) => line[f] !== null && line[f] !== 0);
      if (!hasMoney) {
        skipped++;
        continue;
      }

      const raw = {};
      headers.forEach((h, i) => {
        if (row[i] !== "" && row[i] !== undefined && row[i] !== null) raw[h] = row[i] instanceof Date ? toIsoDate(row[i]) : row[i];
      });
      line.raw = raw;
      lines.push(line);
    }

    if (lines.length === 0) {
      throw new AppError(`"${fileName}": header found on sheet "${sheetName}" (row ${headerIdx + 1}) but no payout rows contain amounts`, 422);
    }

    const columnMap = Object.fromEntries(Object.entries(map).map(([f, idxs]) => [f, idxs.map((i) => headers[i])]));
    return {
      layout: "tabular",
      sheetName,
      headerRow: headerIdx + 1,
      columnMap,
      lines,
      skippedRows: skipped,
      detectedPlatform: detectPlatform(fileName, sampleText),
      weeklyHint: isWeeklyHint(fileName, sampleText),
      sampleText,
    };
  }

  const summary = parseSummaryLayout(wb);
  if (summary) {
    const line = { rowNumber: null, raw: summary.metrics };
    for (const f of Object.keys(FIELDS)) line[f] = summary.metrics[f] ?? null;
    return {
      layout: "summary",
      sheetName: summary.sheetName,
      headerRow: null,
      columnMap: Object.fromEntries(Object.keys(summary.metrics).map((k) => [k, ["(label)"]])),
      lines: [line],
      skippedRows: 0,
      detectedPlatform: detectPlatform(fileName, summary.text),
      weeklyHint: isWeeklyHint(fileName, summary.text),
      sampleText: summary.text,
    };
  }

  throw new AppError(
    `"${fileName}": no payout table found. Expected columns such as Gross Sales / Item Total and Net Payout / Settlement Amount.`,
    422
  );
};

module.exports = { parsePayoutWorkbook, mapHeaders, FIELDS };
