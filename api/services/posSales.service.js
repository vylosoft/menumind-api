/**
 * POS sales ingestion → existing tables:
 *   pos_import_batches     (one row per uploaded file; file hash / report type kept in layout_config_json._meta)
 *   raw_pos_sales_records  (item rows; Sub-Order Wise channel rows use raw_category = 'CHANNEL_SUMMARY')
 */
const { supabaseAdmin } = require("../../utils/supabaseClient");
const AppError = require("../../utils/AppError");
const { POS_LAYOUT_PRESETS } = require("../../config/constant");
const { sha256, readWorkbook } = require("../helpers/spreadsheet.helper");
const { parsePosWorkbook, rowSignature } = require("../helpers/posParser.helper");
const { isSubOrderSummaryWorkbook, parseChannelSummaryWorkbook } = require("../helpers/channelSummaryParser.helper");
const { normalizeChannel } = require("../helpers/outlet.helper");
const { chunk, dbError, paginate, assertUniqueInRequest } = require("./batch.service");
const { resolveTenant } = require("./tenant.service");

const BATCH_TABLE = "pos_import_batches";
const RECORD_TABLE = "raw_pos_sales_records";
const CHANNEL_SUMMARY = "CHANNEL_SUMMARY";

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

const resolveLayout = ({ presetId, layout }) => {
  if (layout) return { presetId: presetId || "custom-pos", layout };
  if (presetId && POS_LAYOUT_PRESETS[presetId]) return { presetId, layout: { ...POS_LAYOUT_PRESETS[presetId] } };
  return { presetId: null, layout: null };
};

const resolveMapping = (opts, fileName) => (opts.mappings && opts.mappings[fileName]) || opts.mapping || null;

const normalizeOverrides = (overrides = {}) =>
  Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k.toLowerCase().trim(), v]));

const fileExt = (name) => (String(name).split(".").pop() || "xlsx").toLowerCase().slice(0, 10);
const cut = (v, n) => (v === null || v === undefined || v === "" ? null : String(v).slice(0, n));

/** Mirrors the frontend ReconciliationReport so the UI can consume server results unchanged. */
const buildReconciliation = (fileResults) => {
  const seen = new Set();
  const merged = [];
  let duplicatesSkipped = 0;
  let totalRawRows = 0;
  let invalidRows = 0;
  let returnsCount = 0;
  let returnsRevenue = 0;
  let totalRevenue = 0;
  let totalUnits = 0;
  const dates = new Set();
  const items = new Set();
  const outletCounts = { banaswadiRows: 0, whitefieldRows: 0, banaswadiRevenue: 0, whitefieldRevenue: 0, banaswadiUnits: 0, whitefieldUnits: 0 };

  for (const fr of fileResults) {
    totalRawRows += fr.records.length + fr.invalidRows;
    invalidRows += fr.invalidRows;
    for (const rec of fr.records) {
      if (seen.has(rec.signature)) {
        duplicatesSkipped++;
        continue;
      }
      seen.add(rec.signature);
      if (rec.isReturn) {
        returnsCount++;
        returnsRevenue += rec.revenue;
        continue;
      }
      merged.push(rec);
      totalRevenue += rec.revenue;
      totalUnits += rec.quantity;
      items.add(rec.rawItemName);
      if (rec.saleDate) dates.add(rec.saleDate);
      const w = rec.outlet === "whitefield";
      outletCounts[w ? "whitefieldRows" : "banaswadiRows"]++;
      outletCounts[w ? "whitefieldRevenue" : "banaswadiRevenue"] += rec.revenue;
      outletCounts[w ? "whitefieldUnits" : "banaswadiUnits"] += rec.quantity;
    }
  }

  const sortedDates = [...dates].sort();
  const months = [...new Set(sortedDates.map((d) => d.slice(0, 7)))].sort();
  let granularity = "aggregate_only";
  if (sortedDates.length) granularity = sortedDates.length > months.length * 2 ? "daily" : "monthly";

  return {
    merged,
    reconciliation: {
      totalFiles: fileResults.length,
      fileNames: fileResults.map((f) => f.fileName),
      totalRawRows,
      validRows: merged.length,
      invalidRows,
      duplicatesSkipped,
      returnsOrCancelledCount: returnsCount,
      returnsRevenueExcluded: round2(returnsRevenue),
      totalReportedRevenue: round2(totalRevenue),
      isNetSales: fileResults.every((f) => f.records.every((r) => r.isNetSales)),
      totalUnitsSold: totalUnits,
      uniqueRawItems: items.size,
      uniqueParentDishes: 0,
      detectedGranularity: granularity,
      dateRangeStart: sortedDates[0],
      dateRangeEnd: sortedDates[sortedDates.length - 1],
      monthsPresent: months,
      hasOutletGrouping: outletCounts.whitefieldRows > 0,
      outletCounts: {
        ...outletCounts,
        banaswadiRevenue: round2(outletCounts.banaswadiRevenue),
        whitefieldRevenue: round2(outletCounts.whitefieldRevenue),
      },
    },
  };
};

