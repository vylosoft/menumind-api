const PLATFORMS = Object.freeze(["swiggy", "zomato", "ownly"]);
const OUTLETS = Object.freeze(["banaswadi", "whitefield"]);
const PERIOD_TYPES = Object.freeze(["monthly", "weekly"]);

const ALLOWED_EXTENSIONS = Object.freeze([".xlsx", ".xls", ".csv"]);

const POS_LAYOUT_PRESETS = Object.freeze({
  "petpooja-item-wise": { headerRow: 5, dataStartRow: 6, sheetIndex: 0, skipFooterRows: 1 },
  "petpooja-highest-selling": { headerRow: 6, dataStartRow: 11, sheetIndex: 0, skipFooterRows: 1 },
  "standard-flat": { headerRow: 1, dataStartRow: 2, sheetIndex: 0, skipFooterRows: 0 },
});

const DB_INSERT_CHUNK = 500;

// Settlement difference tolerance (INR) before a payout is flagged as discrepancy
const SETTLEMENT_TOLERANCE = 1;
// Revenue match thresholds (% variance between POS and aggregator gross)
const MATCH_THRESHOLDS = Object.freeze({ matched: 2, minor: 5 });

module.exports = {
  PLATFORMS,
  OUTLETS,
  PERIOD_TYPES,
  ALLOWED_EXTENSIONS,
  POS_LAYOUT_PRESETS,
  DB_INSERT_CHUNK,
  SETTLEMENT_TOLERANCE,
  MATCH_THRESHOLDS,
};
