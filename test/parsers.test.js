const test = require("node:test");
const assert = require("node:assert");
const XLSX = require("xlsx");

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "test";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";

const { parsePosWorkbook, rowSignature } = require("../api/helpers/posParser.helper");
const { parsePayoutWorkbook } = require("../api/helpers/payoutParser.helper");
const { resolveLines, aggregate } = require("../api/services/payouts.service");
const { toNumber, toIsoDate, extractMonthFromText } = require("../api/helpers/spreadsheet.helper");
const { detectOutletFromItem, normalizeChannel } = require("../api/helpers/outlet.helper");

const wbFrom = (aoa, name = "Sheet1") => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { type: "buffer", cellDates: true, dense: true });
};

test("number + date normalization", () => {
  assert.strictEqual(toNumber("₹1,234.50"), 1234.5);
  assert.strictEqual(toNumber("(120.00)"), -120);
  assert.strictEqual(toNumber("abc"), null);
  assert.strictEqual(toIsoDate("05/10/2026"), "2026-10-05");
  assert.strictEqual(toIsoDate("31-02-2026"), null);
  assert.strictEqual(toIsoDate("12 Oct 2026"), "2026-10-12");
  assert.strictEqual(extractMonthFromText("Zomato_Payout_Oct_2026"), "2026-10");
  assert.strictEqual(extractMonthFromText("swiggy 2026-09 week"), "2026-09");
});

test("outlet + channel detection", () => {
  assert.strictEqual(detectOutletFromItem("Chicken Biryani W - Swiggy").outlet, "whitefield");
  assert.strictEqual(detectOutletFromItem("Chicken Biryani W - Swiggy").channel, "Swiggy");
  assert.strictEqual(detectOutletFromItem("Mutton Kosha - Zomato").outlet, "banaswadi");
  assert.strictEqual(detectOutletFromItem("Fish Fry", "", "Dine-in").outlet, "whitefield");
  assert.strictEqual(normalizeChannel("Zomato Online"), "zomato");
  assert.strictEqual(normalizeChannel("Dine In"), "direct");
});

test("Petpooja item-wise report with preset layout", () => {
  const aoa = [
    ["Restaurant: Bongo"], ["Item Wise Report"], ["From 01-10-2026 To 31-10-2026"], [""],
    ["Date", "Item Name", "Category", "Order Type", "Qty", "Discount", "Net Sales"],
    ["01-10-2026", "Chicken Biryani W - Swiggy", "Biryani", "Delivery", 3, 30, "₹ 870"],
    ["01-10-2026", "Mutton Kosha - Zomato", "Mains", "Delivery", 2, 0, "1,100"],
    ["02-10-2026", "Fish Fry", "Starters", "Dine In", -1, 0, -250],
    ["02-10-2026", "", "Starters", "Dine In", 1, 0, 100],
    ["Total", "", "", "", 5, 30, 1720],
  ];
  const r = parsePosWorkbook(wbFrom(aoa), "pp.xlsx", { layout: { headerRow: 5, dataStartRow: 6, sheetIndex: 0, skipFooterRows: 0 } });
  assert.strictEqual(r.mapping.revenue, "Net Sales");
  assert.strictEqual(r.mapping.discount, "Discount");
  assert.strictEqual(r.mapping.quantity, "Qty");
  assert.strictEqual(r.records.length, 3);
  assert.strictEqual(r.invalidRows, 1);
  assert.strictEqual(r.records[0].outlet, "whitefield");
  assert.strictEqual(r.records[0].channel, "swiggy");
  assert.strictEqual(r.records[0].saleDate, "2026-10-01");
  assert.strictEqual(r.records[1].revenue, 1100);
  assert.strictEqual(r.records[2].isReturn, true);
  assert.ok(rowSignature(r.records[0]).includes("Chicken Biryani"));
});

test("POS header auto-detection without layout", () => {
  const aoa = [["Some title"], [], ["Item", "Quantity", "Amount"], ["Paneer Tikka", 4, 960]];
  const r = parsePosWorkbook(wbFrom(aoa), "flat.csv", {});
  assert.strictEqual(r.layout.headerRow, 3);
  assert.strictEqual(r.records.length, 1);
});

test("POS rejects file without required columns", () => {
  assert.throws(() => parsePosWorkbook(wbFrom([["A", "B"], [1, 2]]), "bad.xlsx", {}), /could not locate/);
});

