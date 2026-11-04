const AppError = require("../../utils/AppError");
const { sheetToMatrix, normalizeHeader, toNumber, toIsoDate, isBlankRow, buildHeaders } = require("./spreadsheet.helper");
const { detectOutletFromItem, resolveOutletText, normalizeChannel } = require("./outlet.helper");

/**
 * Petpooja "Order Report: Sub-Order Wise" (and similar channel-level sales summaries):
 *   Restaurants | Order Type | Sub Order Type | Total no. of bills | My Amount | Total Discount |
 *   Net Sales (M.A - T.D) | Container Charge | Total Tax | Total Sales | Online Tax Calculated | GST Paid by Ecommerce
 * One row per restaurant × order type × sub order type (channel). Restaurant cell is blank when repeated.
 */
const FIELDS = {
  restaurant: ["restaurants", "restaurant", "outlet", "restaurant name"],
  orderType: ["order type"],
  subOrderType: ["sub order type", "suborder type", "sub order"],
  bills: ["total no of bills", "no of bills", "total bills", "bills", "order count"],
  myAmount: ["my amount", "gross amount", "my amount m a"],
  discount: ["total discount", "discount"],
  netSales: ["net sales", "net sales m a t d", "net amount"],
  containerCharge: ["container charge", "packaging charge"],
  totalTax: ["total tax"],
  totalSales: ["total sales", "grand total"],
  onlineTax: ["online tax calculated"],
  ecomGst: ["gst paid by ecommerce", "gst paid by e commerce"],
};

const matchField = (header, cands) => {
  const n = normalizeHeader(header).replace(/\s+/g, " ");
  let best = 0;
  for (const c of cands) {
    if (n === c) best = Math.max(best, 100);
    else if (n.startsWith(`${c} `)) best = Math.max(best, 90);
  }
  return best;
};

const mapHeaders = (headers) => {
  const map = {};
  const used = new Set();
  for (const [field, cands] of Object.entries(FIELDS)) {
    let bestIdx = -1;
    let bestScore = 0;
    headers.forEach((h, i) => {
      if (used.has(i)) return;
      const s = matchField(h, cands);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0) {
      map[field] = bestIdx;
      used.add(bestIdx);
    }
  }
  return map;
};

/** Returns { headerIdx, headers, map } when the sheet is a sub-order-wise channel summary, else null. */
const detectChannelSummary = (matrix) => {
  const limit = Math.min(matrix.length, 20);
  for (let r = 0; r < limit; r++) {
    if (isBlankRow(matrix[r])) continue;
    const headers = buildHeaders(matrix[r]);
    const map = mapHeaders(headers);
    if (map.subOrderType !== undefined && map.orderType !== undefined && map.netSales !== undefined && map.bills !== undefined) {
      return { headerIdx: r, headers, map };
    }
  }
  return null;
};

/** Reads "Date: 2026-10-01 to 2026-10-31" from the report preamble. */
const extractPeriod = (matrix, headerIdx) => {
  for (let r = 0; r < headerIdx; r++) {
    const text = (matrix[r] || []).map((c) => (c instanceof Date ? toIsoDate(c) : String(c ?? ""))).join(" ");
    const m = text.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\s*(?:to|-|–)\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})/i);
    if (m) {
      const from = toIsoDate(m[1]);
      const to = toIsoDate(m[2]);
      if (from && to && from <= to) return { from, to };
    }
  }
  return null;
};

const readReportName = (matrix, headerIdx) => {
  for (let r = 0; r < headerIdx; r++) {
    const row = matrix[r] || [];
    if (/^name:?$/i.test(String(row[0] || "").trim()) && row[1]) return String(row[1]).trim();
  }
  return null;
};

const isTotalLabel = (v) => /^(sub\s*total|total|grand\s*total)$/i.test(String(v ?? "").trim());

