const AppError = require("../../utils/AppError");
const { sheetToMatrix, normalizeHeader, toNumber, toIsoDate, extractMonthFromText } = require("./spreadsheet.helper");

/**
 * Zomato "Settlement Report" workbook (sheets: Summary, Payout Breakup, Order Level, Addition Deductions Details, …).
 * Order Level columns follow Zomato's Payout Breakup numbering (1)…(23). Headers are often missing in exports,
 * so columns are matched by name when a header row exists and by Zomato's fixed position otherwise.
 * Every order is verified: computed payout must equal Zomato's order-level payout, or the file is rejected.
 */
const COLS = {
  orderId: { pos: 1, re: /^order id$/ },
  orderDate: { pos: 2, re: /^order date/ },
  week: { pos: 3, re: /^week/ },
  resName: { pos: 4, re: /^res(taurant)? name/ },
  resId: { pos: 5, re: /^res(taurant)? id/ },
  orderStatus: { pos: 8, re: /^order status/ },
  subtotal: { pos: 14, re: /^subtotal/ },
  packaging: { pos: 15, re: /^packaging charge$/ },
  deliverySelf: { pos: 16, re: /^delivery charge for restaurants/ },
  discountPromo: { pos: 17, re: /^restaurant discount promo/ },
  discountOther: { pos: 18, re: /^restaurant discount bogo/ },
  brandPack: { pos: 19, re: /^brand pack subscription/ },
  deliveryDiscount: { pos: 20, re: /^delivery charge discount/ },
  gstCollected: { pos: 21, re: /^total gst collected/ },
  netOrderValue: { pos: 22, re: /^net order value/ },
  baseServiceFee: { pos: 28, re: /^base service fee$/ },
  longDistanceFee: { pos: 30, re: /^long distance enablement fee$/ },
  longDistanceDiscount: { pos: 31, re: /^discount on long distance/ },
  capDiscount: { pos: 32, re: /^discount on service fee due to 30/ },
  paymentMechanismFee: { pos: 33, re: /^payment mechanism fee$/ },
  serviceFeesTotal: { pos: 34, re: /^service fees? (and )?payment mechanism fees?/ },
  taxOnServiceFee: { pos: 35, re: /^taxes on service fee/ },
  tcs: { pos: 38, re: /^tax collected at source/ },
  tds: { pos: 40, re: /^tds 194o/ },
  gst95: { pos: 41, re: /^gst paid by zomato/ },
  otherDeductionsFrom: { pos: 44 },
  otherDeductionsTo: { pos: 51 },
  totalDeductions: { pos: 53, re: /^net deductions/ },
  netAdditions: { pos: 54, re: /^net additions/ },
  cashReceived: { pos: 54, re: /^amount received in cash/ },
  orderPayout: { pos: 55, re: /^order level payout/ },
  settlementStatus: { pos: 56, re: /^settlement status/ },
  settlementDate: { pos: 57, re: /^settlement date/ },
  utr: { pos: 58, re: /^bank utr/ },
};

const ORDER_LEVEL = /^order level$/i;

const isZomatoSettlementWorkbook = (wb) => {
  const names = wb.SheetNames.map((n) => n.trim().toLowerCase());
  return names.includes("order level") && names.includes("payout breakup");
};

const isOrderRow = (row) => /^\d{6,}$/.test(String(row[1] ?? "").trim()) && Boolean(toIsoDate(row[2]));

const buildIndex = (matrix) => {
  for (let r = 0; r < Math.min(matrix.length, 15); r++) {
    const norms = (matrix[r] || []).map((c) => normalizeHeader(c));
    if (!norms.includes("order id")) continue;
    const idx = {};
    for (const [k, def] of Object.entries(COLS)) {
      const i = def.re ? norms.findIndex((n) => def.re.test(n)) : -1;
      idx[k] = i >= 0 ? i : def.pos;
    }
    return { idx, headerRow: r + 1, mode: "header" };
  }
  return { idx: Object.fromEntries(Object.entries(COLS).map(([k, d]) => [k, d.pos])), headerRow: null, mode: "position" };
};

const readMeta = (wb) => {
  const sheet = wb.SheetNames.find((n) => /^hsummary$/i.test(n.trim()));
  const meta = { period: null, resId: null, resName: null, frequency: null };
  if (sheet) {
    const row = sheetToMatrix(wb, sheet)[0] || [];
    meta.period = String(row[0] || "").trim() || null;
    meta.resId = String(row[1] || "").trim() || null;
    meta.resName = String(row[4] || "").trim() || null;
    meta.frequency = String(row[9] || "").trim() || null;
  }
  return meta;
};

