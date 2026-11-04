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
const { detectOutletFromItem, resolveOutletText, normalizeChannel } = require("./outlet.helper");

const COLUMN_CANDIDATES = {
  itemName: ["item name", "item", "item description", "dish name", "dish", "product name", "product", "menu item", "particulars", "item_name"],
  variantName: ["variation", "variant", "item variation", "portion", "size", "variant name", "variation name", "portion name"],
  quantity: ["quantity", "qty", "qty sold", "total qty", "units", "quantity sold", "sold qty", "item qty", "count"],
  revenue: ["net sales", "net amount", "net total", "total amount", "item amount", "gross amount", "amount", "revenue", "total sales", "sales", "net value", "bill amount"],
  date: ["date", "bill date", "order date", "sales date", "transaction date", "invoice date", "order_date", "bill_date"],
  category: ["category", "item category", "menu category", "group", "sub category", "category name"],
  orderType: ["order type", "service type", "type", "delivery/dine-in", "order_type"],
  salesChannel: ["sales channel", "channel", "source", "platform", "aggregator", "order source"],
  discount: ["discount", "discount amount", "item discount", "disc"],
  returns: ["returns", "returned", "cancelled", "void", "refund", "return amount"],
  outlet: ["outlet", "branch", "store", "location", "restaurant name", "outlet name"],
};

const scoreHeader = (header, candidates) => {
  const norm = normalizeHeader(header);
  let best = 0;
  candidates.forEach((cand, i) => {
    const c = normalizeHeader(cand);
    // Earlier candidates are preferred (tie-break by list order)
    const bias = (candidates.length - i) / 1000;
    if (norm === c) best = Math.max(best, 100 + bias);
    else if (norm.startsWith(`${c} `) || norm.endsWith(` ${c}`)) best = Math.max(best, 85 + bias);
    else if (` ${norm} `.includes(` ${c} `)) best = Math.max(best, 70 + bias);
  });
  return best;
};

/** Greedy best-match column detection; one header is never assigned to two fields. */
const autoDetectMapping = (headers) => {
  const order = ["itemName", "quantity", "revenue", "date", "variantName", "category", "orderType", "salesChannel", "discount", "returns", "outlet"];
  const used = new Set();
  const mapping = {};
  for (const field of order) {
    let bestH = null;
    let bestS = 0;
    for (const h of headers) {
      if (used.has(h)) continue;
      const s = scoreHeader(h, COLUMN_CANDIDATES[field]);
      if (s >= 70 && s > bestS) {
        bestS = s;
        bestH = h;
      }
    }
    if (bestH) {
      mapping[field] = bestH;
      used.add(bestH);
    }
  }
  return mapping;
};

const extractRows = (matrix, layout) => {
  if (matrix.length === 0) return { headers: [], rows: [] };
  const headerIdx = Math.max(0, Math.min(matrix.length - 1, layout.headerRow - 1));
  const headers = buildHeaders(matrix[headerIdx]);
  const startIdx = Math.max(headerIdx + 1, Math.min(matrix.length, layout.dataStartRow - 1));
  const endIdx = Math.max(startIdx, matrix.length - (layout.skipFooterRows || 0));

  const rows = [];
  for (let r = startIdx; r < endIdx; r++) {
    const raw = matrix[r];
    if (isBlankRow(raw) || isTotalRow(raw)) continue;
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = raw[i] === undefined ? "" : raw[i];
    });
    rows.push({ rowNumber: r + 1, data: obj });
  }
  return { headers, rows };
};

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

/**
 * Parses one POS workbook into normalized sales records.
 * @returns {{ sheetName, headers, mapping, records, invalidRows, invalidSamples }}
 */
/** Finds the first row (within 40) whose cells map to item + quantity + revenue. */
const detectLayout = (matrix, sheetIndex = 0) => {
  const limit = Math.min(matrix.length, 40);
  for (let r = 0; r < limit; r++) {
    if (isBlankRow(matrix[r])) continue;
    const m = autoDetectMapping(buildHeaders(matrix[r]));
    if (m.itemName && m.quantity && m.revenue) {
      return { headerRow: r + 1, dataStartRow: r + 2, sheetIndex, skipFooterRows: 0, autoDetected: true };
    }
  }
  return null;
};