const toClientRecord = (r) => ({
  rowId: r.rowId,
  sourceFile: r.sourceFile,
  rawItemName: r.rawItemName,
  rawVariantName: r.rawVariantName || undefined,
  quantity: Number(r.quantity),
  revenue: Number(r.revenue),
  isNetSales: r.isNetSales,
  date: r.saleDate || undefined,
  category: r.category || undefined,
  orderType: r.orderType || undefined,
  salesChannel: r.salesChannel || undefined,
  discount: Number(r.discount || 0),
  returnAmount: Number(r.returnAmount || 0),
  outlet: r.outlet,
  isReturnOrCancelled: Boolean(r.isReturn),
});

const dbRowToClient = (row) => {
  const meta = row.raw_metadata || {};
  if (row.raw_category === CHANNEL_SUMMARY) {
    // Dine-in rows are split by Petpooja into VEG / NON VEG: show them as one "Dine In" item with two variants
    const isDineIn = /dine\s*-?\s*in/i.test(String(row.order_type || ""));
    // Brand of the dine-in rows = the restaurant they are listed under ("Banglar Jhale Jhole, Whitefield"),
    // written the way the other Whitefield rows are ("Banglar Jhale Jhole W")
    const restaurantName = String(meta.restaurant || "").trim();
    const dineBrand = restaurantName
      ? restaurantName.replace(/\s*,\s*whitefield\s*$/i, " W").replace(/\s+/g, " ").trim()
      : "Dine In";
    return toClientRecord({
      rowId: row.id,
      sourceFile: meta.sourceFile || "",
      rawItemName: isDineIn ? dineBrand : row.raw_item_name,
      rawVariantName: isDineIn ? `Dine In ${row.raw_item_name}` : undefined,
      quantity: row.quantity,
      revenue: row.net_revenue,
      isNetSales: true,
      saleDate: row.sale_date,
      category: meta.restaurant || undefined,
      orderType: row.order_type,
      salesChannel: isDineIn ? "Dine In" : row.raw_item_name,
      discount: Number(row.discount_amount) || 0,
      returnAmount: 0,
      outlet: row.outlet_name,
      isReturn: false,
    });
  }
  const isNet = meta.isNetSales !== false;
  return toClientRecord({
    rowId: row.id,
    sourceFile: meta.sourceFile || "",
    rawItemName: row.raw_item_name,
    rawVariantName: row.raw_variant_name,
    quantity: row.quantity,
    revenue: isNet ? row.net_revenue : row.gross_revenue,
    isNetSales: isNet,
    saleDate: row.sale_date,
    category: row.raw_category,
    orderType: row.order_type,
    salesChannel: row.sales_channel,
    discount: row.discount_amount,
    returnAmount: row.is_return_or_cancelled ? row.net_revenue : 0,
    outlet: row.outlet_name,
    isReturn: row.is_return_or_cancelled,
  });
};

/**
 * Earlier uploads that would double-count the incoming files: same content hash, same file name,
 * or a sales period that overlaps (dated uploads only).
 */
const findConflictingBatches = async (restaurantId, incoming) => {
  const { data, error } = await supabaseAdmin
    .from(BATCH_TABLE)
    .select("id, file_name, created_at, date_start, date_end, layout_config_json")
    .eq("restaurant_id", restaurantId);
  if (error) throw dbError("checking duplicate uploads", error);
  return (data || []).filter((b) =>
    incoming.some(({ file, from, to }) => {
      if (b.layout_config_json?._meta?.fileHash === file.hash) return true;
      if (String(b.file_name || "").trim().toLowerCase() === String(file.originalname || "").trim().toLowerCase()) return true;
      if (from && to && b.date_start && b.date_end) return b.date_start <= to && b.date_end >= from;
      return false;
    })
  );
};