const parsePeriod = (text) => {
  const m = String(text || "").match(/(\d{1,2}\s+[a-z]{3,9}\s+\d{4})\s*[-–]\s*(\d{1,2}\s+[a-z]{3,9}\s+\d{4})/i);
  if (!m) return null;
  const from = toIsoDate(m[1]);
  const to = toIsoDate(m[2]);
  return from && to ? { from, to } : null;
};

/** Adjusted (already recovered) ads / Hyperpure amounts from the Addition Deductions annexure. */
const readAnnexure = (wb) => {
  const sheet = wb.SheetNames.find((n) => /addition deductions/i.test(n));
  const out = { adsAdjusted: 0, hyperpureAdjusted: 0, outstanding: [] };
  if (!sheet) return out;
  let section = "";
  for (const row of sheetToMatrix(wb, sheet)) {
    const label = String(row[0] ?? "").trim();
    if (/^a\)/i.test(label)) section = "ads";
    else if (/^b\)/i.test(label)) section = "hyperpure";
    else if (/^[c-z]\)/i.test(label)) section = "other";
    if (!label || /^total|^type$/i.test(label) || /^[a-z]\)/i.test(label)) continue;
    const adjusted = toNumber(row[6]) || 0;
    const outstanding = toNumber(row[7]) || 0;
    if (section === "ads") out.adsAdjusted += adjusted;
    if (section === "hyperpure") out.hyperpureAdjusted += adjusted;
    if (outstanding > 0) out.outstanding.push(`${label} ${row[3] || ""} ₹${outstanding.toFixed(2)} (${row[4] || "pending"})`.replace(/\s+/g, " "));
  }
  return out;
};