test("Zomato order-level payout statement", () => {
  const aoa = [
    ["Zomato Payout Report"], ["Res ID: 20794526"], [],
    ["Order ID", "Order Date", "Restaurant Name", "Bill Subtotal", "Merchant Discount", "Commission", "Payment Mechanism Fee", "GST on Commission", "TCS", "TDS", "Hyperpure Recovery", "Net Payout"],
    ["Z1", "05/10/2026", "Bongo Delicacy W", 1000, 100, 225, 18, 43.74, 9, 0.9, 0, 603.36],
    ["Z2", "06/10/2026", "Bongo Delicacy", 500, 0, 125, 9, 24.12, 5, 0.5, 50, 286.38],
    ["Total", "", "", 1500, 100, 350, 27, 67.86, 14, 1.4, 50, 889.74],
  ];
  const parsed = parsePayoutWorkbook(wbFrom(aoa), "Zomato_Oct_2026.xlsx");
  assert.strictEqual(parsed.layout, "tabular");
  assert.strictEqual(parsed.detectedPlatform, "zomato");
  assert.strictEqual(parsed.lines.length, 2);
  assert.deepStrictEqual(parsed.columnMap.grossSales, ["Bill Subtotal"]);
  assert.deepStrictEqual(parsed.columnMap.gstOnCommission, ["GST on Commission"]);

  const file = { originalname: "Zomato_Oct_2026.xlsx" };
  const res = resolveLines(parsed, file, {});
  assert.strictEqual(res.platform, "zomato");
  assert.strictEqual(res.lines[0].outlet_id, "whitefield");
  assert.strictEqual(res.lines[1].outlet_id, "banaswadi");
  assert.strictEqual(res.lines[0].month, "2026-10");

  const agg = aggregate(res.lines, { platform: "zomato", periodType: "monthly", fileName: file.originalname });
  const wf = agg.find((a) => a.outlet_id === "whitefield");
  assert.strictEqual(wf.net_sales, 900);
  assert.strictEqual(wf.calculated_net_payout, 603.36);
  assert.strictEqual(wf.status, "reconciled");
  const bw = agg.find((a) => a.outlet_id === "banaswadi");
  assert.strictEqual(bw.hyperpure_recovery, 50);
  assert.strictEqual(bw.status, "reconciled");
});

test("Swiggy statement flags discrepancy, never invents values", () => {
  const aoa = [
    ["Order No", "Order Date", "Item Total", "Swiggy Fee", "Taxes on Service Fee", "Net Payable"],
    ["S1", "2026-09-03", 800, -160, -28.8, 500],
  ];
  const parsed = parsePayoutWorkbook(wbFrom(aoa), "statement.xlsx");
  const res = resolveLines(parsed, { originalname: "statement.xlsx" }, { platform: "swiggy" });
  const [p] = aggregate(res.lines, { platform: "swiggy", periodType: "monthly", fileName: "statement.xlsx" });
  assert.strictEqual(p.commission_amount, 160);
  assert.strictEqual(p.gst_on_commission, 28.8);
  assert.strictEqual(p.calculated_net_payout, 611.2);
  assert.strictEqual(p.status, "discrepancy");
  assert.strictEqual(p.payment_gateway_fee, 0);
  assert.strictEqual(res.warnings.length, 1);
});

test("payout without month or platform is rejected", () => {
  const aoa = [["Gross Sales", "Commission", "Net Payout"], [1000, 200, 760]];
  const parsed = parsePayoutWorkbook(wbFrom(aoa), "report.xlsx");
  assert.throws(() => resolveLines(parsed, { originalname: "report.xlsx" }, {}), /platform could not be detected/);
  assert.throws(() => resolveLines(parsed, { originalname: "report.xlsx" }, { platform: "ownly" }), /month could not be determined/);
  const ok = resolveLines(parsed, { originalname: "report.xlsx" }, { platform: "ownly", month: "2026-08", outletId: "banaswadi" });
  assert.strictEqual(ok.lines[0].month, "2026-08");
});

test("summary (label/value) statement layout", () => {
  const aoa = [["Swiggy Weekly Payout - Week 2 Oct 2026"], ["Gross Sales", "₹ 50,000"], ["Commission", "11,000"], ["GST on Commission", "1,980"], ["Net Payout", "37,020"]];
  const parsed = parsePayoutWorkbook(wbFrom(aoa), "swiggy_w2.xlsx");
  assert.strictEqual(parsed.layout, "summary");
  assert.strictEqual(parsed.weeklyHint, true);
  const res = resolveLines(parsed, { originalname: "swiggy_w2.xlsx" }, {});
  assert.strictEqual(res.periodType, "weekly");
  assert.strictEqual(res.lines[0].month, "2026-10");
  const [p] = aggregate(res.lines, { platform: res.platform, periodType: res.periodType, fileName: "x" });
  assert.strictEqual(p.status, "reconciled");
});

