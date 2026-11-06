const path = require("path");
const crypto = require("crypto");
const { supabaseAdmin } = require("../../utils/supabaseClient");
const AppError = require("../../utils/AppError");
const { SETTLEMENT_TOLERANCE } = require("../../config/constant");
const { sha256, readWorkbook, extractMonthFromText } = require("../helpers/spreadsheet.helper");
const { parsePayoutWorkbook } = require("../helpers/payoutParser.helper");
const { resolveOutletText, detectOutletFromItem } = require("../helpers/outlet.helper");
const { dbError, paginate, assertUniqueInRequest } = require("./batch.service");
const { resolveTenant } = require("./tenant.service");

/** Aggregator payout statements → existing table platform_payout_reconciliation
 *  (one row per restaurant × outlet × month × platform; weekly statements accumulate into the month row). */
const PAYOUT_TABLE = "platform_payout_reconciliation";
const STATUS_TO_DB = { reconciled: "Reconciled", discrepancy: "Discrepancy", pending: "Pending" };
const STATUS_FROM_DB = { reconciled: "reconciled", discrepancy: "discrepancy", pending: "pending" };
const MAX_REFS = 11; // 11 x 8-char refs + commas fit payout_reference_id (100)

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 10000) / 10000;
const abs = (n) => Math.abs(Number(n || 0));

const DEDUCTIONS = [
  "commission_amount",
  "payment_gateway_fee",
  "advertising_spend",
  "cancellation_charges",
  "other_platform_fees",
  "gst_on_commission",
  "tcs_deduction",
  "tds_deduction",
  "hyperpure_recovery",
];
const SUM_FIELDS = ["gross_sales", "customer_discounts", "delivery_charges_collected", ...DEDUCTIONS];

/** Resolves platform, period, month and outlet for every parsed line. No values are invented. */
const resolveLines = (parsed, file, opts) => {
  const warnings = [...(parsed.notes || [])];
  const platform = opts.platform || parsed.detectedPlatform;
  if (!platform) {
    throw new AppError(`"${file.originalname}": platform could not be detected. Send platform=swiggy|zomato|ownly.`, 422);
  }
  // A period stated inside the statement itself (e.g. Zomato "Pay-out cycle: Weekly", Swiggy "monthly_annexure")
  // wins over the UI toggle; otherwise the user's choice, otherwise the file-name hint.
  const periodType = parsed.statedPeriodType || opts.periodType || (parsed.weeklyHint ? "weekly" : "monthly");
  const baseName = path.basename(file.originalname, path.extname(file.originalname));
  const fileMonth = extractMonthFromText(baseName) || extractMonthFromText(parsed.sampleText);
  const fileOutlet = resolveOutletText(baseName.replace(/[_]+/g, " "));

  const mag = parsed.signedAmounts ? (v) => Number(v || 0) : abs;
  let defaultedOutlet = 0;
  const unresolvedMonthRows = [];

  const lines = parsed.lines.map((l) => {
    const month =
      opts.month ||
      (l.orderDate && l.orderDate.slice(0, 7)) ||
      (l.payoutDate && l.payoutDate.slice(0, 7)) ||
      extractMonthFromText(l.weekLabel) ||
      fileMonth;
    if (!month) unresolvedMonthRows.push(l.rowNumber);

    let outlet =
      opts.outletId ||
      resolveOutletText(l.outlet) ||
      (l.outlet ? detectOutletFromItem(String(l.outlet).trim()).outlet : null) ||
      fileOutlet;
    if (!outlet) {
      outlet = "banaswadi";
      defaultedOutlet++;
    }

    return {
      platform,
      source_row: l.rowNumber,
      order_id: l.orderId ? String(l.orderId).slice(0, 100) : null,
      order_date: l.orderDate,
      payout_date: l.payoutDate,
      month,
      week_label: periodType === "weekly" ? opts.weekLabel || l.weekLabel || null : null,
      outlet_id: outlet,
      account_id: l.accountId ? String(l.accountId).slice(0, 100) : null,
      order_status: l.orderStatus ? String(l.orderStatus).slice(0, 50) : null,
      order_count: Number.isFinite(l.orderCount) ? Math.max(0, Math.round(l.orderCount)) : parsed.layout === "tabular" ? 1 : 0,
      gross_sales: round4(l.grossSales),
      customer_discounts: round4(mag(l.customerDiscounts)),
      commission_amount: round4(mag(l.commissionAmount)),
      payment_gateway_fee: round4(mag(l.paymentGatewayFee)),
      delivery_charges_collected: round4(mag(l.deliveryChargesCollected)),
      advertising_spend: round4(mag(l.advertisingSpend)),
      cancellation_charges: round4(mag(l.cancellationCharges)),
      other_platform_fees: round4(mag(l.otherPlatformFees)),
      gst_on_commission: round4(mag(l.gstOnCommission)),
      tcs_deduction: round4(mag(l.tcsDeduction)),
      tds_deduction: round4(mag(l.tdsDeduction)),
      hyperpure_recovery: round4(mag(l.hyperpureRecovery)),
      net_payout: l.netPayout === null || l.netPayout === undefined ? null : round4(l.netPayout),
      raw: l.raw || {},
    };
  });

  if (unresolvedMonthRows.length) {
    throw new AppError(
      `"${file.originalname}": statement month could not be determined for ${unresolvedMonthRows.length} row(s). Send month=YYYY-MM.`,
      422,
      { rows: unresolvedMonthRows.slice(0, 20) }
    );
  }
  if (defaultedOutlet) {
    warnings.push(`${defaultedOutlet} row(s) had no outlet information and were assigned to banaswadi. Send outletId to override.`);
  }

  return { platform, periodType, lines, warnings };
};