const parsePosWorkbook = (wb, fileName, { layout: inputLayout, mapping: inputMapping, outletOverrides = {}, defaultOutlet }) => {
  const sheetIdx = Math.max(0, Math.min(wb.SheetNames.length - 1, inputLayout?.sheetIndex || 0));
  const sheetName = wb.SheetNames[sheetIdx];
  const matrix = sheetToMatrix(wb, sheetName);
  const layout = inputLayout || detectLayout(matrix, sheetIdx);
  if (!layout) {
    throw new AppError(`"${fileName}": could not locate a header row with Item, Quantity and Amount columns. Provide a layout.`, 422);
  }
  const { headers, rows } = extractRows(matrix, layout);

  if (headers.length === 0 || rows.length === 0) {
    throw new AppError(`"${fileName}": no data rows found at header row ${layout.headerRow} / data row ${layout.dataStartRow}`, 422);
  }

  const detected = autoDetectMapping(headers);
  const mapping = { ...detected, ...(inputMapping || {}) };

  for (const [field, col] of Object.entries(mapping)) {
    if (col && !headers.includes(col)) {
      throw new AppError(`"${fileName}": mapped column "${col}" for "${field}" does not exist`, 422, { headers });
    }
  }
  const missing = ["itemName", "quantity", "revenue"].filter((f) => !mapping[f]);
  if (missing.length) {
    throw new AppError(`"${fileName}": could not detect required column(s): ${missing.join(", ")}. Provide a mapping.`, 422, {
      headers,
      detectedMapping: detected,
    });
  }

  const isNetSales = /net/i.test(mapping.revenue);
  const records = [];
  const invalidSamples = [];
  let invalidRows = 0;

  for (const { rowNumber, data } of rows) {
    const rawItem = str(data[mapping.itemName]);
    const rawVariant = mapping.variantName ? str(data[mapping.variantName]) : "";
    const qty = toNumber(data[mapping.quantity]);
    const rev = toNumber(data[mapping.revenue]);

    if (!rawItem || qty === null || rev === null) {
      invalidRows++;
      if (invalidSamples.length < 10) {
        invalidSamples.push({ row: rowNumber, reason: !rawItem ? "missing item name" : qty === null ? "invalid quantity" : "invalid revenue" });
      }
      continue;
    }

    const orderType = mapping.orderType ? str(data[mapping.orderType]) : "";
    const category = mapping.category ? str(data[mapping.category]) : "";
    const salesChannelCol = mapping.salesChannel ? str(data[mapping.salesChannel]) : "";

    let isReturn = qty < 0 || rev < 0;
    if (mapping.returns) {
      const rv = str(data[mapping.returns]).toLowerCase();
      const rn = toNumber(data[mapping.returns]);
      if (/return|cancel|void|refund|^yes$|^y$|^true$/.test(rv) || (rn !== null && rn !== 0)) isReturn = true;
    }

    const detection = detectOutletFromItem(rawItem, rawVariant, orderType, category);
    const override = outletOverrides[rawItem.toLowerCase()];
    let outlet = override || null;
    if (!outlet && mapping.outlet) outlet = resolveOutletText(data[mapping.outlet]);
    if (!outlet && defaultOutlet) outlet = defaultOutlet;
    if (!outlet) outlet = detection.outlet;

    const salesChannel = salesChannelCol || detection.channel || "";
    const discount = mapping.discount ? Math.abs(toNumber(data[mapping.discount]) || 0) : 0;
    const absRev = Math.abs(rev);

    records.push({
      sourceRow: rowNumber,
      rawItemName: rawItem,
      cleanItemName: detection.cleanItemName || rawItem,
      rawVariantName: rawVariant || null,
      quantity: Math.abs(qty),
      revenue: absRev,
      isNetSales,
      saleDate: mapping.date ? toIsoDate(data[mapping.date]) : null,
      category: category || null,
      orderType: orderType || null,
      salesChannel: salesChannel || null,
      channel: normalizeChannel(salesChannel, orderType, rawItem),
      discount,
      returnAmount: isReturn ? absRev : 0,
      outlet,
      isReturn,
    });
  }

  if (records.length === 0) {
    throw new AppError(`"${fileName}": no valid sales rows could be extracted`, 422, { invalidSamples, mapping });
  }

  return { sheetName, layout, headers, mapping, records, invalidRows, invalidSamples };
};

const rowSignature = (r) =>
  [r.saleDate || "nodate", r.rawItemName, r.rawVariantName || "", r.quantity, r.revenue.toFixed(2), r.outlet || "", r.isReturn ? "R" : "S"].join("|");

module.exports = { parsePosWorkbook, autoDetectMapping, rowSignature, COLUMN_CANDIDATES };