test("Petpooja Order Report: Sub-Order Wise (real export)", () => {
  const fs = require("fs");
  const path = process.env.SUBORDER_FIXTURE || "/tmp/x/f.xlsx";
  if (!fs.existsSync(path)) return;
  const { isSubOrderSummaryWorkbook, parseChannelSummaryWorkbook } = require("../api/helpers/channelSummaryParser.helper");
  const wb = XLSX.read(fs.readFileSync(path), { type: "buffer", cellDates: true, dense: true });
  assert.ok(isSubOrderSummaryWorkbook(wb));
  const p = parseChannelSummaryWorkbook(wb, "f.xlsx");
  assert.deepStrictEqual(p.period, { from: "2026-10-01", to: "2026-10-31" });
  assert.strictEqual(p.rows.length, 16);
  assert.strictEqual(p.totals.bills, 1787);
  assert.strictEqual(p.totals.netSales, 799105.65);
  const by = (sub) => p.rows.find((r) => r.subOrderType === sub);
  assert.deepStrictEqual([by("Banglar Jhale Jhole - Swiggy").outlet, by("Banglar Jhale Jhole - Swiggy").channel], ["banaswadi", "swiggy"]);
  assert.deepStrictEqual([by("Banglar Jhale Jhole w - Zomato").outlet, by("Banglar Jhale Jhole w - Zomato").brand], ["whitefield", "Banglar Jhale Jhole"]);
  assert.strictEqual(by("Niraamish - W - Swiggy").outlet, "whitefield");
  assert.deepStrictEqual([by("Banglar Jhale Jhole -W - Ownly").outlet, by("Banglar Jhale Jhole -W - Ownly").channel], ["whitefield", "ownly"]);
  assert.deepStrictEqual([by("Take Away").outlet, by("Take Away").channel], ["banaswadi", "direct"]);
  assert.deepStrictEqual([by("NON VEG").outlet, by("NON VEG").restaurant], ["whitefield", "Banglar Jhale Jhole, Whitefield"]);
  const wf = p.rows.filter((r) => r.outlet === "whitefield");
  console.log("channel totals", JSON.stringify(Object.entries(p.rows.reduce((a, r) => ((a[`${r.outlet}/${r.channel}`] = Math.round(((a[`${r.outlet}/${r.channel}`] || 0) + r.netSales) * 100) / 100), a), {}))));
  assert.ok(wf.length >= 7);
});

test("Zomato Settlement Report (Order Level without headers)", () => {
  const fs = require("fs");
  const path = process.env.ZOMATO_FIXTURE || "/tmp/z/z.xlsx";
  if (!fs.existsSync(path)) return;
  const wb = XLSX.read(fs.readFileSync(path), { type: "buffer", cellDates: true, dense: true });
  const parsed = parsePayoutWorkbook(wb, "Zomato_Settlement_Report_22042748_26 Oct 2026_31 Oct 2026.xlsx");
  assert.strictEqual(parsed.detectedPlatform, "zomato");
  assert.strictEqual(parsed.lines.length, 5);
  const res = resolveLines(parsed, { originalname: "Zomato_Settlement_Report_22042748_26 Oct 2026_31 Oct 2026.xlsx" }, {});
  assert.strictEqual(res.periodType, "weekly");
  assert.ok(res.lines.every((l) => l.outlet_id === "banaswadi" && l.month === "2026-10" && l.account_id === "22042748"));
  const [p] = aggregate(res.lines, { platform: "zomato", periodType: "weekly", fileName: "z" });
  console.log("zomato", JSON.stringify(p));
  assert.strictEqual(p.status, "reconciled");
  assert.strictEqual(p.order_count, 5);
  assert.strictEqual(p.actual_bank_settlement, 939.59);
  assert.ok(res.warnings.some((w) => /outstanding/.test(w)));
});

test("Swiggy monthly annexure", () => {
  const fs = require("fs");
  const path = process.env.SWIGGY_FIXTURE || "/tmp/z/m.xlsx";
  if (!fs.existsSync(path)) return;
  const name = "monthly_annexure_881519_2026-09-01_6c6379ef.xlsx";
  const wb = XLSX.read(fs.readFileSync(path), { type: "buffer", cellDates: true, dense: true });
  const parsed = parsePayoutWorkbook(wb, name);
  assert.strictEqual(parsed.detectedPlatform, "swiggy");
  const res = resolveLines(parsed, { originalname: name }, {});
  const agg = aggregate(res.lines, { platform: "swiggy", periodType: res.periodType, fileName: name });
  console.log("swiggy", res.periodType, JSON.stringify(agg), res.warnings);
  const p = agg[0];
  assert.strictEqual(agg.length, 1);
  assert.strictEqual(p.month, "2026-09");
  assert.strictEqual(p.order_count, 259);
  assert.strictEqual(p.actual_bank_settlement, 75623.3);
  assert.strictEqual(p.status, "reconciled");
});
