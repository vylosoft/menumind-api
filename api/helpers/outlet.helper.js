/**
 * Outlet + channel detection (server port of the frontend rules):
 * 1. Hyphen in item name: right side = channel; left side ending with W → Whitefield, else Banaswadi.
 * 2. No hyphen: Take Away / Delivery → Banaswadi, Dine-in → Whitefield.
 * 3. Trailing standalone W / (W) / [W] → Whitefield.
 * 4. Default → Banaswadi.
 */
const TRAILING_W = /(?:[\s\-_/]+w|\s*\(w\)|\s*\[w\])$/i;

const detectOutletFromItem = (rawItem, rawVariant, orderType, category) => {
  const item = String(rawItem || "").trim();
  const variant = String(rawVariant || "").trim();
  const target = item || variant;

  if (/[-–—]/.test(target)) {
    const parts = target.split(/\s*[-–—]\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const right = parts[parts.length - 1];
      const leftParts = parts.slice(0, -1);
      const left = leftParts.join(" - ");
      const rightIsW = /^w$/i.test(right) || /\bw$/i.test(right);
      const leftIsW = TRAILING_W.test(left) || /\bw$/i.test(left) || /^w$/i.test(leftParts[leftParts.length - 1] || "");
      const channel = rightIsW ? undefined : right;

      if (leftIsW || rightIsW) {
        const clean = rightIsW ? left : left.replace(TRAILING_W, "").replace(/\s+w$/i, "").trim();
        return { outlet: "whitefield", cleanItemName: clean || left || item, channel };
      }
      return { outlet: "banaswadi", cleanItemName: left || item, channel };
    }
  }

  const ctx = `${item} ${variant} ${orderType || ""} ${category || ""}`.toLowerCase();
  if (/take ?-?away|delivery|parcel/.test(ctx)) return { outlet: "banaswadi", cleanItemName: item };
  if (/dine ?-?in/.test(ctx)) return { outlet: "whitefield", cleanItemName: item };
  if (TRAILING_W.test(item)) return { outlet: "whitefield", cleanItemName: item.replace(TRAILING_W, "").trim() || item };
  return { outlet: "banaswadi", cleanItemName: item };
};

/** Resolves an explicit outlet text (column value / file name) to a known outlet id, or null. */
const resolveOutletText = (text) => {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return null;
  if (t.includes("whitefield") || t === "w" || /(^|[\s\-_(])w\)?$/.test(t)) return "whitefield";
  if (t.includes("banaswadi") || t === "b") return "banaswadi";
  return null;
};

/** Normalizes any POS / aggregator channel text to swiggy | zomato | ownly | direct. */
const normalizeChannel = (...texts) => {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (t.includes("swiggy")) return "swiggy";
  if (t.includes("zomato")) return "zomato";
  if (t.includes("ownly")) return "ownly";
  return "direct";
};

module.exports = { detectOutletFromItem, resolveOutletText, normalizeChannel };
