const { supabaseAdmin } = require("../../utils/supabaseClient");
const { MATCH_THRESHOLDS } = require("../../config/constant");
const { dbError } = require("./batch.service");
const { getPayoutsForMonth } = require("./payouts.service");
const { resolveTenant } = require("./tenant.service");
const { normalizeChannel } = require("../helpers/outlet.helper");

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const PAGE = 1000;
const CHANNEL_SUMMARY = "CHANNEL_SUMMARY";

const CHANNELS = [
  { channel: "swiggy", label: "Swiggy" },
  { channel: "zomato", label: "Zomato" },
  { channel: "ownly", label: "Ownly" },
  { channel: "direct", label: "Direct / Dine-in / Takeaway" },
];

const monthRange = (month) => {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
};

const classify = (variancePct, hasBothSides) => {
  if (!hasBothSides) return "unmatched";
  const v = Math.abs(variancePct);
  if (v <= MATCH_THRESHOLDS.matched) return "matched";
  if (v <= MATCH_THRESHOLDS.minor) return "minor_variance";
  return "unmatched";
};

const fetchAll = async (build, context) => {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw dbError(context, error);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
};

/**
 * POS sales by channel for a month. Sub-Order Wise channel summaries whose period sits inside the month
 * are preferred over item-level rows so the same sales are never counted twice.
 */
const posByChannel = async (restaurantId, { from, to }, outlet) => {
  const cols = "net_revenue, gross_revenue, discount_amount, quantity, sales_channel, order_type, raw_item_name, is_return_or_cancelled, raw_category, raw_metadata";
  const base = () => {
    let q = supabaseAdmin.from("raw_pos_sales_records").select(cols).eq("restaurant_id", restaurantId).gte("sale_date", from).lte("sale_date", to);
    if (outlet) q = q.eq("outlet_name", outlet);
    return q;
  };

  // Both sources are read in parallel; channel summaries win when present for the period.
  const [summaryAll, items] = await Promise.all([
    fetchAll(() => base().eq("raw_category", CHANNEL_SUMMARY), "summarising channel sales"),
    fetchAll(() => base().or(`raw_category.is.null,raw_category.neq.${CHANNEL_SUMMARY}`), "summarising POS sales"),
  ]);
  const summary = summaryAll.filter((r) => (r.raw_metadata?.periodTo || to) <= to);
  const useSummary = summary.length > 0;
  const rows = useSummary ? summary : items;

  const acc = {};
  for (const r of rows) {
    const ch = r.raw_metadata?.channel || normalizeChannel(r.sales_channel, r.order_type, r.raw_item_name);
    const a = (acc[ch] = acc[ch] || { gross: 0, net: 0, orders: 0, units: 0, returns: 0 });
    if (r.is_return_or_cancelled) {
      a.returns += Number(r.net_revenue);
      continue;
    }
    a.gross += Number(r.gross_revenue);
    a.net += Number(r.net_revenue);
    a.units += Number(r.quantity);
    a.orders += useSummary ? Number(r.quantity) : 1;
  }
  return { source: rows.length === 0 ? "none" : useSummary ? "channel_summary" : "item_sales", acc };
};

/** Matches POS sales (by channel) against aggregator payouts for a month. Compatible with ChannelPosMatchReport. */
const matchRevenue = async (userId, { month, outletId }) => {
  const { restaurantId } = await resolveTenant(userId);
  const outlet = outletId === "consolidated" ? null : outletId;
  const period = monthRange(month);

  const [{ source, acc }, payouts] = await Promise.all([
    posByChannel(restaurantId, period, outlet),
    getPayoutsForMonth(restaurantId, month, outlet),
  ]);

  const channelReports = CHANNELS.map(({ channel, label }) => {
    const p = acc[channel] || { gross: 0, net: 0, orders: 0, units: 0, returns: 0 };
    const pay = payouts.filter((x) => x.platform === channel);
    const isDirect = channel === "direct";
    const posGross = round2(p.gross);
    const posNet = round2(p.net);
    // Direct (dine-in / takeaway / own delivery) has no aggregator statement: the POS amount is the settlement.
    const payoutGross = isDirect ? posGross : round2(pay.reduce((s, x) => s + Number(x.gross_sales_reported), 0));
    const payoutNet = isDirect ? posNet : round2(pay.reduce((s, x) => s + Number(x.net_platform_sales), 0));
    const payoutCredited = isDirect
      ? posNet
      : round2(pay.reduce((s, x) => s + Number(Number(x.actual_bank_credit_received) || Number(x.net_bank_settlement)), 0));
    const payoutOrders = isDirect ? Math.round(p.orders) : pay.reduce((s, x) => s + Number(x.order_count || 0), 0);

    const varianceGross = isDirect ? 0 : round2(posGross - payoutGross);
    const base = payoutGross || posGross;
    const varianceGrossPct = isDirect || base === 0 ? 0 : round2((varianceGross / base) * 100);
    const matchStatus = isDirect
      ? "matched"
      : posGross === 0 && payoutGross === 0
        ? "matched"
        : classify(varianceGrossPct, posGross > 0 && payoutGross > 0);

    return {
      channel,
      channelLabel: label,
      posGrossSales: posGross,
      posNetSales: posNet,
      posOrders: Math.round(p.orders),
      posUnits: round2(p.units),
      posReturns: round2(p.returns),
      payoutGrossSales: payoutGross,
      payoutNetSales: payoutNet,
      payoutNetCredited: payoutCredited,
      payoutOrders,
      payoutStatements: pay.length,
      payoutDiscrepancies: pay.filter((x) => String(x.settlement_status).toLowerCase() === "discrepancy").length,
      varianceGross,
      varianceGrossPct,
      matchStatus,
    };
  });

  const aggregators = channelReports.filter((c) => c.channel !== "direct");
  const totalPosGross = round2(channelReports.reduce((s, c) => s + c.posGrossSales, 0));
  const totalPosNet = round2(channelReports.reduce((s, c) => s + c.posNetSales, 0));
  const aggPosGross = round2(aggregators.reduce((s, c) => s + c.posGrossSales, 0));
  const totalPayoutGross = round2(aggregators.reduce((s, c) => s + c.payoutGrossSales, 0));
  const totalPayoutNetCredited = round2(aggregators.reduce((s, c) => s + c.payoutNetCredited, 0));
  const overallVariance = round2(aggPosGross - totalPayoutGross);
  const overallPct = totalPayoutGross ? (overallVariance / totalPayoutGross) * 100 : aggPosGross ? 100 : 0;
  const overallStatus =
    aggPosGross === 0 && totalPayoutGross === 0 ? "matched" : classify(overallPct, aggPosGross > 0 && totalPayoutGross > 0);

  return {
    month,
    aggregatorPosGross: aggPosGross,
    directPosNet: round2(channelReports.find((c) => c.channel === "direct").posNetSales),
    outletId: outletId || "consolidated",
    period,
    posSource: source,
    channelReports,
    totalPosGross,
    totalPosNet,
    totalPayoutGross,
    totalPayoutNetCredited,
    overallVariance,
    overallVariancePct: round2(overallPct),
    overallStatus,
    thresholds: MATCH_THRESHOLDS,
  };
};

module.exports = { matchRevenue, monthRange };