const parseZomatoSettlementWorkbook = (wb, fileName) => {
  const sheetName = wb.SheetNames.find((n) => ORDER_LEVEL.test(n.trim()));
  const matrix = sheetToMatrix(wb, sheetName);
  const { idx, headerRow, mode } = buildIndex(matrix);
  const meta = readMeta(wb);
  const period = parsePeriod(meta.period);
  const annexure = readAnnexure(wb);
  const n = (row, key) => toNumber(row[idx[key]]) ?? 0;
  const s = (row, key) => {
    const v = String(row[idx[key]] ?? "").trim();
    return v && v.toUpperCase() !== "NA" ? v : null;
  };

  const lines = [];
  const mismatches = [];
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row || !isOrderRow(row)) continue;

    const gross = n(row, "subtotal") + n(row, "packaging") + n(row, "deliverySelf") + n(row, "brandPack");
    const discounts = n(row, "discountPromo") + n(row, "discountOther") + n(row, "deliveryDiscount");
    const serviceFee = n(row, "baseServiceFee") + n(row, "longDistanceFee") - n(row, "longDistanceDiscount") - n(row, "capDiscount");
    const pmf = n(row, "paymentMechanismFee");
    let other = 0;
    for (let c = idx.otherDeductionsFrom; c <= idx.otherDeductionsTo; c++) other += toNumber(row[c]) || 0;
    other += n(row, "cashReceived");
    other += n(row, "gst95") - n(row, "gstCollected"); // GST under 9(5) is collected and remitted; only a difference is a cost
    const payout = toNumber(row[idx.orderPayout]);

    const calc = gross - discounts - serviceFee - pmf - n(row, "taxOnServiceFee") - n(row, "tcs") - n(row, "tds") - other;
    // Zomato's own identity for the order: Net order value - Net deductions + Net additions = Order payout
    const viaTotals =
      toNumber(row[idx.netOrderValue]) !== null && toNumber(row[idx.totalDeductions]) !== null
        ? n(row, "netOrderValue") - n(row, "totalDeductions") + n(row, "netAdditions")
        : null;
    // Cancelled / rejected orders: Zomato pays only the cancellation refund (Net additions)
    const isCancelled = /cancel|reject/i.test(String(row[idx.orderStatus] ?? ""));
    const cancelRefundOk = isCancelled && payout !== null && Math.abs(n(row, "netAdditions") - payout) <= 0.05;
    const reconciles =
      payout !== null &&
      (cancelRefundOk || Math.abs(calc - payout) <= 0.05 || (viaTotals !== null && Math.abs(viaTotals - payout) <= 0.05));
    if (!reconciles) {
      mismatches.push({ row: r + 1, orderId: s(row, "orderId"), computed: Math.round(calc * 100) / 100, zomato: payout });
      continue;
    }

    const status = s(row, "orderStatus");
    lines.push({
      rowNumber: r + 1,
      orderId: s(row, "orderId"),
      orderDate: toIsoDate(row[idx.orderDate]),
      payoutDate: toIsoDate(row[idx.settlementDate]),
      outlet: s(row, "resName") || meta.resName,
      accountId: s(row, "resId") || meta.resId,
      weekLabel: meta.period,
      orderStatus: status,
      orderCount: status && /deliver/i.test(status) ? 1 : 0,
      // A cancelled order is not a sale; only its refund (the payout) counts
      grossSales: cancelRefundOk ? 0 : gross,
      customerDiscounts: cancelRefundOk ? 0 : discounts,
      commissionAmount: cancelRefundOk ? 0 : serviceFee,
      commissionRate: null,
      paymentGatewayFee: cancelRefundOk ? 0 : pmf,
      deliveryChargesCollected: 0,
      advertisingSpend: 0,
      cancellationCharges: 0,
      otherPlatformFees: cancelRefundOk ? 0 : other,
      gstOnCommission: cancelRefundOk ? 0 : n(row, "taxOnServiceFee"),
      tcsDeduction: cancelRefundOk ? 0 : n(row, "tcs"),
      tdsDeduction: cancelRefundOk ? 0 : n(row, "tds"),
      hyperpureRecovery: 0,
      netPayout: payout,
      raw: {
        settlementStatus: s(row, "settlementStatus"),
        utr: s(row, "utr"),
        netOrderValue: n(row, "netOrderValue"),
        gstCollected: n(row, "gstCollected"),
        totalDeductions: toNumber(row[idx.totalDeductions]),
      },
    });
  }

  if (mismatches.length) {
    throw new AppError(
      `"${fileName}": ${mismatches.length} Zomato order(s) did not reconcile with Zomato's order-level payout (column layout ${mode === "header" ? "from headers" : "by position"}). The report format may have changed.`,
      422,
      mismatches.slice(0, 10)
    );
  }
  if (lines.length === 0) {
    const err = new AppError(`"${fileName}": the Order Level sheet has no orders`, 422);
    err.zomatoNoOrders = true;
    throw err;
  }

  // Ads / Hyperpure already recovered in this settlement
  if (annexure.adsAdjusted > 0 || annexure.hyperpureAdjusted > 0) {
    const first = lines[0];
    lines.push({
      rowNumber: null,
      orderId: null,
      orderDate: period?.to || first.orderDate,
      payoutDate: null,
      outlet: first.outlet,
      accountId: first.accountId,
      weekLabel: meta.period,
      orderStatus: "ANNEXURE",
      orderCount: 0,
      grossSales: 0,
      customerDiscounts: 0,
      commissionAmount: 0,
      paymentGatewayFee: 0,
      deliveryChargesCollected: 0,
      advertisingSpend: annexure.adsAdjusted,
      cancellationCharges: 0,
      otherPlatformFees: 0,
      gstOnCommission: 0,
      tcsDeduction: 0,
      tdsDeduction: 0,
      hyperpureRecovery: annexure.hyperpureAdjusted,
      netPayout: -(annexure.adsAdjusted + annexure.hyperpureAdjusted),
      raw: { source: "Addition Deductions Details" },
    });
  }

  const notes = annexure.outstanding.map((o) => `Not yet deducted (outstanding): ${o}`);
  const weekly = /weekly/i.test(meta.frequency || "") || /week/i.test(fileName);

  return {
    layout: "tabular",
    signedAmounts: true, // amounts are already normalised (deductions positive, refunds negative)
    sheetName,
    headerRow,
    columnMap: { format: "zomato_settlement_order_level", mode },
    lines,
    skippedRows: 0,
    detectedPlatform: "zomato",
    weeklyHint: weekly,
    statedPeriodType: /weekly/i.test(meta.frequency || "") ? "weekly" : /monthly/i.test(meta.frequency || "") ? "monthly" : null,
    sampleText: `${meta.period || ""} ${extractMonthFromText(meta.period) || ""}`,
    notes,
    period,
  };
};

module.exports = { isZomatoSettlementWorkbook, parseZomatoSettlementWorkbook };