/** Aggregates persisted lines into one payout statement per outlet / month / week. */
const aggregate = (lines, { platform, periodType, fileName }) => {
  const groups = new Map();
  for (const l of lines) {
    const key = `${l.outlet_id}|${l.month}|${l.week_label || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        outlet_id: l.outlet_id,
        month: l.month,
        week_label: l.week_label || null,
        account_id: null,
        payout_date: null,
        order_count: 0,
        net_payout_sum: 0,
        has_net_payout: false,
        ...Object.fromEntries(SUM_FIELDS.map((f) => [f, 0])),
      });
    }
    const g = groups.get(key);
    for (const f of SUM_FIELDS) g[f] += Number(l[f] || 0);
    g.order_count += Number(l.order_count || 0);
    if (l.net_payout !== null && l.net_payout !== undefined) {
      g.net_payout_sum += Number(l.net_payout);
      g.has_net_payout = true;
    }
    g.account_id = g.account_id || l.account_id || null;
    if (l.payout_date && (!g.payout_date || l.payout_date > g.payout_date)) g.payout_date = l.payout_date;
  }

  return [...groups.values()].map((g) => {
    const netSales = g.gross_sales - g.customer_discounts;
    const deductions = DEDUCTIONS.reduce((s, f) => s + g[f], 0);
    const calculated = round2(netSales - deductions);
    const actual = g.has_net_payout ? round2(g.net_payout_sum) : null;
    const diff = actual === null ? null : round2(actual - calculated);
    const status = actual === null ? "pending" : Math.abs(diff) <= SETTLEMENT_TOLERANCE ? "reconciled" : "discrepancy";

    return {
      outlet_id: g.outlet_id,
      month: g.month,
      platform,
      period_type: periodType,
      week_label: g.week_label,
      payout_date: g.payout_date,
      account_id: g.account_id,
      gross_sales: round2(g.gross_sales),
      customer_discounts: round2(g.customer_discounts),
      net_sales: round2(netSales),
      order_count: g.order_count,
      commission_rate: g.gross_sales > 0 ? Math.round((g.commission_amount / g.gross_sales) * 100000) / 1000 : 0,
      commission_amount: round2(g.commission_amount),
      payment_gateway_fee: round2(g.payment_gateway_fee),
      delivery_charges_collected: round2(g.delivery_charges_collected),
      customer_delivery_fee_share: 0,
      advertising_spend: round2(g.advertising_spend),
      cancellation_charges: round2(g.cancellation_charges),
      other_platform_fees: round2(g.other_platform_fees),
      gst_on_commission: round2(g.gst_on_commission),
      tcs_deduction: round2(g.tcs_deduction),
      tds_deduction: round2(g.tds_deduction),
      hyperpure_recovery: round2(g.hyperpure_recovery),
      calculated_net_payout: calculated,
      actual_bank_settlement: actual,
      settlement_difference: diff,
      status,
      source_file_name: fileName,
    };
  });
};


const toClientPayout = (p) => {
  const gross = Number(p.gross_sales_reported);
  const commission = Number(p.commission_deducted);
  return {
    id: p.id,
    batchId: p.id,
    outletId: p.outlet_id,
    month: p.month_year,
    platform: p.platform,
    grossSales: gross,
    customerDiscounts: Number(p.customer_discounts_borne),
    netSales: Number(p.net_platform_sales),
    orderCount: Number(p.order_count || 0),
    commissionRate: gross > 0 ? Math.round((commission / gross) * 100000) / 1000 : 0,
    commissionAmount: commission,
    paymentGatewayFee: 0,
    deliveryChargesCollected: 0,
    customerDeliveryFeeShare: 0,
    advertisingSpend: Number(p.marketing_ad_deductions),
    cancellationCharges: Number(p.cancellation_charges),
    otherPlatformFees: Number(p.other_deductions),
    gstOnCommission: Number(p.gst_on_commission),
    tcsDeduction: Number(p.tcs_tds_deducted),
    tdsDeduction: 0,
    hyperpureRecovery: Number(p.hyperpure_recovery || 0),
    calculatedNetPayout: Number(p.net_bank_settlement),
    actualBankSettlement: Number(p.actual_bank_credit_received || 0),
    settlementDifference: Number(p.settlement_variance || 0),
    status: STATUS_FROM_DB[String(p.settlement_status || "").toLowerCase()] || "pending",
    periodType: p.period_type || "monthly",
    weekLabel: p.week_label || undefined,
    sourceFileName: undefined,
    directSalesCashUpi: Number(p.direct_sales_cash_upi || 0),
  };
};

/** Folds weekly groups of the same outlet + month into one month row (table key has no week). */
const foldByMonth = (aggregated) => {
  const out = new Map();
  for (const p of aggregated) {
    const key = `${p.outlet_id}|${p.month}`;
    if (!out.has(key)) {
      out.set(key, { ...p, week_labels: p.week_label ? [p.week_label] : [], has_actual: p.actual_bank_settlement !== null });
      continue;
    }
    const g = out.get(key);
    for (const f of ["gross_sales", "customer_discounts", "net_sales", "order_count", "commission_amount", "payment_gateway_fee",
      "advertising_spend", "cancellation_charges", "other_platform_fees", "gst_on_commission", "tcs_deduction", "tds_deduction",
      "hyperpure_recovery", "calculated_net_payout"]) g[f] = round2(Number(g[f]) + Number(p[f]));
    if (p.actual_bank_settlement !== null) {
      g.actual_bank_settlement = round2(Number(g.actual_bank_settlement || 0) + Number(p.actual_bank_settlement));
      g.has_actual = true;
    }
    if (p.week_label) g.week_labels.push(p.week_label);
  }
  return [...out.values()];
};

const settle = (row) => {
  const calculated = round2(
    row.net_platform_sales - row.commission_deducted - row.gst_on_commission - row.tcs_tds_deducted -
      row.cancellation_charges - row.marketing_ad_deductions - row.other_deductions - row.hyperpure_recovery
  );
  row.net_bank_settlement = calculated;
  if (!row._has_actual) {
    row.actual_bank_credit_received = 0;
    row.settlement_variance = 0;
    row.settlement_status = STATUS_TO_DB.pending;
  } else {
    row.settlement_variance = round2(row.actual_bank_credit_received - calculated);
    row.settlement_status = Math.abs(row.settlement_variance) <= SETTLEMENT_TOLERANCE ? STATUS_TO_DB.reconciled : STATUS_TO_DB.discrepancy;
  }
  delete row._has_actual;
  return row;
};

const toDbRow = (g, { restaurantId, platform, periodType, ref }) =>
  settle({
    restaurant_id: restaurantId,
    outlet_id: g.outlet_id,
    month_year: g.month,
    platform,
    gross_sales_reported: round2(g.gross_sales),
    customer_discounts_borne: round2(g.customer_discounts),
    net_platform_sales: round2(g.net_sales),
    commission_deducted: round2(g.commission_amount),
    gst_on_commission: round2(g.gst_on_commission),
    tcs_tds_deducted: round2(Number(g.tcs_deduction) + Number(g.tds_deduction)),
    cancellation_charges: round2(g.cancellation_charges),
    marketing_ad_deductions: round2(g.advertising_spend),
    other_deductions: round2(Number(g.other_platform_fees) + Number(g.payment_gateway_fee)),
    hyperpure_recovery: round2(g.hyperpure_recovery),
    actual_bank_credit_received: round2(g.actual_bank_settlement || 0),
    period_type: periodType,
    week_label: g.week_labels.length ? g.week_labels.join(", ").slice(0, 100) : null,
    order_count: Math.round(g.order_count || 0),
    payout_reference_id: ref,
    _has_actual: g.has_actual,
  });

const MONEY_COLS = ["gross_sales_reported", "customer_discounts_borne", "net_platform_sales", "commission_deducted", "gst_on_commission",
  "tcs_tds_deducted", "cancellation_charges", "marketing_ad_deductions", "other_deductions", "hyperpure_recovery", "actual_bank_credit_received"];

const uploadPayoutFiles = async (userId, files, opts) => {
  const tenant = await resolveTenant(userId);
  const { restaurantId } = tenant;
  const prepared = files.map((f) => ({ ...f, hash: sha256(f.buffer) }));
  assertUniqueInRequest(prepared);

  // 1. Parse + resolve (no writes)
  const parsedFiles = prepared.map((file) => {
    const parsed = parsePayoutWorkbook(readWorkbook(file), file.originalname);
    const resolved = resolveLines(parsed, file, opts);
    const unknown = [...new Set(resolved.lines.map((l) => l.outlet_id))].filter((o) => !tenant.outlets.includes(o));
    if (unknown.length) throw new AppError(`Outlet(s) not configured in restaurant_outlets: ${unknown.join(", ")}`, 422);
    const groups = foldByMonth(aggregate(resolved.lines, { platform: resolved.platform, periodType: resolved.periodType, fileName: file.originalname }));
    return { file, parsed, ...resolved, groups };
  });

  // 2. Plan writes against existing month rows (checks duplicates before anything is written)
  const plan = [];
  for (const pf of parsedFiles) {
    // Fingerprint of the statement's own orders: the same statement downloaded again (new file bytes / name)
    // gets the same reference, so it can never be counted twice. Falls back to the file hash.
    const orderIds = [...new Set(pf.lines.map((l) => l.order_id).filter(Boolean))].sort();
    const ref = orderIds.length
      ? crypto.createHash("sha256").update(`${pf.platform}|${orderIds.join(",")}`).digest("hex").slice(0, 8)
      : pf.file.hash.slice(0, 8);
    for (const g of pf.groups) {
      const { data: existing, error } = await supabaseAdmin
        .from(PAYOUT_TABLE)
        .select("*")
        .eq("restaurant_id", restaurantId)
        .eq("outlet_id", g.outlet_id)
        .eq("month_year", g.month)
        .eq("platform", pf.platform)
        .maybeSingle();
      if (error) throw dbError("loading existing payout", error);

      let row = toDbRow(g, { restaurantId, platform: pf.platform, periodType: pf.periodType, ref });
      const refs = existing?.payout_reference_id ? existing.payout_reference_id.split(",").filter(Boolean) : [];

      if (existing && refs.includes(ref) && !opts.replace) {
        throw new AppError(`"${pf.file.originalname}" was already uploaded. Re-send with replace=true to overwrite.`, 409, [
          { fileName: pf.file.originalname, outletId: g.outlet_id, month: g.month, platform: pf.platform },
        ]);
      }

      const accumulate =
        existing && !refs.includes(ref) && pf.periodType === "weekly" && existing.period_type === "weekly";
      if (existing && !accumulate && !opts.replace) {
        throw new AppError(
          `${pf.platform} payout for ${g.outlet_id} ${g.month} already exists. Re-send with replace=true to overwrite it with "${pf.file.originalname}".`,
          409,
          [{ fileName: pf.file.originalname, outletId: g.outlet_id, month: g.month, platform: pf.platform }]
        );
      }
      if (accumulate) {
        if (refs.length >= MAX_REFS) throw new AppError(`Too many weekly statements for ${pf.platform} ${g.outlet_id} ${g.month}`, 422);
        for (const c of MONEY_COLS) row[c] = round2(Number(existing[c] || 0) + Number(row[c] || 0));
        row.order_count = Number(existing.order_count || 0) + row.order_count;
        row.week_label = [existing.week_label, row.week_label].filter(Boolean).join(", ").slice(0, 100) || null;
        row.payout_reference_id = [...refs, ref].join(",");
        row._has_actual = existing.settlement_status !== STATUS_TO_DB.pending || row.settlement_status !== STATUS_TO_DB.pending;
        row = settle(row);
      }
      row.id = existing?.id || `${pf.platform}-${g.outlet_id}-${g.month}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 80);
      plan.push({ pf, row, accumulated: Boolean(accumulate), replaced: Boolean(existing && !accumulate) });
    }
  }

  // 3. Write
  const { data: saved, error: wErr } = await supabaseAdmin
    .from(PAYOUT_TABLE)
    .upsert(plan.map((p) => p.row), { onConflict: "restaurant_id,outlet_id,month_year,platform" })
    .select("*");
  if (wErr) throw dbError("saving payout statements", wErr);

  const byKey = new Map(saved.map((r) => [`${r.outlet_id}|${r.month_year}|${r.platform}`, r]));
  const results = parsedFiles.map((pf) => {
    const rows = plan.filter((p) => p.pf === pf);
    const payouts = rows.map((p) => ({ ...toClientPayout(byKey.get(`${p.row.outlet_id}|${p.row.month_year}|${p.row.platform}`)), sourceFileName: pf.file.originalname }));
    const warnings = [...pf.warnings];
    rows.filter((p) => p.accumulated).forEach((p) => warnings.push(`Added to existing ${p.row.month_year} ${p.row.outlet_id} weekly total.`));
    rows
      .filter((p) => p.replaced)
      .forEach((p) =>
        warnings.push(
          `Replaced existing ${p.row.month_year} ${p.row.outlet_id} statement.` +
            (p.pf.periodType === "weekly" ? " Upload the other weeks of this month again so they are counted once each." : "")
        )
      );
    return {
      batchId: payouts[0]?.id,
      fileName: pf.file.originalname,
      platform: pf.platform,
      periodType: pf.periodType,
      layout: pf.parsed.layout,
      sheetName: pf.parsed.sheetName,
      headerRow: pf.parsed.headerRow,
      columnMap: pf.parsed.columnMap,
      parsedRows: pf.lines.length,
      insertedRows: pf.lines.length,
      duplicateRows: 0,
      skippedRows: pf.parsed.skippedRows,
      warnings,
      payouts,
    };
  });

  const all = results.flatMap((r) => r.payouts);
  return {
    files: results,
    payouts: all,
    summary: {
      recordCount: all.length,
      totalGrossSales: round2(all.reduce((s, p) => s + p.grossSales, 0)),
      totalNetPayout: round2(all.reduce((s, p) => s + (p.actualBankSettlement || p.calculatedNetPayout), 0)),
      totalHyperpureDeductions: round2(all.reduce((s, p) => s + p.hyperpureRecovery, 0)),
    },
  };
};

