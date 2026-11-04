const AppError = require("../../utils/AppError");
const { sheetToMatrix, normalizeHeader, toNumber, toIsoDate } = require("./spreadsheet.helper");

/**
 * Swiggy payout annexure (weekly / monthly_annexure_<resId>_<date>.xlsx):
 * sheets "Payout Breakup", "Order Level", "Growth Investment Other Charges", "Discount Summary".
 * Order Level has Swiggy's numbered columns (1)…(24),(A),(W),(B),(C),(D),(E). Columns are matched by header text.
 * Every order must reproduce Swiggy's "Net Payout (after taxes)", and the order total must match the
 * Payout Breakup "Net Payout" total, otherwise the file is rejected.
 */
const COLS = {
  orderId: /^order id$/,
  orderDate: /^order date$/,
  orderStatus: /^order status$/,
  orderCategory: /^order category$/,
  itemTotal: /^item s total$/,
  packing: /^packing charges$/,
  restaurantDiscount: /^restaurant discount share/,
  gstCollected: /^gst collected$/,
  deliveryFee: /^delivery fee$/,
  deliveryFeeDiscount: /^discount on delivery fee$/,
  gstOnDeliveryFee: /^gst on delivery fee$/,
  commission: /^commission$/,
  longDistance: /^long distance charges$/,
  longDistanceDiscount: /^discount on long distance fee$/,
  pocketHero: /^pocket hero fees$/,
  swiggyOne: /^swiggy one fees$/,
  paymentCollection: /^payment collection charges$/,
  restaurantCancellation: /^restaurant cancellation charges$/,
  callCenter: /^call center charges$/,
  deliverySponsored: /^delivery fee sponsored by restaurant/,
  boltFees: /^bolt fees$/,
  gstOnServiceFee: /^gst on service fee/,
  customerCancellations: /^customer cancellations$/,
  customerComplaints: /^customer complaints$/,
  gstDeduction: /^gst deduction$/,
  tcs: /^tcs$/,
  tds: /^tds$/,
  netPayout: /^net payout after taxes/,
};
const REQUIRED = ["orderId", "orderDate", "itemTotal", "commission", "netPayout"];

const findOrderTable = (wb) => {
  const sheet = wb.SheetNames.find((n) => /^order level$/i.test(n.trim()));
  if (!sheet) return null;
  const matrix = sheetToMatrix(wb, sheet);
  for (let r = 0; r < Math.min(matrix.length, 10); r++) {
    const norms = (matrix[r] || []).map((c) => normalizeHeader(c));
    if (!norms.includes("order id") || !norms.includes("item s total")) continue;
    const idx = {};
    for (const [k, re] of Object.entries(COLS)) {
      const i = norms.findIndex((n) => re.test(n));
      if (i >= 0) idx[k] = i;
    }
    if (REQUIRED.every((k) => idx[k] !== undefined)) return { sheet, matrix, headerIdx: r, idx };
  }
  return null;
};

const isSwiggyAnnexureWorkbook = (wb) =>
  wb.SheetNames.some((n) => /^payout breakup$/i.test(n.trim())) && Boolean(findOrderTable(wb));

/** Reads the "Total" column of labelled rows in Payout Breakup. */
const readBreakup = (wb) => {
  const sheet = wb.SheetNames.find((n) => /^payout breakup$/i.test(n.trim()));
  const out = {};
  if (!sheet) return out;
  const matrix = sheetToMatrix(wb, sheet);
  let totalCol = -1;
  for (const row of matrix) {
    const ti = row.findIndex((c) => /^total$/i.test(String(c).trim()));
    if (ti >= 0 && row.some((c) => /particulars/i.test(String(c)))) {
      totalCol = ti;
      break;
    }
  }
  if (totalCol < 0) return out;
  for (const row of matrix) {
    const label = row.find((c) => typeof c === "string" && c.trim());
    if (!label) continue;
    const v = toNumber(row[totalCol]);
    if (v !== null) out[normalizeHeader(label)] = v;
  }
  return out;
};

const resIdFromFileName = (fileName) => {
  const m = String(fileName).match(/annexure_(\d{4,})/i) || String(fileName).match(/_(\d{5,})_/);
  return m ? m[1] : null;
};