const brandFromSubOrder = (subOrder) => {
  const parts = String(subOrder).split(/\s*[-–—]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const left = parts.slice(0, -1).filter((p) => !/^w$/i.test(p)).join(" - ");
  return left.replace(/\s+w$/i, "").trim() || null;
};

const isSubOrderSummaryWorkbook = (wb) => {
  for (const name of wb.SheetNames) {
    const det = detectChannelSummary(sheetToMatrix(wb, name));
    if (det) return { sheetName: name, ...det };
  }
  return null;
};

/**
 * Parses a sub-order-wise summary into normalized channel sales rows and validates them against the report's Total row.
 */
const parseChannelSummaryWorkbook = (wb, fileName, { defaultPeriod } = {}) => {
  const found = isSubOrderSummaryWorkbook(wb);
  if (!found) throw new AppError(`"${fileName}" is not a sub-order-wise sales summary`, 422);
  const { sheetName, headerIdx, headers, map } = found;
  const matrix = sheetToMatrix(wb, sheetName);

  const period = extractPeriod(matrix, headerIdx) || defaultPeriod || null;
  if (!period) {
    throw new AppError(`"${fileName}": report period ("Date: YYYY-MM-DD to YYYY-MM-DD") not found. Send periodFrom/periodTo.`, 422);
  }

  const num = (row, f) => (map[f] === undefined ? 0 : toNumber(row[map[f]]) ?? 0);
  const txt = (row, f) => (map[f] === undefined ? "" : String(row[map[f]] ?? "").trim());

  const rows = [];
  const warnings = [];
  let reportTotal = null;
  const subTotals = [];
  let currentRestaurant = "";
  let currentOrderType = "";

  for (let r = headerIdx + 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (isBlankRow(row)) continue;

    const restaurantCell = txt(row, "restaurant");
    if (isTotalLabel(restaurantCell)) {
      const t = { label: restaurantCell, bills: num(row, "bills"), netSales: num(row, "netSales"), restaurant: currentRestaurant };
      if (/^sub/i.test(restaurantCell)) subTotals.push(t);
      else if (!reportTotal) reportTotal = t;
      continue;
    }

    if (restaurantCell) currentRestaurant = restaurantCell;
    const orderTypeCell = txt(row, "orderType");
    if (orderTypeCell) currentOrderType = orderTypeCell;
    const subOrderType = txt(row, "subOrderType");

    if (!currentRestaurant || !subOrderType) {
      warnings.push(`Row ${r + 1} skipped: missing restaurant or sub order type`);
      continue;
    }

    const outlet =
      resolveOutletText(currentRestaurant.split(",").pop()) ||
      detectOutletFromItem(subOrderType, "", currentOrderType).outlet;

    rows.push({
      sourceRow: r + 1,
      restaurant: currentRestaurant,
      orderType: currentOrderType,
      subOrderType,
      brand: brandFromSubOrder(subOrderType),
      channel: normalizeChannel(subOrderType),
      outlet,
      bills: Math.round(num(row, "bills")),
      myAmount: num(row, "myAmount"),
      discount: Math.abs(num(row, "discount")),
      netSales: num(row, "netSales"),
      containerCharge: num(row, "containerCharge"),
      totalTax: num(row, "totalTax"),
      totalSales: num(row, "totalSales"),
      onlineTax: num(row, "onlineTax"),
      ecomGst: num(row, "ecomGst"),
    });
  }

  if (rows.length === 0) throw new AppError(`"${fileName}": no channel rows found under the header`, 422);

  // Integrity check against the report's own totals
  const r2 = (n) => Math.round(n * 100) / 100;
  const sumNet = r2(rows.reduce((s, x) => s + x.netSales, 0));
  const sumBills = rows.reduce((s, x) => s + x.bills, 0);
  if (reportTotal) {
    if (Math.abs(sumNet - reportTotal.netSales) > 1 || sumBills !== Math.round(reportTotal.bills)) {
      throw new AppError(
        `"${fileName}": parsed rows (₹${sumNet}, ${sumBills} bills) do not match the report Total (₹${reportTotal.netSales}, ${reportTotal.bills} bills). File may be truncated or edited.`,
        422
      );
    }
  } else {
    warnings.push("Report has no Total row; totals could not be cross-checked.");
  }

  return {
    sheetName,
    headerRow: headerIdx + 1,
    columnMap: Object.fromEntries(Object.entries(map).map(([f, i]) => [f, headers[i]])),
    reportName: readReportName(matrix, headerIdx),
    period,
    rows,
    totals: { netSales: sumNet, bills: sumBills, reportTotal, subTotals },
    warnings,
  };
};

module.exports = { isSubOrderSummaryWorkbook, parseChannelSummaryWorkbook, brandFromSubOrder };