const listPayouts = async (userId, q) => {
  const { restaurantId } = await resolveTenant(userId);
  const { from, to } = paginate(q.page, q.perPage);
  let query = supabaseAdmin.from(PAYOUT_TABLE).select("*", { count: "exact" }).eq("restaurant_id", restaurantId);
  if (q.month) query = query.eq("month_year", q.month);
  if (q.fromMonth) query = query.gte("month_year", q.fromMonth);
  if (q.toMonth) query = query.lte("month_year", q.toMonth);
  if (q.outletId) query = query.eq("outlet_id", q.outletId);
  if (q.platform) query = query.eq("platform", q.platform);
  const { data, error, count } = await query.order("month_year", { ascending: false }).order("platform").range(from, to);
  if (error) throw dbError("listing payouts", error);
  return { result: data.map(toClientPayout), count, page: q.page, perPage: q.perPage };
};

/** Upload history = stored month rows (the table keeps no per-file batches). */
const listBatches = async (userId, { page, perPage }) => listPayouts(userId, { page, perPage });

const deleteBatch = async (userId, id) => {
  const { restaurantId } = await resolveTenant(userId);
  const { data, error } = await supabaseAdmin.from(PAYOUT_TABLE).delete().eq("restaurant_id", restaurantId).eq("id", id).select("id");
  if (error) throw dbError("deleting payout", error);
  if (!data.length) throw new AppError("Payout statement not found", 404);
  return { id };
};

const getPayoutsForMonth = async (restaurantId, month, outletId) => {
  let query = supabaseAdmin.from(PAYOUT_TABLE).select("*").eq("restaurant_id", restaurantId).eq("month_year", month);
  if (outletId) query = query.eq("outlet_id", outletId);
  const { data, error } = await query;
  if (error) throw dbError("loading payouts for reconciliation", error);
  return data;
};

module.exports = { uploadPayoutFiles, listPayouts, listBatches, deleteBatch, getPayoutsForMonth, aggregate, resolveLines, toClientPayout };