const deleteBatches = async (restaurantId, ids) => {
  if (!ids.length) return;
  const { error } = await supabaseAdmin.from(BATCH_TABLE).delete().eq("restaurant_id", restaurantId).in("id", ids);
  if (error) throw dbError("removing upload batch", error);
};

/** Returns the subset of signatures already stored for this restaurant. */
const existingSignatures = async (restaurantId, signatures) => {
  const existing = new Set();
  for (const part of chunk(signatures, 150)) {
    const { data, error } = await supabaseAdmin
      .from(RECORD_TABLE)
      .select("raw_metadata->>sig")
      .eq("restaurant_id", restaurantId)
      .in("raw_metadata->>sig", part);
    if (error) throw dbError("checking duplicate sales rows", error);
    data.forEach((d) => existing.add(d.sig));
  }
  return existing;
};

const insertRows = async (rows, context) => {
  for (const part of chunk(rows)) {
    const { error } = await supabaseAdmin.from(RECORD_TABLE).insert(part);
    if (error) throw dbError(context, error);
  }
};

const createBatch = async (payload) => {
  const { data, error } = await supabaseAdmin.from(BATCH_TABLE).insert(payload).select("id").single();
  if (error) throw dbError("creating upload batch", error);
  return data.id;
};

/** Sub-Order Wise channel summary → raw_pos_sales_records rows with raw_category CHANNEL_SUMMARY. */
const persistChannelSummary = async ({ tenant, userId, file, parsed, opts, createdBatchIds }) => {
  const { restaurantId } = tenant;

  // The same period must not be counted twice from different files
  const { data: overlap, error: oErr } = await supabaseAdmin
    .from(BATCH_TABLE)
    .select("id, file_name")
    .eq("restaurant_id", restaurantId)
    .eq("layout_config_json->_meta->>reportType", "channel_summary")
    .eq("layout_config_json->_meta->>periodFrom", parsed.period.from)
    .eq("layout_config_json->_meta->>periodTo", parsed.period.to);
  if (oErr) throw dbError("checking report period", oErr);
  if (overlap.length) {
    if (!opts.replace) {
      throw new AppError(
        `Sales summary for ${parsed.period.from} to ${parsed.period.to} was already uploaded ("${overlap[0].file_name}"). Re-send with replace=true to overwrite.`,
        409,
        overlap.map((b) => ({ batchId: b.id, fileName: b.file_name }))
      );
    }
    await deleteBatches(restaurantId, overlap.map((b) => b.id));
  }

  const unknownOutlets = [...new Set(parsed.rows.map((r) => r.outlet))].filter((o) => !tenant.outlets.includes(o));
  if (unknownOutlets.length) throw new AppError(`Outlet(s) not configured in restaurant_outlets: ${unknownOutlets.join(", ")}`, 422);

  const netTotal = round2(parsed.rows.reduce((s, r) => s + r.netSales, 0));
  const batchId = await createBatch({
    restaurant_id: restaurantId,
    file_name: file.originalname,
    file_type: fileExt(file.originalname),
    file_size_bytes: file.size,
    raw_rows_count: parsed.rows.length,
    valid_rows_count: parsed.rows.length,
    discarded_rows_count: 0,
    duplicate_rows_count: 0,
    date_start: parsed.period.from,
    date_end: parsed.period.to,
    total_reported_revenue: netTotal,
    is_overlapping_warning: false,
    column_mapping_json: parsed.columnMap,
    layout_config_json: {
      headerRow: parsed.headerRow,
      sheet: parsed.sheetName,
      _meta: {
        fileHash: file.hash,
        reportType: "channel_summary",
        reportName: parsed.reportName,
        periodFrom: parsed.period.from,
        periodTo: parsed.period.to,
        posSystem: opts.posSystem,
      },
    },
    uploaded_by: userId,
  });
  createdBatchIds.push(batchId);

  const rows = parsed.rows.map((r) => ({
    batch_id: batchId,
    restaurant_id: restaurantId,
    source_row_index: r.sourceRow,
    sale_date: parsed.period.from,
    raw_item_name: r.subOrderType,
    raw_variant_name: null,
    quantity: r.bills,
    unit_price: r.bills > 0 ? round2(r.netSales / r.bills) : 0,
    gross_revenue: round2(r.myAmount),
    discount_amount: round2(r.discount),
    net_revenue: round2(r.netSales),
    tax_amount: round2(r.totalTax),
    is_return_or_cancelled: false,
    raw_category: CHANNEL_SUMMARY,
    order_type: cut(r.orderType, 50),
    sales_channel: r.channel,
    outlet_name: r.outlet,
    raw_metadata: {
      kind: "channel_summary",
      sourceFile: file.originalname,
      restaurant: r.restaurant,
      brand: r.brand,
      subOrderType: r.subOrderType,
      channel: r.channel,
      periodFrom: parsed.period.from,
      periodTo: parsed.period.to,
      bills: r.bills,
      containerCharge: round2(r.containerCharge),
      totalSales: round2(r.totalSales),
      onlineTax: round2(r.onlineTax),
      ecomGst: round2(r.ecomGst),
    },
  }));
  await insertRows(rows, "inserting channel sales rows");

  const byKey = (key) =>
    Object.values(
      parsed.rows.reduce((acc, x) => {
        const k = x[key];
        acc[k] = acc[k] || { [key === "outlet" ? "outlet_id" : key]: k, bills: 0, netSales: 0 };
        acc[k].bills += x.bills;
        acc[k].netSales = round2(acc[k].netSales + x.netSales);
        return acc;
      }, {})
    );

  return {
    batchId,
    fileName: file.originalname,
    reportName: parsed.reportName,
    period: parsed.period,
    insertedRows: rows.length,
    duplicateRows: 0,
    totalBills: parsed.totals.bills,
    totalNetSales: netTotal,
    reportTotalVerified: Boolean(parsed.totals.reportTotal),
    byChannel: byKey("channel"),
    byOutlet: byKey("outlet"),
    rows: parsed.rows.map((x) => ({
      restaurant: x.restaurant,
      orderType: x.orderType,
      subOrderType: x.subOrderType,
      brand: x.brand,
      channel: x.channel,
      outlet: x.outlet,
      bills: x.bills,
      netSales: x.netSales,
    })),
    warnings: parsed.warnings,
  };
};