const parseSwiggyAnnexureWorkbook = (wb, fileName) => {
  const { sheet, matrix, headerIdx, idx } = findOrderTable(wb);
  const n = (row, k) => (idx[k] === undefined ? 0 : toNumber(row[idx[k]]) ?? 0);
  const s = (row, k) => (idx[k] === undefined ? null : String(row[idx[k]] ?? "").trim() || null);
  const accountId = resIdFromFileName(fileName);

  const lines = [];
  const mismatches = [];
  for (let r = headerIdx + 1; r < matrix.length; r++) {
    const row = matrix[r];
    const orderId = s(row, "orderId");
    if (!orderId || !/^\d{6,}$/.test(orderId)) continue;

    const gross = n(row, "itemTotal") + n(row, "packing") + n(row, "deliveryFee");
    const discounts = n(row, "restaurantDiscount") + n(row, "deliveryFeeDiscount");
    const commission =
      n(row, "commission") + n(row, "longDistance") - n(row, "longDistanceDiscount") + n(row, "pocketHero") + n(row, "swiggyOne");
    const pg = n(row, "paymentCollection");
    const cancellation = n(row, "restaurantCancellation") + n(row, "customerCancellations");
    // GST Swiggy remits under 9(5) offsets the GST collected from the customer; only a difference is a cost
    const other =
      n(row, "callCenter") + n(row, "deliverySponsored") + n(row, "boltFees") + n(row, "customerComplaints") +
      (n(row, "gstDeduction") - n(row, "gstCollected") - n(row, "gstOnDeliveryFee"));
    const gstFee = n(row, "gstOnServiceFee");
    const tcs = n(row, "tcs");
    const tds = n(row, "tds");
    const payout = toNumber(row[idx.netPayout]);

    const calc = gross - discounts - commission - pg - cancellation - other - gstFee - tcs - tds;
    if (payout === null || Math.abs(calc - payout) > 0.05) {
      mismatches.push({ row: r + 1, orderId, computed: Math.round(calc * 100) / 100, swiggy: payout });
      continue;
    }

    const status = s(row, "orderStatus");
    lines.push({
      rowNumber: r + 1,
      orderId,
      orderDate: toIsoDate(row[idx.orderDate]),
      payoutDate: null,
      outlet: null,
      accountId,
      weekLabel: null,
      orderStatus: status,
      orderCount: status && /deliver/i.test(status) ? 1 : 0,
      grossSales: gross,
      customerDiscounts: discounts,
      commissionAmount: commission,
      commissionRate: null,
      paymentGatewayFee: pg,
      deliveryChargesCollected: 0,
      advertisingSpend: 0,
      cancellationCharges: cancellation,
      otherPlatformFees: other,
      gstOnCommission: gstFee,
      tcsDeduction: tcs,
      tdsDeduction: tds,
      hyperpureRecovery: 0,
      netPayout: payout,
      raw: { category: s(row, "orderCategory") },
    });
  }

  if (mismatches.length) {
    throw new AppError(
      `"${fileName}": ${mismatches.length} Swiggy order(s) did not reconcile with Swiggy's order-level net payout. The report format may have changed.`,
      422,
      mismatches.slice(0, 10)
    );
  }
  if (lines.length === 0) throw new AppError(`"${fileName}": the Order Level sheet has no orders`, 422);

  // Restaurant-level charges (ads, other charges/refunds) from Payout Breakup
  const breakup = readBreakup(wb);
  const ads = Math.abs(breakup["growth investment in ads"] || 0);
  const otherCharges = -(breakup["other charges and refunds"] || 0); // negative in sheet = deduction
  if (ads || otherCharges) {
    lines.push({
      rowNumber: null,
      orderId: null,
      orderDate: lines[0].orderDate,
      payoutDate: null,
      outlet: null,
      accountId,
      weekLabel: null,
      orderStatus: "RESTAURANT_LEVEL",
      orderCount: 0,
      grossSales: 0,
      customerDiscounts: 0,
      commissionAmount: 0,
      paymentGatewayFee: 0,
      deliveryChargesCollected: 0,
      advertisingSpend: ads,
      cancellationCharges: 0,
      otherPlatformFees: otherCharges,
      gstOnCommission: 0,
      tcsDeduction: 0,
      tdsDeduction: 0,
      hyperpureRecovery: 0,
      netPayout: -(ads + otherCharges),
      raw: { source: "Payout Breakup" },
    });
  }

  const notes = [];
  const sheetTotal = breakup["net payout"];
  const ourTotal = lines.reduce((sum, l) => sum + l.netPayout, 0);
  if (sheetTotal !== undefined) {
    if (Math.abs(sheetTotal - ourTotal) > 1) {
      throw new AppError(
        `"${fileName}": orders add up to ₹${ourTotal.toFixed(2)} but Payout Breakup Net Payout is ₹${sheetTotal.toFixed(2)}.`,
        422
      );
    }
  } else {
    notes.push("Payout Breakup total not found; order totals could not be cross-checked.");
  }

  const monthly = /monthly/i.test(fileName);
  return {
    layout: "tabular",
    signedAmounts: true, // amounts are already normalised (deductions positive, refunds negative)
    sheetName: sheet,
    headerRow: headerIdx + 1,
    columnMap: { format: "swiggy_annexure_order_level" },
    lines,
    skippedRows: 0,
    detectedPlatform: "swiggy",
    weeklyHint: !monthly && /week/i.test(fileName),
    statedPeriodType: monthly ? "monthly" : /week/i.test(fileName) ? "weekly" : null,
    sampleText: "",
    notes,
  };
};

module.exports = { isSwiggyAnnexureWorkbook, parseSwiggyAnnexureWorkbook };