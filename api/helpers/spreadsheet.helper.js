const crypto = require("crypto");
const XLSX = require("xlsx");
const AppError = require("../../utils/AppError");

const MAX_ROWS_PER_SHEET = 200000;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const readWorkbook = (file) => {
  try {
    const wb = XLSX.read(file.buffer, {
      type: "buffer",
      cellDates: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      dense: true,
    });
    if (!wb.SheetNames || wb.SheetNames.length === 0) {
      throw new AppError(`"${file.originalname}" contains no worksheets`, 422);
    }
    return wb;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`"${file.originalname}" could not be read as a spreadsheet: ${err.message}`, 422);
  }
};

const sheetToMatrix = (wb, sheetName) => {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: true, raw: true });
  if (matrix.length > MAX_ROWS_PER_SHEET) {
    throw new AppError(`Sheet "${sheetName}" exceeds ${MAX_ROWS_PER_SHEET} rows`, 413);
  }
  return matrix;
};

const normalizeHeader = (h) =>
  String(h ?? "")
    .toLowerCase()
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();

/** Parses currency / accounting formatted numbers: "₹1,234.50", "(120.00)", "-45", "12%". */
const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return null;
  let s = String(v).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (/\bcr\b/i.test(s)) s = s.replace(/\bcr\b/i, "");
  if (/\bdr\b/i.test(s)) {
    neg = true;
    s = s.replace(/\bdr\b/i, "");
  }
  s = s.replace(/[₹$,\s%]|rs\.?|inr/gi, "");
  if (!/^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const pad = (n) => String(n).padStart(2, "0");
const validYmd = (y, m, d) => {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};

/** Normalizes Excel serials, Date objects and common Indian POS formats to YYYY-MM-DD (DD/MM preferred). */
const toIsoDate = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    // SheetJS returns local-midnight dates; add 12h to avoid TZ day shift
    const d = new Date(v.getTime() + 12 * 3600 * 1000);
    return validYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (typeof v === "number") {
    if (v < 20000 || v > 80000) return null;
    const p = XLSX.SSF.parse_date_code(v);
    return p ? validYmd(p.y, p.m, p.d) : null;
  }
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) return validYmd(+m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/))) return validYmd(2000 + +m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[\s-]+([a-z]{3,9})[\s,-]+(\d{4})/i))) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    return mo ? validYmd(+m[3], mo, +m[1]) : null;
  }
  if ((m = s.match(/^([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/i))) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)];
    return mo ? validYmd(+m[3], mo, +m[2]) : null;
  }
  return null;
};

/** Finds YYYY-MM in free text, e.g. "Zomato_Oct_2026.xlsx", "2026-10", "October 2026". */
const extractMonthFromText = (text) => {
  const s = String(text || "").toLowerCase();
  let m;
  if ((m = s.match(/(20\d{2})[-_ .](0[1-9]|1[0-2])(?!\d)/))) return `${m[1]}-${m[2]}`;
  if ((m = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*[-_ .']*(20\d{2}|\d{2})(?!\d)/))) {
    const y = m[2].length === 2 ? `20${m[2]}` : m[2];
    return `${y}-${pad(MONTHS[m[1]])}`;
  }
  return null;
};

const isTotalRow = (row) => {
  const first = row.find((c) => String(c ?? "").trim() !== "");
  const t = String(first ?? "").toLowerCase().trim();
  return (
    t === "total" ||
    t === "totals" ||
    t === "grand total" ||
    t === "sub total" ||
    t === "subtotal" ||
    t === "total qty" ||
    t.startsWith("printed by") ||
    t.startsWith("page ") ||
    t.startsWith("generated on")
  );
};

const isBlankRow = (row) => !row || !row.some((c) => c !== "" && c !== null && c !== undefined);

/** Builds unique header names from a header row (duplicate → "_2", blanks → "Column_N"). */
const buildHeaders = (rawHeaderRow) => {
  const seen = new Map();
  return (rawHeaderRow || []).map((v, i) => {
    let t = String(v ?? "").replace(/\s+/g, " ").trim() || `Column_${i + 1}`;
    const c = seen.get(t) || 0;
    seen.set(t, c + 1);
    if (c > 0) t = `${t}_${c + 1}`;
    return t;
  });
};

module.exports = {
  sha256,
  readWorkbook,
  sheetToMatrix,
  normalizeHeader,
  toNumber,
  toIsoDate,
  extractMonthFromText,
  isTotalRow,
  isBlankRow,
  buildHeaders,
};