/** Item-level POS rows → raw_pos_sales_records. Rows already stored (same signature) are skipped. */
const persistItemFile = async ({ tenant, userId, pf, presetId, opts, createdBatchIds }) => {
  const { restaurantId } = tenant;
  const { file, parsed, records } = pf;

  const unknownOutlets = [...new Set(records.map((r) => r.outlet))].filter((o) => !tenant.outlets.includes(o));
  if (unknownOutlets.length) throw new AppError(`Outlet(s) not configured in restaurant_outlets: ${unknownOutlets.join(", ")}`, 422);

  const uniq = new Map();
  for (const r of records) if (!uniq.has(r.signature)) uniq.set(r.signature, r);
  const already = await existingSignatures(restaurantId, [...uniq.keys()]);
  const toInsert = [...uniq.values()].filter((r) => !already.has(r.signature));

  const dated = records.map((r) => r.saleDate).filter(Boolean).sort();
  const insertedRevenue = round2(toInsert.filter((r) => !r.isReturn).reduce((s, r) => s + r.revenue, 0));

  const batchId = await createBatch({
    restaurant_id: restaurantId,
    file_name: file.originalname,
    file_type: fileExt(file.originalname),
    file_size_bytes: file.size,
    raw_rows_count: records.length + parsed.invalidRows,
    valid_rows_count: toInsert.length,
    discarded_rows_count: parsed.invalidRows,
    duplicate_rows_count: records.length - toInsert.length,
    date_start: dated[0] || null,
    date_end: dated[dated.length - 1] || null,
    total_reported_revenue: insertedRevenue,
    is_overlapping_warning: already.size > 0,
    column_mapping_json: parsed.mapping,
    layout_config_json: {
      ...parsed.layout,
      presetId,
      sheet: parsed.sheetName,
      _meta: { fileHash: file.hash, reportType: "item_sales", posSystem: opts.posSystem, uploadType: opts.uploadType || null },
    },
    uploaded_by: userId,
  });
  createdBatchIds.push(batchId);

  const rows = toInsert.map((r) => {
    const gross = r.isNetSales ? r.revenue + r.discount : r.revenue;
    const net = r.isNetSales ? r.revenue : Math.max(r.revenue - r.discount, 0);
    return {
      batch_id: batchId,
      restaurant_id: restaurantId,
      source_row_index: r.sourceRow,
      sale_date: r.saleDate,
      raw_item_name: r.rawItemName,
      raw_variant_name: r.rawVariantName,
      quantity: r.quantity,
      unit_price: r.quantity > 0 ? round2(net / r.quantity) : 0,
      gross_revenue: round2(gross),
      discount_amount: round2(r.discount),
      net_revenue: round2(net),
      tax_amount: 0,
      is_return_or_cancelled: r.isReturn,
      raw_category: cut(r.category, 100),
      order_type: cut(r.orderType, 50),
      sales_channel: cut(r.salesChannel || r.channel, 50),
      outlet_name: r.outlet,
      raw_metadata: {
        kind: "item_sales",
        sig: r.signature,
        sourceFile: r.sourceFile,
        channel: r.channel,
        cleanItemName: r.cleanItemName,
        isNetSales: r.isNetSales,
      },
    };
  });
  await insertRows(rows, "inserting POS sales records");

  return {
    batchId,
    fileName: file.originalname,
    sheetName: parsed.sheetName,
    layout: parsed.layout,
    mapping: parsed.mapping,
    totalRows: records.length + parsed.invalidRows,
    insertedRows: rows.length,
    duplicateRows: records.length - rows.length,
    invalidRows: parsed.invalidRows,
    invalidSamples: parsed.invalidSamples,
    returnRows: toInsert.filter((r) => r.isReturn).length,
    insertedRevenue,
  };
};

/**
 * Parses every file first (all-or-nothing), then writes. A DB failure removes every batch created by
 * this request (records cascade with their batch).
 */
const uploadPosFiles = async (userId, files, opts) => {
  const tenant = await resolveTenant(userId);
  const { presetId, layout } = resolveLayout(opts);
  const overrides = normalizeOverrides(opts.outletOverrides);

  const prepared = files.map((f) => ({ ...f, hash: sha256(f.buffer) }));
  assertUniqueInRequest(prepared);


  // 1. Parse
  const summaryFiles = [];
  const parsedFiles = [];
  for (const file of prepared) {
    const wb = readWorkbook(file);
    if (isSubOrderSummaryWorkbook(wb)) {
      const parsed = parseChannelSummaryWorkbook(wb, file.originalname, {
        defaultPeriod: opts.period,
        skipFooterRows: layout?.skipFooterRows || 0,
      });
      // Outlet corrections made by the user in the review screen win over automatic detection
      parsed.rows.forEach((r) => {
        const override = overrides[String(r.subOrderType).toLowerCase().trim()];
        if (override) r.outlet = override;
      });
      summaryFiles.push({ file, parsed });
      continue;
    }
    const parsed = parsePosWorkbook(wb, file.originalname, {
      layout,
      mapping: resolveMapping(opts, file.originalname),
      outletOverrides: overrides,
      defaultOutlet: opts.defaultOutlet,
    });
    const records = parsed.records.map((r) => ({
      ...r,
      sourceFile: file.originalname,
      rowId: `${file.originalname}-r${r.sourceRow}`,
      signature: rowSignature(r),
    }));
    parsedFiles.push({ file, parsed, records, invalidRows: parsed.invalidRows, fileName: file.originalname });
  }

  const { merged, reconciliation } = buildReconciliation(parsedFiles);

  // 1b. Never store the same sales twice: same file content, same file name, or an overlapping sales
  //     period (any report type: item-wise vs Sub-Order Wise). Warn (409) unless the user chose to replace.
  const incoming = [
    ...summaryFiles.map(({ file, parsed }) => ({ file, from: parsed.period?.from || null, to: parsed.period?.to || null })),
    ...parsedFiles.map(({ file, records }) => {
      const d = records.map((r) => r.saleDate).filter(Boolean).sort();
      return { file, from: d[0] || null, to: d[d.length - 1] || null };
    }),
  ];
  const existing = await findConflictingBatches(tenant.restaurantId, incoming);
  if (existing.length && !opts.replace) {
    throw new AppError(
      "This sales data is already saved (same file or same sales period). Re-send with replace=true to overwrite it.",
      409,
      existing.map((d) => ({ batchId: d.id, fileName: d.file_name, uploadedAt: d.created_at, periodFrom: d.date_start, periodTo: d.date_end }))
    );
  }

  // 2. Persist
  if (existing.length) await deleteBatches(tenant.restaurantId, existing.map((d) => d.id));

  const createdBatchIds = [];
  const batches = [];
  const channelSummaries = [];
  try {
    for (const sf of summaryFiles) {
      channelSummaries.push(await persistChannelSummary({ tenant, userId, file: sf.file, parsed: sf.parsed, opts, createdBatchIds }));
    }
    for (const pf of parsedFiles) {
      batches.push(await persistItemFile({ tenant, userId, pf, presetId, opts, createdBatchIds }));
    }
  } catch (err) {
    try {
      await deleteBatches(tenant.restaurantId, createdBatchIds);
    } catch {
      /* logged by dbError */
    }
    throw err;
  }

  return {
    reportType: parsedFiles.length === 0 ? "channel_summary" : summaryFiles.length ? "mixed" : "item_sales",
    batches,
    channelSummaries,
    records: merged.map(toClientRecord),
    reconciliation,
  };
};

const listBatches = async (userId, { page, perPage }) => {
  const { restaurantId } = await resolveTenant(userId);
  const { from, to } = paginate(page, perPage);
  const { data, error, count } = await supabaseAdmin
    .from(BATCH_TABLE)
    .select(
      "id, file_name, file_type, raw_rows_count, valid_rows_count, discarded_rows_count, duplicate_rows_count, date_start, date_end, total_reported_revenue, is_overlapping_warning, layout_config_json, created_at",
      { count: "exact" }
    )
    .eq("restaurant_id", restaurantId)
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) throw dbError("listing POS batches", error);
  return {
    result: data.map((b) => {
      const { _meta = {}, ...layout } = b.layout_config_json || {};
      return { ...b, layout_config_json: layout, report_type: _meta.reportType || "item_sales", period_from: _meta.periodFrom, period_to: _meta.periodTo };
    }),
    count,
    page,
    perPage,
  };
};

/** All stored POS rows (item-level and Sub-Order Wise channel rows), as the app loads them after any upload. */
const listRecords = async (userId, q) => {
  const { restaurantId } = await resolveTenant(userId);
  const { from, to } = paginate(q.page, q.perPage);
  let query = supabaseAdmin
    .from(RECORD_TABLE)
    .select(
      "id, raw_item_name, raw_variant_name, quantity, gross_revenue, net_revenue, discount_amount, sale_date, raw_category, order_type, sales_channel, outlet_name, is_return_or_cancelled, raw_metadata",
      { count: "exact" }
    )
    .eq("restaurant_id", restaurantId);

  if (q.from) query = query.gte("sale_date", new Date(q.from).toISOString().slice(0, 10));
  if (q.to) query = query.lte("sale_date", new Date(q.to).toISOString().slice(0, 10));
  if (q.outlet) query = query.eq("outlet_name", q.outlet);
  if (q.channel) query = query.eq("raw_metadata->>channel", q.channel);
  if (q.batchId) query = query.eq("batch_id", q.batchId);
  if (!q.includeReturns) query = query.eq("is_return_or_cancelled", false);

  const { data, error, count } = await query.order("created_at", { ascending: true }).order("id").range(from, to);
  if (error) throw dbError("listing POS records", error);
  return { result: data.map(dbRowToClient), count, page: q.page, perPage: q.perPage };
};

const deleteBatch = async (userId, id) => {
  const { restaurantId } = await resolveTenant(userId);
  const { data, error } = await supabaseAdmin.from(BATCH_TABLE).delete().eq("restaurant_id", restaurantId).eq("id", id).select("id");
  if (error) throw dbError("deleting POS batch", error);
  if (!data.length) throw new AppError("Upload batch not found", 404);
  return { id };
};

module.exports = { uploadPosFiles, listBatches, listRecords, deleteBatch, buildReconciliation, normalizeChannel, CHANNEL_SUMMARY };
