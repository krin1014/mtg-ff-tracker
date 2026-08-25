/**
 * Final Fantasy MTG Collection Tracker - Application Logic
 *
 * Supports dynamic available print variants per card (only showing the finishes
 * a given print actually comes in) and Final Fantasy flavor names / MTG names.
 *
 * Storage schema v3
 * -----------------
 * Collection state is wrapped in an envelope so that a future device-sync layer
 * can merge two collections without guessing which side is newer:
 *
 *   {
 *     schema: 3,
 *     deviceId: "abc123",         // which device last wrote
 *     updatedAt: 1699999999999,   // whole-collection stamp
 *     cards: {
 *       "<scryfall-uuid>": {
 *         variants: { nonfoil: 2, foil: 1, ... },
 *         serialNumbers: { serialized: "042/500" },
 *         condition: "Near Mint (NM)",
 *         location: "Binder 1, page 4",
 *         updatedAt: 1699999999999   // per-card stamp => per-card merge
 *       }
 *     }
 *   }
 *
 * Only cards that actually carry information are stored. Reading a card's state
 * never creates an entry (see readCard vs editCard) - that is what previously
 * caused every one of the 1,365 cards to be written to storage on first render.
 */

const SCHEMA_VERSION = 3;
const STORAGE_KEY = "ff_mtg_collection_v3";
const LEGACY_STORAGE_KEYS = ["ff_mtg_collection_v2_variants"];
const PREFS_KEY = "ff_mtg_ui_prefs_v1";

const DEFAULT_CONDITION = "Near Mint (NM)";

/**
 * Serialized cards have no reliable market price on Scryfall, so the value
 * estimate falls back to this when there is no foil price to scale from.
 * It is a placeholder, not a valuation.
 */
const SERIALIZED_FALLBACK_USD = 50;

// Application State
let collection = createEmptyCollection();
let currentView = "grid"; // 'grid' | 'table'
let currentPage = 1;
let pageSize = 60;
let filteredCards = [];
let activeGameFilter = "all";
let activeLocationFilter = "all";
let locationUiSignature = "";
let cardsById = new Map();
let searchDebounceTimer = null;

const CONDITION_OPTIONS = [
  "Near Mint (NM)",
  "Lightly Played (LP)",
  "Moderately Played (MP)",
  "Heavily Played (HP)",
  "Damaged (DMG)"
];

// Canonical display order for the FF game pills. Any game found in the data but
// missing from this list is appended, so a new set cannot silently vanish.
const GAME_ORDER = [
  "FF1", "FF2", "FF3", "FF4", "FF5", "FF6", "FF7", "FF8",
  "FF9", "FF10", "FF11", "FF12", "FF13", "FF14", "FF15", "FF16",
  "Spin-Off / Multi-Game", "Unknown"
];
let GAME_LIST = [];

/**
 * Catch-all buckets the data generator falls back to when a card matches no
 * specific Final Fantasy game. Right now that is a single "Punchcard" token in
 * the token set, which makes for a progress pill reading 0/1.
 *
 * These are hidden from the progress pills and the FF Game filter only. The
 * cards themselves stay in the binder and can still be collected, and they still
 * count towards overall completion - they simply do not get a game of their own.
 *
 * Listed rather than removed from the data so that a future set regeneration
 * cannot quietly reintroduce them.
 */
const HIDDEN_GAMES = ["Spin-Off / Multi-Game", "Unknown"];

// Master variant dictionary
const MASTER_VARIANTS = {
  "Non-Foil": { key: "nonfoil", label: "Non-Foil", short: "Non-Foil", icon: "\u{1F4C4}", priceKey: "price_usd", badgeClass: "active-nonfoil" },
  "Traditional Foil": { key: "foil", label: "Traditional Foil", short: "Foil", icon: "✨", priceKey: "price_foil", badgeClass: "active-foil" },
  "Surge Foil": { key: "surge", label: "Surge Foil", short: "Surge", icon: "\u{1F30A}", priceKey: "price_foil", badgeClass: "active-surge" },
  "Wave Foil": { key: "wave", label: "Chocobo Track Foil", short: "Chocobo Track", icon: "⚡", priceKey: "price_foil", badgeClass: "active-wave" },
  "Foil Etched": { key: "etched", label: "Foil Etched", short: "Etched", icon: "\u{1F48E}", priceKey: "price_etched", badgeClass: "active-foil" },
  "Promo": { key: "promo", label: "Promo / Prerelease", short: "Promo", icon: "\u{1F396}️", priceKey: "price_foil", badgeClass: "active-promo" },
  "Serialized": { key: "serialized", label: "Serialized", short: "Serial", icon: "\u{1F522}", priceKey: "price_foil", badgeClass: "active-serialized" },

  // Art cards do not come in foil - Wizards varnishes them instead. Their two
  // versions are the plain card and the artist's gold-stamped signature, so
  // that is what the Available Variants show for them.
  //
  // These deliberately REUSE the nonfoil and foil storage keys rather than
  // introducing new ones: the keys are what the collection is saved under and
  // what Code.gs syncs, so a count recorded before this change stays attached,
  // and the Google Sheet needs no new columns and no redeploy.
  "Basic": { key: "nonfoil", label: "Basic", short: "Basic", icon: "\u{1F4C4}", priceKey: "price_usd", badgeClass: "active-nonfoil" },
  "Signed": { key: "foil", label: "Signed", short: "Signed", icon: "\u{270D}️", priceKey: "price_foil", badgeClass: "active-foil" }
};

// Friendly labels for the filter dropdowns, which are generated from the data.
const SET_LABELS = {
  FIN: "FIN (Main Set)",
  FIC: "FIC (Commander)",
  FCA: "FCA (Through the Ages / Flavor Reprints)",
  AFIC: "AFIC (Art Cards - Commander)",
  AFIN: "AFIN (Art Cards - Main)",
  RFIN: "RFIN (Retro / Special)",
  PFIN: "PFIN (Prerelease & Promos)",
  TFIN: "TFIN (Tokens - Main)",
  TFIC: "TFIC (Tokens - Commander)",
  // Final Fantasy cards printed outside the Final Fantasy sets.
  PMEI: "PMEI (Media & Collaboration Promos)",
  PPRO: "PPRO (Pro Tour Promos)",
  PSPL: "PSPL (Spotlight Series)",
  PSS5: "PSS5 (Standard Showdown)",
  PF25: "PF25 (MagicFest 2025)",
  PW25: "PW25 (Wizards Play Network 2025)",
  WFIN: "WFIN (Asia WPN Promo Tokens)",
  SLD: "SLD (Secret Lair Drop)"
};

const VARIANT_LABELS = {
  "Basic/Non-foil": "Standard Print",
  "Traditional Foil": "Foil Print",
  "Surge Foil": "Surge Foil Print",
  "Wave Foil": "Chocobo Track Foil",
  "Foil Etched": "Foil Etched",
  "Promo": "Promo / Prerelease",
  "Serialized": "Serialized Print"
};

/**
 * The official name for a print variant, for the badge on a card tile.
 *
 * The raw data still says "Wave Foil" because that is the key the collection is
 * stored under and renaming it would detach every recorded count. Wizards calls
 * it Chocobo Track Foil, so that is what gets shown.
 */
function variantName(variant) {
  return variant === "Wave Foil" ? "Chocobo Track Foil" : variant;
}

const GAME_LABELS = {
  FF1: "Final Fantasy I (FF1)", FF2: "Final Fantasy II (FF2)", FF3: "Final Fantasy III (FF3)",
  FF4: "Final Fantasy IV (FF4)", FF5: "Final Fantasy V (FF5)", FF6: "Final Fantasy VI (FF6)",
  FF7: "Final Fantasy VII (FF7)", FF8: "Final Fantasy VIII (FF8)", FF9: "Final Fantasy IX (FF9)",
  FF10: "Final Fantasy X (FF10)", FF11: "Final Fantasy XI (FF11)", FF12: "Final Fantasy XII (FF12)",
  FF13: "Final Fantasy XIII (FF13)", FF14: "Final Fantasy XIV (FF14)", FF15: "Final Fantasy XV (FF15)",
  FF16: "Final Fantasy XVI (FF16)"
};

const COLOR_LABELS = { W: "White (W)", U: "Blue (U)", B: "Black (B)", R: "Red (R)", G: "Green (G)" };

const RARITY_ORDER = { Mythic: 5, Rare: 4, Special: 3, Uncommon: 2, Common: 1 };

/**
 * Wizards' official treatment names, from the Final Fantasy Card Image Gallery.
 *
 * A card's `treatment` is its frame - one of these six - and results are
 * grouped in this order. `treatments` is every official treatment that applies
 * to the printing, frame and finish together, which is what the filter matches
 * against. Anything not listed here sorts last.
 */
const TREATMENT_ORDER = ["Showcase", "Borderless", "Extended Art", "Full Art", "Default", "Art Card"];

// The finishes, in the order the filter should list them after the frames.
const TREATMENT_FINISHES = [
  "Scene Card", "Traditional Foil", "Surge Foil", "Chocobo Track Foil", "Neon Ink", "Serialized"
];

// Every official treatment, frames first, for the filter dropdown.
const TREATMENT_FILTER_ORDER = TREATMENT_ORDER.concat(TREATMENT_FINISHES);

/**
 * Sets in release order, main set first.
 *
 * Deliberately a fixed list rather than something derived from Scryfall's
 * release dates, because those dates cannot produce this order: the ten Final
 * Fantasy sets all launched on the same day, and the general promo collections
 * that happen to carry a Final Fantasy card have set dates running back to 1995
 * (Media Promos) and 2007 (Pro Tour Promos). Sorting by date would put those
 * ahead of FIN.
 *
 * Those promo collections simply go last within each print style. A set missing
 * from this list sorts after everything here, alphabetically.
 */
const SET_RELEASE_ORDER = [
  // 2025-06-13, the Final Fantasy launch
  "FIN", "FIC", "FCA", "AFIN", "TFIN", "TFIC", "PFIN", "RFIN", "PSS5", "WFIN",
  // 2025-12-05
  "AFIC",
  // Final Fantasy cards printed inside general promo collections
  "PSPL", "PF25", "PW25", "PMEI", "PPRO", "SLD"
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape a value for safe interpolation into HTML text or a quoted attribute. */
function esc(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/**
 * Art cards and some tokens arrive from Scryfall with both faces carrying the
 * same name, producing "Garland // Garland". Collapse those for display.
 */
function displayName(name) {
  const raw = String(name || "");
  if (raw.includes(" // ")) {
    const parts = raw.split(" // ").map(part => part.trim());
    if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
  }
  return raw;
}

const CURRENCY_SYMBOL = { usd: "$", eur: "€" };

/**
 * Format a price. Defaults to dollars, but Scryfall has no USD price at all for
 * the art cards and a couple of promos - only euros - so the symbol has to
 * follow the number rather than being assumed.
 */
/** Purchase figures are always dollars - there is no currency picker. */
function money2(value) {
  return money(value, "usd");
}

/** MASTER_VARIANTS indexed by storage key, for looking a finish up by key. */
const MASTER_VARIANTS_BY_KEY = (function () {
  const out = {};
  for (const name in MASTER_VARIANTS) {
    const def = MASTER_VARIANTS[name];
    if (!out[def.key]) out[def.key] = def;
  }
  return out;
})();

/** Dollars with thousands separators, for the dashboard totals. */
function usd(value) {
  const n = typeof value === "number" && isFinite(value) ? value : 0;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function money(value, currency) {
  if (typeof value !== "number" || !isFinite(value)) return "--";
  return `${CURRENCY_SYMBOL[currency] || "$"}${value.toFixed(2)}`;
}

/**
 * A price and the currency it is quoted in.
 *
 * Scryfall prices most cards in both USD and EUR, but the Art Series, the Scene
 * Box and a couple of promos are EUR-only - including a Cloud promo worth some
 * six hundred euros. Showing "--" for those was hiding real money, so the euro
 * price is used when there is no dollar one. The two are never mixed in a
 * calculation, and the symbol always says which is which.
 */
const PRICE_FALLBACK = {
  price_usd: "price_eur",
  price_foil: "price_eur_foil",
  price_etched: "price_eur_foil"
};

// ---------------------------------------------------------------------------
// Pricing engine
//
// One place decides what a finish is worth. The variant-to-price mapping used
// to exist three times over - MASTER_VARIANTS.priceKey, the dashboard's own
// inline block, and bestPrice() - and they disagreed, which is what made the
// paid-versus-market figures wrong: a Surge Foil was valued at the non-foil
// price because bestPrice() prefers price_usd.
// ---------------------------------------------------------------------------

/**
 * The market price of one copy of a card in a given finish.
 *
 * Fallbacks, in order:
 *   Foil Etched                      etched -> foil -> non-foil
 *   Foil / Surge / Chocobo Track /
 *     Promo / Serialized / Signed    foil   -> non-foil
 *   Non-Foil / Basic                 non-foil -> foil
 *
 * Each step also falls back from dollars to euros, because the Art Series, the
 * Scene Box and a few promos have no dollar price at all.
 *
 * `variant` may be a MASTER_VARIANTS name ("Surge Foil"), a storage key
 * ("surge"), or a variant definition object - the three are used in different
 * parts of the app and all of them end up here.
 *
 * Returns { value, currency }. value is 0 when nothing is known, never null,
 * so arithmetic downstream is always safe.
 */
const VARIANT_PRICE_ORDER = {
  nonfoil: ["price_usd", "price_foil"],
  foil: ["price_foil", "price_usd"],
  surge: ["price_foil", "price_usd"],
  wave: ["price_foil", "price_usd"],
  promo: ["price_foil", "price_usd"],
  serialized: ["price_foil", "price_usd"],
  etched: ["price_etched", "price_foil", "price_usd"]
};

function variantStorageKey(variant) {
  if (!variant) return "nonfoil";
  if (typeof variant === "object") return variant.key || "nonfoil";
  if (VARIANT_PRICE_ORDER[variant]) return variant;            // already a key
  const def = MASTER_VARIANTS[variant];                        // a display name
  return def ? def.key : "nonfoil";
}

function getActiveUnitPrice(card, variant) {
  const chain = VARIANT_PRICE_ORDER[variantStorageKey(variant)] || VARIANT_PRICE_ORDER.nonfoil;
  for (let i = 0; i < chain.length; i++) {
    const found = cardPrice(card, chain[i]);
    if (found.value !== null) return found;
  }
  return { value: 0, currency: "usd" };
}

/**
 * Everything money-related about one card, from what is actually owned.
 *
 * This app records a quantity PER FINISH rather than a single chosen variant,
 * so a card can be two non-foils and a surge foil at once. The market value is
 * therefore the sum over the finishes owned, each at its own price - not the
 * quantity multiplied by one "active" price, which would misprice every card
 * held in more than one finish.
 *
 * Purchase price is a single figure per card, so cost is quantity times price.
 * Cards bought at different prices over time are outside what one field can say.
 */
function cardFinancials(card, entry) {
  const inventory = entryInventory(entry);

  let quantity = 0;         // every copy held
  let marketValue = 0;      // every copy held, at today's price
  let costBasis = 0;        // only the lots with a purchase price recorded
  let pricedMarket = 0;     // today's price of exactly those lots
  let pricedQty = 0;
  let currency = "usd";
  let sawPrice = false;
  let mixedCurrency = false;

  // Per-lot detail, in the order the lots were added.
  const lots = inventory.map(lot => {
    const unit = getActiveUnitPrice(card, lot.variant);
    // A price typed in before any copy is logged still describes one purchase,
    // so it is costed as a single copy rather than silently doing nothing.
    const counted = lot.quantity > 0 ? lot.quantity : (lot.purchasePrice !== null ? 1 : 0);

    if (lot.quantity > 0) {
      quantity += lot.quantity;
      marketValue += lot.quantity * unit.value;
      if (unit.value > 0) {
        if (!sawPrice) {
          currency = unit.currency;
          sawPrice = true;
        } else if (unit.currency !== currency) {
          mixedCurrency = true;
        }
      }
    }

    if (lot.purchasePrice !== null && counted > 0) {
      costBasis += lot.purchasePrice * counted;
      pricedMarket += unit.value * counted;
      pricedQty += counted;
    }

    return {
      id: lot.id,
      variant: lot.variant,
      quantity: lot.quantity,
      countedQty: counted,
      purchasePrice: lot.purchasePrice,
      purchaseDate: lot.purchaseDate,
      condition: lot.condition,
      unitMarket: unit.value,
      currency: unit.currency,
      cost: lot.purchasePrice === null ? 0 : lot.purchasePrice * counted,
      market: unit.value * counted
    };
  });

  // Per-finish rollup, kept because the variant table, the tile and the sheet
  // all still think in finishes. Same numbers, grouped differently.
  const byKey = {};
  lots.forEach(lot => {
    const line = byKey[lot.variant] || (byKey[lot.variant] = {
      key: lot.variant, quantity: 0, unitMarket: lot.unitMarket,
      currency: lot.currency, paid: null, date: "", cost: 0, market: 0, lots: 0
    });
    line.quantity += lot.quantity;
    line.cost += lot.cost;
    line.market += lot.market;
    line.lots += 1;
    if (lot.purchasePrice !== null) {
      // The weighted average across this finish's lots, which is the only
      // single number that can honestly stand for several different prices.
      const paidQty = (line.paidQty || 0) + lot.countedQty;
      line.paid = ((line.paid || 0) * (line.paidQty || 0) + lot.cost) / (paidQty || 1);
      line.paidQty = paidQty;
    }
    if (lot.purchaseDate && (!line.date || lot.purchaseDate < line.date)) {
      line.date = lot.purchaseDate;
    }
  });
  const lines = Object.keys(byKey).map(key => byKey[key]);

  // A finish the price table has never heard of still counts as owned.
  const variants = (entry && entry.variants) || {};
  for (const key in variants) {
    if (!(key in VARIANT_PRICE_ORDER)) quantity += variants[key] || 0;
  }

  const netGainLoss = pricedMarket - costBasis;

  return {
    lots: lots,
    lines: lines,
    quantity: quantity,
    marketValue: marketValue,
    costBasis: costBasis,
    pricedMarket: pricedMarket,
    pricedQty: pricedQty,
    // What one copy cost on average, across the copies that have a price.
    averageCost: pricedQty > 0 ? costBasis / pricedQty : null,
    currency: currency,
    // Gain or loss is measured over the copies whose cost is actually known.
    // Comparing the market value of EVERY copy against the cost of only SOME
    // reports a profit the moment an unpriced copy is added, which is why this
    // uses pricedMarket rather than marketValue. With a price on every copy the
    // two are identical.
    netGainLoss: netGainLoss,
    // Undefined rather than zero when there is nothing to divide by, so a card
    // with no purchase price is not reported as breaking even.
    roiPercent: costBasis > 0 ? (netGainLoss / costBasis) * 100 : null,
    // Only meaningful when the purchase and the market price are the same unit.
    comparable: costBasis > 0 && pricedMarket > 0 && currency === "usd" && !mixedCurrency
  };
}

/** "USD" or "EUR" - so a tile never labels a euro price as dollars. */
function priceUnit(card, field) {
  return cardPrice(card, field).currency.toUpperCase();
}

function cardPrice(card, field) {
  const direct = card[field];
  if (typeof direct === "number") return { value: direct, currency: "usd" };
  const alt = PRICE_FALLBACK[field];
  const euro = alt ? card[alt] : null;
  if (typeof euro === "number") return { value: euro, currency: "eur" };
  return { value: null, currency: "usd" };
}

function nowMs() {
  return Date.now();
}

function makeDeviceId() {
  return `dev_${Math.random().toString(36).slice(2, 8)}${nowMs().toString(36).slice(-4)}`;
}

function isSmallScreen() {
  return window.matchMedia("(max-width: 767px)").matches;
}

// ---------------------------------------------------------------------------
// Collection state: load, migrate, read, mutate, prune, persist
// ---------------------------------------------------------------------------

function createEmptyCollection() {
  return { schema: SCHEMA_VERSION, deviceId: makeDeviceId(), updatedAt: nowMs(), cards: {} };
}

function createCardEntry() {
  return {
    variants: { nonfoil: 0, foil: 0, surge: 0, wave: 0, etched: 0, promo: 0, serialized: 0 },
    serialNumbers: {},
    condition: DEFAULT_CONDITION,
    location: "",
    // What YOU paid and when, PER FINISH. A card held as a non-foil bought for
    // two dollars and a surge foil bought for forty is two different purchases,
    // and one price per card cannot say that - it multiplied the first price
    // across every copy, whatever finish they were.
    //
    //   acquired: { surge: { price: 40, date: "2026-08-12" }, ... }
    //
    // Only finishes actually bought appear. See migrateAcquired() for how the
    // old single-value shape is carried over.
    acquired: {},
    // One entry per purchase lot; see normaliseInventory(). variants above is
    // derived from this, never assigned to directly.
    inventory: [],
    updatedAt: nowMs()
  };
}

/**
 * Purchase date, as YYYY-MM-DD or "".
 *
 * Anything else is discarded rather than stored: this round-trips through a
 * Google Sheet cell, where a hand edit can leave a real Date, a serial number,
 * or free text, and the date input would silently reject a bad value anyway.
 */
function normaliseAcquiredDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const probe = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return isNaN(probe.getTime()) ? "" : `${match[1]}-${match[2]}-${match[3]}`;
}

/** Purchase price as a number, or null. Currency symbols and commas are fine. */
function normaliseAcquiredPrice(value) {
  if (typeof value === "number") return isFinite(value) && value >= 0 ? value : null;
  const text = String(value == null ? "" : value).replace(/[^0-9.\-]/g, "").trim();
  if (!text) return null;
  const num = parseFloat(text);
  return isFinite(num) && num >= 0 ? Math.round(num * 100) / 100 : null;
}

/**
 * Per-finish purchase records, from whatever shape the source used.
 *
 * Accepts the current { acquired: { surge: {price, date} } } shape and the
 * older single acquiredPrice / acquiredDate pair, which is carried onto the
 * finish most likely to have been the one bought: the one owned in the largest
 * number, or non-foil when nothing is owned. Nothing is discarded.
 */
function normaliseAcquired(raw) {
  const out = {};

  const source = raw && typeof raw.acquired === "object" && raw.acquired ? raw.acquired : {};
  for (const key in source) {
    const record = source[key];
    if (!record || typeof record !== "object") continue;
    const price = normaliseAcquiredPrice(record.price);
    const date = normaliseAcquiredDate(record.date);
    if (price === null && !date) continue;
    out[key] = { price: price, date: date };
  }

  // The old shape, if this entry still carries it and has not been migrated.
  const legacyPrice = normaliseAcquiredPrice(raw && raw.acquiredPrice);
  const legacyDate = normaliseAcquiredDate(raw && raw.acquiredDate);
  if ((legacyPrice !== null || legacyDate) && !Object.keys(out).length) {
    const variants = (raw && raw.variants) || {};
    let target = "nonfoil";
    let most = 0;
    for (const key in variants) {
      if ((variants[key] || 0) > most) {
        most = variants[key];
        target = key;
      }
    }
    out[target] = { price: legacyPrice, date: legacyDate };
  }

  return out;
}

// ---------------------------------------------------------------------------
// Inventory: one entry per purchase lot
//
// A card held as three copies bought on three days at three prices is three
// facts, not one. The previous model kept a single price per finish, so a
// second purchase either overwrote the first or was priced at it - either way
// the cost basis, the valuation and the gain/loss were wrong.
//
//   entry.inventory = [
//     { id, quantity, purchasePrice, purchaseDate, variant, condition },
//     ...
//   ]
//
// `variant` is the storage key ("nonfoil", "surge", ...), not the display name.
// The keys are what the collection is saved under and what Code.gs syncs, so a
// label change must never be able to detach a lot from its card. Display names
// are accepted on the way in and converted - variantStorageKey() takes either.
//
// entry.variants stays, DERIVED from this array rather than stored beside it.
// Every chip, filter, table cell, CSV column and sheet column already reads it;
// deriving keeps them all correct by construction and leaves exactly one place
// where a quantity can be changed.
// ---------------------------------------------------------------------------

let lotSequence = 0;

/** Unique enough across devices: time, a counter, and randomness. */
function makeLotId() {
  lotSequence = (lotSequence + 1) % 100000;
  return "lot_" + Date.now().toString(36) + "_" + lotSequence.toString(36) + "_" +
         Math.random().toString(36).slice(2, 8);
}

/** One lot, cleaned. Returns null for anything that carries no information. */
function normaliseLot(raw, fallbackCondition) {
  if (!raw || typeof raw !== "object") return null;

  const quantity = Math.max(0, parseInt(raw.quantity, 10) || 0);
  const price = normaliseAcquiredPrice(
    raw.purchasePrice !== undefined ? raw.purchasePrice : raw.price);
  const date = normaliseAcquiredDate(
    raw.purchaseDate !== undefined ? raw.purchaseDate : raw.date);

  // A lot with no copies and no price is not a purchase, it is a leftover.
  if (quantity === 0 && price === null && !date) return null;

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : makeLotId(),
    quantity: quantity,
    purchasePrice: price,
    purchaseDate: date,
    variant: variantStorageKey(raw.variant),
    condition: typeof raw.condition === "string" && raw.condition
      ? raw.condition
      : (fallbackCondition || DEFAULT_CONDITION)
  };
}

/**
 * The inventory for an entry, from whatever shape the source used.
 *
 * Three sources, in order of preference:
 *   1. entry.inventory - the current shape.
 *   2. entry.variants + entry.acquired - the per-finish shape. Each owned
 *      finish becomes one lot carrying that finish's recorded price, so no
 *      figure is lost and the numbers do not move at the moment of migration.
 *   3. Nothing.
 *
 * A price recorded against a finish with no copies logged becomes a zero
 * quantity lot rather than being dropped - it was deliberately typed in.
 */
function normaliseInventory(raw) {
  const condition = typeof raw.condition === "string" && raw.condition
    ? raw.condition : DEFAULT_CONDITION;

  if (Array.isArray(raw.inventory)) {
    const out = [];
    const seen = {};
    for (let i = 0; i < raw.inventory.length; i++) {
      const lot = normaliseLot(raw.inventory[i], condition);
      if (!lot) continue;
      // Two lots sharing an id would make edit and delete ambiguous.
      if (seen[lot.id]) lot.id = makeLotId();
      seen[lot.id] = true;
      out.push(lot);
    }
    return out;
  }

  const variants = raw.variants && typeof raw.variants === "object" ? raw.variants : {};
  const acquired = normaliseAcquired(raw);
  const out = [];
  const keys = {};
  for (const key in variants) keys[key] = true;
  for (const key in acquired) keys[key] = true;

  for (const key in keys) {
    const quantity = Math.max(0, parseInt(variants[key], 10) || 0);
    const record = acquired[key] || {};
    const price = record.price === undefined ? null : record.price;
    const date = record.date || "";
    if (quantity === 0 && price === null && !date) continue;
    out.push({
      id: makeLotId(),
      quantity: quantity,
      purchasePrice: price,
      purchaseDate: date,
      variant: key,
      condition: condition
    });
  }
  return out;
}

/**
 * The per-finish { price, date } summary, derived from the lots.
 *
 * Kept only so an older device and the sheet's paid_* / bought_* columns still
 * show something sensible. Two lots of the same finish collapse to their
 * quantity-weighted average price and their earliest date, which is the honest
 * one-number answer to "what did these cost". Nothing reads it back as truth -
 * normaliseInventory only consults it when there is no inventory array at all.
 */
function summariseAcquired(inventory) {
  const totals = {};
  for (let i = 0; i < inventory.length; i++) {
    const lot = inventory[i];
    if (lot.purchasePrice === null && !lot.purchaseDate) continue;
    const bucket = totals[lot.variant] || (totals[lot.variant] = {
      cost: 0, qty: 0, date: ""
    });
    if (lot.purchasePrice !== null) {
      const count = lot.quantity > 0 ? lot.quantity : 1;
      bucket.cost += lot.purchasePrice * count;
      bucket.qty += count;
    }
    if (lot.purchaseDate && (!bucket.date || lot.purchaseDate < bucket.date)) {
      bucket.date = lot.purchaseDate;
    }
  }

  const out = {};
  for (const key in totals) {
    const bucket = totals[key];
    out[key] = {
      price: bucket.qty > 0 ? Math.round((bucket.cost / bucket.qty) * 100) / 100 : null,
      date: bucket.date
    };
  }
  return out;
}

/** The per-finish quantity map that the rest of the app reads. */
function deriveVariants(inventory) {
  const out = { nonfoil: 0, foil: 0, surge: 0, wave: 0, etched: 0, promo: 0, serialized: 0 };
  for (let i = 0; i < inventory.length; i++) {
    const lot = inventory[i];
    out[lot.variant] = (out[lot.variant] || 0) + lot.quantity;
  }
  return out;
}

/**
 * Put entry.variants back in step with entry.inventory.
 *
 * Called after every write. Nothing else may assign to entry.variants - it is
 * a projection, and two writable copies of the same number is how they drift.
 */
function syncEntryVariants(entry) {
  entry.variants = deriveVariants(entry.inventory || []);
  return entry;
}

function entryInventory(entry) {
  return (entry && entry.inventory) || [];
}

/** The lots for one finish, oldest first. */
function lotsForVariant(entry, variantKey) {
  const key = variantStorageKey(variantKey);
  return entryInventory(entry).filter(lot => lot.variant === key);
}

// ---------------------------------------------------------------------------
// Inventory mutation
//
// Every one of these ends the same way: sync the derived quantity map, refresh
// the derived per-finish summary, save, redraw. Anything that changes a lot
// must go through here so those four steps cannot be forgotten.
// ---------------------------------------------------------------------------

function commitInventory(cardId, entry, force) {
  syncEntryVariants(entry);
  entry.acquired = summariseAcquired(entry.inventory);

  // Nothing owned and nothing recorded: clear what described the copies, the
  // same rule removal has always followed.
  if (!entry.inventory.length) {
    entry.serialNumbers = {};
    entry.location = "";
    entry.condition = DEFAULT_CONDITION;
  }

  saveCollectionState();
  refreshCardUI(cardId);
  if (modalCardId === cardId) refreshInventoryPanel(cardId, force);
}

/** Add a lot. Returns its id so the UI can focus the row it just made. */
function addInventoryLot(cardId, patch) {
  const card = cardsById.get(cardId);
  const entry = editCard(cardId);
  const defs = card ? getCardVariantDefs(card) : [];
  const fallbackVariant = defs.length ? defs[0].key : "nonfoil";

  const lot = normaliseLot({
    quantity: patch && patch.quantity !== undefined ? patch.quantity : 1,
    purchasePrice: patch ? patch.purchasePrice : null,
    purchaseDate: patch ? patch.purchaseDate : "",
    variant: patch && patch.variant ? patch.variant : fallbackVariant,
    condition: (patch && patch.condition) || entry.condition
  }, entry.condition);

  // normaliseLot rejects a lot with no copies and no price; an explicit "add a
  // copy" always means at least one.
  const created = lot || normaliseLot({ quantity: 1, variant: fallbackVariant }, entry.condition);
  entry.inventory.push(created);
  commitInventory(cardId, entry, true);
  return created.id;
}

function updateInventoryLot(cardId, lotId, patch) {
  const entry = editCard(cardId);
  const lot = entry.inventory.find(item => item.id === lotId);
  if (!lot) return;

  if (patch.quantity !== undefined) lot.quantity = Math.max(0, parseInt(patch.quantity, 10) || 0);
  if (patch.purchasePrice !== undefined) lot.purchasePrice = normaliseAcquiredPrice(patch.purchasePrice);
  if (patch.purchaseDate !== undefined) lot.purchaseDate = normaliseAcquiredDate(patch.purchaseDate);
  if (patch.variant !== undefined) lot.variant = variantStorageKey(patch.variant);
  if (patch.condition !== undefined) lot.condition = patch.condition || DEFAULT_CONDITION;

  // Emptied of both copies and price, it is no longer a purchase. Losing a row
  // changes the shape of the panel, so that redraw cannot wait for focus.
  let dropped = false;
  if (lot.quantity === 0 && lot.purchasePrice === null && !lot.purchaseDate) {
    entry.inventory = entry.inventory.filter(item => item.id !== lotId);
    dropped = true;
  }
  commitInventory(cardId, entry, dropped);
}

function removeInventoryLot(cardId, lotId) {
  const entry = editCard(cardId);
  entry.inventory = entry.inventory.filter(item => item.id !== lotId);
  commitInventory(cardId, entry, true);
}

/**
 * Set the total quantity of one finish, reconciling the lots underneath.
 *
 * This is what the tile chips, the modal steppers and the table cells drive.
 * Adding goes to the newest lot that has no price recorded, so casual counting
 * does not litter the breakdown with one-copy lots; only if there is no such
 * lot is one created. Removing takes from the unpriced lots first, newest
 * first, and only then from priced ones - a recorded purchase is the last
 * thing to be destroyed.
 */
function reconcileVariantQuantity(entry, variantKey, target) {
  const key = variantStorageKey(variantKey);
  const mine = entry.inventory.filter(lot => lot.variant === key);
  const current = mine.reduce((sum, lot) => sum + lot.quantity, 0);
  let delta = Math.max(0, target) - current;

  if (delta > 0) {
    const open = mine.filter(lot => lot.purchasePrice === null && !lot.purchaseDate);
    if (open.length) {
      open[open.length - 1].quantity += delta;
    } else {
      entry.inventory.push(normaliseLot(
        { quantity: delta, variant: key, condition: entry.condition }, entry.condition));
    }
    return;
  }

  // Stepping a finish to zero is a removal, and removal takes everything with
  // it - the purchase records included. Keeping a priced lot behind at zero
  // copies would leave the entry non-empty forever, which is exactly what used
  // to strand a removed card's location and condition in the sheet.
  if (target <= 0) {
    entry.inventory = entry.inventory.filter(lot => lot.variant !== key);
    return;
  }

  let owed = -delta;
  const order = mine.filter(lot => lot.purchasePrice === null && !lot.purchaseDate).reverse()
    .concat(mine.filter(lot => lot.purchasePrice !== null || lot.purchaseDate).reverse());
  for (let i = 0; i < order.length && owed > 0; i++) {
    const take = Math.min(order[i].quantity, owed);
    order[i].quantity -= take;
    owed -= take;
  }

  // Reduced but not removed: a lot emptied of copies keeps its place only if it
  // still records a price. A price entered before the first copy is logged is
  // deliberate data and lives in exactly that shape.
  entry.inventory = entry.inventory.filter(
    lot => lot.quantity > 0 || lot.purchasePrice !== null || lot.purchaseDate);
}

/** The purchase record for one finish, or an empty one. Never null. */
function acquiredFor(entry, variantKey) {
  const all = (entry && entry.acquired) || {};
  const record = all[variantKey];
  return {
    price: record && typeof record.price === "number" ? record.price : null,
    date: record && typeof record.date === "string" ? record.date : ""
  };
}

/**
 * A frozen stand-in returned by readCard for cards with no stored state.
 * Frozen so that an accidental write fails loudly rather than silently
 * mutating a shared object.
 */
const EMPTY_CARD_ENTRY = Object.freeze({
  variants: Object.freeze({ nonfoil: 0, foil: 0, surge: 0, wave: 0, etched: 0, promo: 0, serialized: 0 }),
  serialNumbers: Object.freeze({}),
  condition: DEFAULT_CONDITION,
  location: "",
  acquired: Object.freeze({}),
  inventory: Object.freeze([]),
  updatedAt: 0
});

/** Read-only access. Never creates an entry. */
function readCard(cardId) {
  return collection.cards[cardId] || EMPTY_CARD_ENTRY;
}

/** Write access. Creates the entry on demand and stamps it. */
function editCard(cardId) {
  let entry = collection.cards[cardId];
  if (!entry) {
    entry = createCardEntry();
    collection.cards[cardId] = entry;
  }
  if (!Array.isArray(entry.inventory)) entry.inventory = normaliseInventory(entry);
  if (!entry.serialNumbers) entry.serialNumbers = {};
  if (!entry.condition) entry.condition = DEFAULT_CONDITION;
  syncEntryVariants(entry);
  entry.updatedAt = nowMs();
  return entry;
}

function entryTotalQty(entry) {
  const variants = entry.variants || {};
  let sum = 0;
  for (const key in variants) sum += Number(variants[key]) || 0;
  return sum;
}

function getCardTotalQty(cardId) {
  return entryTotalQty(readCard(cardId));
}

function isCardOwned(cardId) {
  return getCardTotalQty(cardId) > 0;
}

/** True when an entry holds nothing worth persisting. */
function isEmptyEntry(entry) {
  if (!entry) return true;
  if (entryTotalQty(entry) > 0) return false;
  if (entry.location) return false;
  if (entry.condition && entry.condition !== DEFAULT_CONDITION) return false;
  const serials = entry.serialNumbers || {};
  for (const key in serials) {
    if (serials[key]) return false;
  }
  // A price typed in before the first copy is logged is real data, not an empty
  // entry - do not prune it away.
  if (entryInventory(entry).length) return false;
  const acquired = entry.acquired || {};
  for (const key in acquired) {
    const record = acquired[key];
    if (record && (record.price !== null || record.date)) return false;
  }
  return true;
}

/**
 * Drop entries that carry no information AND were never actually touched.
 *
 * An entry the user deliberately emptied (last copy sold, count stepped back to
 * zero) is KEPT, as a zeroed row with a timestamp. That row is what tells the
 * other device "this was removed, and here is when". Delete it instead and the
 * next sync would see the other device's older non-zero row, decide it was the
 * only opinion available, and resurrect the card.
 *
 * Nothing here can grow without bound: entries are only ever created by an
 * actual edit (see editCard), never by reading.
 */
function pruneCollection() {
  let removed = 0;
  for (const id in collection.cards) {
    const entry = collection.cards[id];
    if (isEmptyEntry(entry) && !entry.updatedAt) {
      delete collection.cards[id];
      removed++;
    }
  }
  return removed;
}

/** Normalise anything read off disk into a valid schema-v3 envelope. */
function normaliseCollection(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  // v3 envelope
  if (raw.cards && typeof raw.cards === "object" && !Array.isArray(raw.cards)) {
    const out = {
      schema: SCHEMA_VERSION,
      deviceId: typeof raw.deviceId === "string" ? raw.deviceId : makeDeviceId(),
      updatedAt: Number(raw.updatedAt) || nowMs(),
      cards: {}
    };
    for (const id in raw.cards) {
      const entry = normaliseEntry(raw.cards[id]);
      if (entry) out.cards[id] = entry;
    }
    return out;
  }

  // v2: a flat { cardId: entry } map with no envelope
  const looksLikeV2 = Object.keys(raw).some(key => {
    const value = raw[key];
    return value && typeof value === "object" && ("variants" in value || "condition" in value);
  });
  if (!looksLikeV2) return null;

  const out = createEmptyCollection();
  for (const id in raw) {
    const entry = normaliseEntry(raw[id]);
    if (entry) out.cards[id] = entry;
  }
  return out;
}

function normaliseEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const base = createCardEntry();

  // Lots first, then the quantity map from them. Reading a pre-inventory entry
  // builds the lots out of variants + acquired, so the figures on screen do not
  // move at the moment a device upgrades.
  base.inventory = normaliseInventory(raw);
  syncEntryVariants(base);

  // A finish key the price table has never heard of still counts as owned, and
  // deriveVariants only knows the seven it lists. Carry the rest across.
  const variants = raw.variants && typeof raw.variants === "object" ? raw.variants : {};
  for (const key in variants) {
    if (!(key in base.variants)) {
      base.variants[key] = Math.max(0, parseInt(variants[key], 10) || 0);
    }
  }

  base.serialNumbers = raw.serialNumbers && typeof raw.serialNumbers === "object" ? Object.assign({}, raw.serialNumbers) : {};
  base.condition = typeof raw.condition === "string" && raw.condition ? raw.condition : DEFAULT_CONDITION;
  base.location = typeof raw.location === "string" ? raw.location : "";
  // Kept as a derived summary so an older device, or a sheet written by an
  // older script, still sees a price per finish. Never read back as truth.
  base.acquired = summariseAcquired(base.inventory);
  base.updatedAt = Number(raw.updatedAt) || nowMs();
  return base;
}

function loadCollectionState() {
  let loaded = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) loaded = normaliseCollection(JSON.parse(saved));
  } catch (e) {
    console.error("Failed to load collection state from localStorage", e);
  }

  if (!loaded) {
    // One-time migration from the pre-v3 flat storage key.
    for (const legacyKey of LEGACY_STORAGE_KEYS) {
      try {
        const legacy = localStorage.getItem(legacyKey);
        if (!legacy) continue;
        const migrated = normaliseCollection(JSON.parse(legacy));
        if (migrated) {
          loaded = migrated;
          console.info(`Migrated collection from "${legacyKey}" to schema v${SCHEMA_VERSION}.`);
          break;
        }
      } catch (e) {
        console.error(`Failed to migrate legacy collection from "${legacyKey}"`, e);
      }
    }
  }

  collection = loaded || createEmptyCollection();
  repairRemovedCards();
  pruneCollection();
}

/**
 * One-time repair for cards removed BEFORE removal learned to clear up after
 * itself.
 *
 * setVariantQuantity now wipes the location, condition, serial number and
 * purchase records when the last copy goes - but only at the moment it goes.
 * Cards removed before that fix existed still carry every original detail, in
 * localStorage and, because the sheet mirrors what this device sends, in the
 * sheet too. Nothing would ever have repaired them: a routine sync only sends
 * cards edited since the last one, and these were edited long ago.
 *
 * Each repaired entry is re-stamped so it goes up on the next sync and clears
 * the sheet row as well.
 *
 * This clears the purchase record too, which also removes a price typed in for
 * a card not owned yet. That combination is indistinguishable from a removed
 * card after the fact, and "removed means everything goes" is the rule that was
 * asked for. Typing a price without owning a copy still works from here on -
 * only quantity changes clear anything.
 */
function repairRemovedCards() {
  if (localStorage.getItem(REMOVAL_REPAIR_KEY)) return;

  let repaired = 0;
  for (const id in collection.cards) {
    const entry = collection.cards[id];
    if (!entry || entryTotalQty(entry) > 0) continue;

    const hadDetails =
      Boolean(entry.location) ||
      (entry.condition && entry.condition !== DEFAULT_CONDITION) ||
      Object.keys(entry.serialNumbers || {}).some(key => entry.serialNumbers[key]) ||
      Object.keys(entry.acquired || {}).length > 0 ||
      entryInventory(entry).length > 0;
    if (!hadDetails) continue;

    entry.acquired = {};
    entry.inventory = [];
    entry.serialNumbers = {};
    entry.location = "";
    entry.condition = DEFAULT_CONDITION;
    entry.updatedAt = nowMs();
    repaired++;
  }

  try {
    localStorage.setItem(REMOVAL_REPAIR_KEY, String(nowMs()));
  } catch (e) {
    // Out of storage: the repair still ran, it will simply run again next time,
    // which is harmless because it is idempotent.
    console.warn("Could not record the removal repair", e);
  }

  if (repaired > 0) {
    console.info(`Cleared leftover details on ${repaired} removed card(s).`);
    collection.updatedAt = nowMs();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
    } catch (e) {
      console.error("Could not save the removal repair", e);
    }
  }
}

function saveCollectionState(toastMessage = null) {
  pruneCollection();
  collection.schema = SCHEMA_VERSION;
  collection.updatedAt = nowMs();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
    if (toastMessage) showToast(toastMessage);
  } catch (e) {
    console.error("Failed to save collection state", e);
    showToast("Could not save - device storage may be full", true);
  }
  updateDashboardStats();
  // The device copy is saved first and always. Pushing to the sheet is a
  // background job, so a slow network never blocks tapping in cards.
  scheduleSyncPush();
}

// ---------------------------------------------------------------------------
// UI preferences (view mode, sort, filters, page size)
// ---------------------------------------------------------------------------

const FILTER_IDS = ["filterOwned", "filterGame", "filterSet", "filterVariant",
  "filterTreatment", "filterRarity", "filterColor"];

// Whether the metric cards, progress bar and game pills are showing. The strip
// above them keeps the headline numbers either way, so this only decides how
// much vertical space the dashboard takes before the first row of cards.
let dashboardOpen = true;

/**
 * The table's columns, in the order they appear in the markup.
 *
 * `key` matches the col-<key> class already on every <th> and <td>, so hiding a
 * column is one CSS rule and needs no re-render. The name column is locked -
 * a table of unnamed rows is not a view anyone wants.
 *
 * The four marked `inName` are also printed inside the name cell by
 * .col-name-meta, which the stylesheet reveals as soon as any of them is
 * hidden. Turning them off therefore costs no information.
 */
const TABLE_COLUMNS = [
  { key: "image", label: "Image" },
  { key: "name", label: "Final Fantasy name", locked: true },
  { key: "mtg", label: "Original MTG name" },
  { key: "set", label: "Set", inName: true },
  { key: "number", label: "Number", inName: true },
  { key: "game", label: "FF game", inName: true },
  { key: "rarity", label: "Rarity", inName: true },
  { key: "avail", label: "Available variants" },
  { key: "inventory", label: "Collected inventory" },
  { key: "total", label: "Total" },
  { key: "condition", label: "Condition" },
  { key: "price", label: "Price" },
  { key: "price-foil", label: "Foil price" },
  { key: "paid", label: "Paid" },
  { key: "location", label: "Storage location" }
];

// Column keys the user has switched off, on this device.
let hiddenColumns = [];

// Whether the tiles show what was paid. Off is a display choice only - nothing
// is cleared, and the table's Paid column is governed separately by the column
// picker, so each view keeps the control that suits it.
let showPurchases = true;

function savePrefs() {
  const prefs = {
    view: currentView,
    pageSize: pageSize,
    sort: valueOf("sortBySelect"),
    search: valueOf("searchInput"),
    location: activeLocationFilter,
    dashboardOpen: dashboardOpen,
    hiddenColumns: hiddenColumns,
    showPurchases: showPurchases,
    filters: {}
  };
  FILTER_IDS.forEach(id => { prefs.filters[id] = valueOf(id); });
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    /* preferences are a nicety; never block on them */
  }
}

function loadPrefs() {
  let prefs = null;
  try {
    prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
  } catch (e) {
    prefs = null;
  }
  if (!prefs || typeof prefs !== "object") return;

  if (prefs.view === "table" || prefs.view === "grid") currentView = prefs.view;
  if (typeof prefs.dashboardOpen === "boolean") dashboardOpen = prefs.dashboardOpen;
  if (typeof prefs.showPurchases === "boolean") showPurchases = prefs.showPurchases;
  if (Array.isArray(prefs.hiddenColumns)) {
    // Filter against the registry so a key retired in a later version cannot
    // linger and hide nothing, and so the name column can never be lost.
    hiddenColumns = prefs.hiddenColumns.filter(key => TABLE_COLUMNS.some(
      col => col.key === key && !col.locked));
  }
  if ([24, 60, 120].indexOf(Number(prefs.pageSize)) !== -1) pageSize = Number(prefs.pageSize);
  // "number_asc" was the old default. Nobody picked it deliberately, so move
  // those devices onto the new default rather than pinning them to the old one.
  setValue("sortBySelect", prefs.sort === "number_asc" ? "print_style" : prefs.sort);
  setValue("searchInput", prefs.search);
  if (prefs.filters && typeof prefs.filters === "object") {
    FILTER_IDS.forEach(id => setValue(id, prefs.filters[id]));
  }
  activeGameFilter = valueOf("filterGame") || "all";
  if (typeof prefs.location === "string") activeLocationFilter = prefs.location;
}

/** Assign a select/input value only when the option still exists. */
function setValue(id, value) {
  if (value === undefined || value === null) return;
  const el = document.getElementById(id);
  if (!el) return;
  if (el.tagName === "SELECT") {
    const exists = Array.prototype.some.call(el.options, opt => opt.value === value);
    if (!exists) return;
  }
  el.value = value;
}

function valueOf(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

// ---------------------------------------------------------------------------
// Card / variant helpers
// ---------------------------------------------------------------------------

function getCardVariantDefs(card) {
  const avail = (card.avail_variants && card.avail_variants.length) ? card.avail_variants : ["Non-Foil"];
  return avail.map(name => MASTER_VARIANTS[name] || {
    key: name.toLowerCase().replace(/[^a-z0-9]/g, ""),
    label: name,
    short: name,
    icon: "✨",
    priceKey: "price_usd",
    badgeClass: "active-foil"
  });
}

function variantPrice(card, def) {
  return getActiveUnitPrice(card, def);
}

/**
 * Union of finish keys that any card in the data can actually be printed in.
 *
 * Two names can share a key - "Basic" is the art cards' name for nonfoil - so
 * the label is taken from MASTER_VARIANTS in declaration order rather than from
 * whichever card happened to be reached first. Otherwise the ownership filter
 * would read "Has Basic Collected" for all 1,383 cards, because the art card
 * sets sort to the front of the data.
 */
function availableVariantKeys() {
  const present = new Set();
  CARDS_DATA.forEach(card => {
    getCardVariantDefs(card).forEach(def => present.add(def.key));
  });

  const out = [];
  const used = new Set();
  Object.keys(MASTER_VARIANTS).forEach(name => {
    const def = MASTER_VARIANTS[name];
    if (present.has(def.key) && !used.has(def.key)) {
      used.add(def.key);
      out.push(def);
    }
  });
  // A finish the master list has never heard of still gets an entry.
  CARDS_DATA.forEach(card => {
    getCardVariantDefs(card).forEach(def => {
      if (!used.has(def.key)) {
        used.add(def.key);
        out.push(def);
      }
    });
  });
  return out;
}

function cardImageSrcset(card) {
  const parts = [];
  if (card.image_small) parts.push(`${card.image_small} 146w`);
  if (card.image_normal) parts.push(`${card.image_normal} 488w`);
  if (card.image_large) parts.push(`${card.image_large} 672w`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  if (typeof CARDS_DATA === "undefined") {
    console.error("CARDS_DATA is not loaded.");
    return;
  }

  cardsById = new Map(CARDS_DATA.map(card => [card.id, card]));
  buildSearchIndex();
  pageSize = isSmallScreen() ? 24 : 60;

  loadCollectionState();
  loadSyncConfig();
  buildFilterOptions();
  collapseFiltersOnSmallScreens();
  loadPrefs();
  applyViewMode();
  applyDashboardState();
  applyColumnPrefs();
  buildGamePills();
  initEventListeners();
  updateStaticCounts();
  syncGamePillActiveState();
  applyFiltersAndRender();
  registerServiceWorker();
  requestPersistentStorage();
  initSync();
});

/**
 * Ask the browser not to evict this site's storage.
 *
 * Safari clears script-writeable storage after 7 days without interaction, and
 * any browser may evict under storage pressure. Persistent mode is a request,
 * not a guarantee, and it is free to ask - so ask. The real safety net is
 * keeping a backup off the device.
 */
function requestPersistentStorage() {
  if (!navigator.storage || typeof navigator.storage.persist !== "function") return;
  navigator.storage.persisted()
    .then(already => (already ? true : navigator.storage.persist()))
    .then(granted => {
      if (!granted) console.info("Persistent storage was not granted; keep JSON backups.");
    })
    .catch(() => { /* not supported here; nothing to do */ });
}

/** Replace the hardcoded card totals in the markup with the real ones. */
function updateStaticCounts() {
  const total = CARDS_DATA.length.toLocaleString();
  document.querySelectorAll("[data-total-cards]").forEach(el => { el.textContent = total; });
}

/**
 * Filter dropdowns are generated from the data itself, so an option can never
 * exist for a value no card has. (The old markup offered "Foil Etched" and
 * "Retro Frame", both of which matched zero cards.)
 */
function buildFilterOptions() {
  const sets = distinctValues(card => card.set);
  fillSelect("filterSet", "All Sets", sets.map(v => ({ value: v, label: SET_LABELS[v] || v })));

  const games = distinctValues(card => card.game)
    .filter(game => HIDDEN_GAMES.indexOf(game) === -1)
    .sort(byCanonicalGameOrder);
  GAME_LIST = games;
  fillSelect("filterGame", "All Games", games.map(v => ({ value: v, label: GAME_LABELS[v] || v })));

  const variants = distinctValues(card => card.variant);
  fillSelect("filterVariant", "All Styles", variants.map(v => ({ value: v, label: VARIANT_LABELS[v] || v })));

  // Every official treatment any card carries, frames first then finishes, so
  // the list reads the way Wizards' own gallery does rather than alphabetically.
  const present = new Set();
  CARDS_DATA.forEach(card => (card.treatments || [card.treatment]).forEach(t => present.add(t)));
  const treatments = TREATMENT_FILTER_ORDER.filter(t => present.has(t))
    .concat([...present].filter(t => TREATMENT_FILTER_ORDER.indexOf(t) === -1).sort());
  fillSelect("filterTreatment", "All Treatments", treatments.map(v => ({ value: v, label: v })));

  const rarities = distinctValues(card => card.rarity)
    .sort((a, b) => (RARITY_ORDER[b] || 0) - (RARITY_ORDER[a] || 0));
  fillSelect("filterRarity", "All Rarities", rarities.map(v => ({ value: v, label: v })));

  const colorOptions = [];
  ["W", "U", "B", "R", "G"].forEach(code => {
    if (CARDS_DATA.some(card => card.color_identity !== "Colorless" && card.color_identity.indexOf(code) !== -1)) {
      colorOptions.push({ value: code, label: COLOR_LABELS[code] });
    }
  });
  if (CARDS_DATA.some(card => card.color_identity !== "Colorless" && card.color_identity.length > 1)) {
    colorOptions.push({ value: "multi", label: "Multicolor" });
  }
  if (CARDS_DATA.some(card => card.color_identity === "Colorless")) {
    colorOptions.push({ value: "Colorless", label: "Colorless" });
  }
  fillSelect("filterColor", "All Colors", colorOptions);

  const ownership = [{ value: "owned", label: "Any Variant Owned (Yes)" }];
  availableVariantKeys().forEach(def => {
    ownership.push({ value: `has_${def.key}`, label: `Has ${def.label} Collected` });
  });
  ownership.push({ value: "unowned", label: "Missing / Not Collected (No)" });
  fillSelect("filterOwned", "All Cards", ownership);
}

// ---------------------------------------------------------------------------
// Storage locations
//
// The location is free text, so "Binder 1, page 3" and "Binder 1, page 7" are
// different strings for the same binder. Grouping by the container turns a pile
// of one-off notes into a browsable list of places.
// ---------------------------------------------------------------------------

const NO_LOCATION = "__none__";

/**
 * Reduce a written location to the thing holding the cards.
 *
 *   "Binder 1, page 3"  -> "Binder 1"
 *   "Binder 1 page 3"   -> "Binder 1"
 *   "Deck box - top"    -> "Deck box"
 *   "Shoebox"           -> "Shoebox"
 */
function locationContainer(location) {
  let text = String(location || "").trim();
  if (!text) return "";
  // Drop a trailing page reference, with or without a separator before it.
  text = text.replace(/[,;:/\-–—]?\s*(?:page|pg|p)\.?\s*\d+\s*$/i, "");
  // Then keep only what comes before the first separator.
  text = text.split(/[,;/|]|\s[-–—]\s/)[0];
  return text.trim();
}

/**
 * Every container currently in use, with a card count, most-used first.
 * Grouped case-insensitively but displayed using the spelling first seen, so
 * "binder 1" and "Binder 1" do not become two entries.
 */
function locationSummary() {
  const byKey = new Map();
  let unfiled = 0;

  CARDS_DATA.forEach(card => {
    const entry = readCard(card.id);
    if (entryTotalQty(entry) <= 0) return;

    const container = locationContainer(entry.location);
    if (!container) {
      unfiled++;
      return;
    }
    const key = container.toLowerCase();
    const found = byKey.get(key);
    if (found) found.count++;
    else byKey.set(key, { key: key, label: container, count: 1 });
  });

  const list = Array.from(byKey.values());
  list.sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));
  return { places: list, unfiled: unfiled };
}

/**
 * Forget a remembered binder that no longer holds anything - it may have been
 * emptied on another device since this one last looked.
 */
function validateLocationFilter() {
  if (activeLocationFilter === "all") return;
  const summary = locationSummary();
  const stillExists = activeLocationFilter === NO_LOCATION
    ? summary.unfiled > 0
    : summary.places.some(place => place.key === activeLocationFilter);
  if (!stillExists) activeLocationFilter = "all";
}

/** Keep the Binders panel in step with the collection while it is open. */
function refreshLocationUi() {
  const summary = locationSummary();
  const signature = summary.places.map(p => `${p.key}:${p.count}`).join("|") + `#${summary.unfiled}`;
  if (signature === locationUiSignature) return;
  locationUiSignature = signature;
  if (isBindersModalOpen()) renderBindersModal();
}

function selectLocationPill(key) {
  activeLocationFilter = activeLocationFilter === key ? "all" : key;
  currentPage = 1;
  applyFiltersAndRender();
  savePrefs();
  closeBindersModal();
  closeToolsMenu();

  const label = key === NO_LOCATION ? "cards with no location" : key;
  showToast(activeLocationFilter === "all" ? "Showing all locations" : `Showing ${label}`);

  // On a phone the header fills the screen, so filtering without moving looks
  // like nothing happened. Put the results in front of her.
  const anchor = document.getElementById("cardsSection");
  if (anchor) window.scrollTo({ top: Math.max(0, anchor.offsetTop - 12), behavior: "smooth" });
}

// ---------------------------------------------------------------------------
// Binders panel (Tools -> Binders)
// ---------------------------------------------------------------------------

/** Collapse the phone Tools menu. A no-op on a wide screen, where it is always open. */
function closeToolsMenu() {
  const actions = document.getElementById("headerActions");
  const toggle = document.getElementById("menuToggleBtn");
  if (actions) actions.classList.remove("is-open");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}

function isBindersModalOpen() {
  const modal = document.getElementById("bindersModal");
  return Boolean(modal) && modal.style.display !== "none";
}

function openBindersModal() {
  renderBindersModal();
  const modal = document.getElementById("bindersModal");
  modal.style.display = "flex";
  document.body.classList.add("modal-open");
}

function closeBindersModal() {
  const modal = document.getElementById("bindersModal");
  if (!modal || modal.style.display === "none") return;
  modal.style.display = "none";
  document.body.classList.remove("modal-open");
}

function renderBindersModal() {
  const container = document.getElementById("bindersModalContent");
  if (!container) return;

  const summary = locationSummary();
  const filed = summary.places.reduce((total, place) => total + place.count, 0);

  if (!summary.places.length && !summary.unfiled) {
    container.innerHTML = `
      <h2 class="sync-title">Binders and boxes</h2>
      <p class="sync-lede">Nothing to show yet - you have not recorded owning any cards.</p>
      <p class="sync-note">
        Once you start adding cards, type where you keep each one in its
        <strong>Storage location</strong> box. Write it however you like, for example
        <em>Binder 1, page 3</em>. Pages of the same binder are grouped together here.
      </p>`;
    return;
  }

  const rows = summary.places.map(place => `
    <button type="button" class="binder-row ${activeLocationFilter === place.key ? "is-active" : ""}"
            data-action="select-location" data-location="${esc(place.key)}">
      <span class="binder-name">${esc(place.label)}</span>
      <span class="binder-count">${place.count} card${place.count === 1 ? "" : "s"}</span>
    </button>`).join("");

  const unfiledRow = summary.unfiled > 0 ? `
    <button type="button" class="binder-row is-unfiled ${activeLocationFilter === NO_LOCATION ? "is-active" : ""}"
            data-action="select-location" data-location="${esc(NO_LOCATION)}">
      <span class="binder-name">Not filed anywhere yet</span>
      <span class="binder-count">${summary.unfiled} card${summary.unfiled === 1 ? "" : "s"}</span>
    </button>` : "";

  const lede = summary.places.length
    ? `${summary.places.length} place${summary.places.length === 1 ? "" : "s"},
       ${filed} card${filed === 1 ? "" : "s"} filed. Tap one to see what is inside it.`
    : `You have not written a storage location on any card yet. Open a card, type
       where you keep it in the <strong>Storage location</strong> box, and it will
       appear here.`;

  container.innerHTML = `
    <h2 class="sync-title">Binders and boxes</h2>
    <p class="sync-lede">${lede}</p>

    <div class="binder-list">
      ${rows}
      ${unfiledRow}
    </div>

    ${activeLocationFilter !== "all" ? `
      <div class="sync-actions">
        <button type="button" class="btn btn-secondary" data-action="select-location"
                data-location="${esc(activeLocationFilter)}">Show all locations again</button>
      </div>` : ""}

    <p class="sync-note">
      These come from the <strong>Storage location</strong> box on each card. Write it
      however you like - <em>Binder 1, page 3</em>, <em>Deck box</em>, <em>Shoebox</em> -
      and pages of the same binder are grouped together.
    </p>`;
}

// ---------------------------------------------------------------------------
// Search
//
// Two rules make the results match what people expect:
//
// 1. A term matches the START OF A WORD, not any old substring. Searching
//    "sephi" used to return 33 cards, because the artist "Josephine Chang"
//    contains "sephi" in the middle of her first name. Fifteen results with no
//    visible connection to the query. Word-start matching removes all of them
//    while still finding "Sephiroth" from "sephi".
//
// 2. Where a term matched decides the order. A card whose NAME matches ranks
//    above one that only mentions the word in its rules or flavour text, and
//    anything found only in those is labelled so it never looks like a mistake.
// ---------------------------------------------------------------------------

/**
 * Match quality, highest first. Also the sort order within a search.
 *
 * Gameplay role outranks even the card name, because a role word is an
 * unambiguous request. Searching "commander" put Commander's Sphere - an
 * artifact - above 568 actual commanders, purely because the word is in its
 * name. Someone typing a role wants the cards that FILL that role first.
 */
const MATCH_ROLE = 4;   // can actually do the thing, e.g. lead a Commander deck
const MATCH_NAME = 3;   // Final Fantasy name or original Magic name
const MATCH_META = 2;   // type line, set code, collector number
const MATCH_ARTIST = 1; // artist
const MATCH_TEXT = 0;   // rules text

const MATCH_LABELS = {};
MATCH_LABELS[MATCH_ARTIST] = "matched artist";
MATCH_LABELS[MATCH_TEXT] = "matched rules text";

/**
 * Keywords for what a card can DO, so a gameplay term finds the right cards even
 * when the word is not printed anywhere on them.
 *
 * "commander" is the case that matters. In the Commander format only a Legendary
 * Creature - or a card that explicitly says it can be your commander - may lead
 * a deck. Matching the SET called "Final Fantasy Commander" instead returned 497
 * cards of which 321 were lands, instants, sorceries and other things that can
 * never be a commander.
 *
 * The set is still reachable, and more precisely, through the Card Set filter.
 */
/**
 * Words that belong with a card's type but are not printed in its type line.
 *
 * Four cards in the token sets are typed "Card" or "Emblem" rather than
 * "Token ..." - Foretell, The Monarch, the Sephiroth emblem and Punchcard. They
 * come in the token slot and people look for them as tokens, so "token" should
 * find them.
 *
 * Note this keys off the SET, not the type line: the 77 art cards are also
 * typed "Card // Card" and are emphatically not tokens.
 */
function derivedTypeWords(card) {
  const typeLine = (card.type_line || "").toLowerCase();
  const setName = (card.set_name || "").toLowerCase();

  const alreadySaysToken = typeLine.indexOf("token") !== -1;
  const isTokenProduct = setName.indexOf("token") !== -1 || typeLine.indexOf("emblem") !== -1;

  return (!alreadySaysToken && isTokenProduct) ? "token" : "";
}

function roleKeywords(card) {
  const rules = (card.oracle_text || "").toLowerCase();
  const roles = [];

  // A double-faced card's eligibility is decided by its FRONT face, so only look
  // at the part before the "//". "Sidequest: Hunt the Mark // Yiazmat" has a
  // legendary creature on the back, but an Enchantment front - it cannot lead a
  // deck. A token can never be a commander either, however legendary it says it
  // is (the set contains two: Angelo and Darkstar).
  const frontType = (card.type_line || "").toLowerCase().split("//")[0];

  const isLegendaryCreature =
    frontType.indexOf("legendary") !== -1 &&
    frontType.indexOf("creature") !== -1 &&
    frontType.indexOf("token") === -1;

  if (isLegendaryCreature || rules.indexOf("can be your commander") !== -1) {
    roles.push("commander");
  }

  return roles.join(" ");
}

/** Card id -> match quality, for the current search only. */
let searchScores = new Map();

/** Card id -> { name, meta, artist, text }, built once at startup. */
let searchIndex = new Map();

/**
 * Collapse to lowercase, turn every run of punctuation into a single space, and
 * pad with spaces. A term then matches a word start iff the haystack contains
 * " " + term.
 */
function normaliseForSearch(value) {
  return " " + String(value === null || value === undefined ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim() + " ";
}

function buildSearchIndex() {
  searchIndex = new Map();
  CARDS_DATA.forEach(card => {
    // Collector numbers are stored zero-padded ("0001"). Index the plain form
    // too, so typing "1" still finds card number 1.
    const number = String(card.collector_number || "");
    const plainNumber = number.replace(/^0+(?=\d)/, "");

    searchIndex.set(card.id, {
      name: normaliseForSearch(`${card.ff_name} ${card.mtg_name}`),
      // The set CODE is on every card tile, so matching it is obvious. The set
      // NAME is not shown anywhere and every single set is called "Final
      // Fantasy something" - so searching "fantasy" matched all 1,365 cards and
      // "commander" matched 505, with nothing visible to explain why. The Card
      // Set dropdown is the right tool for that anyway.
      // The type line is printed on every tile, so "legendary", "creature",
      // "saga", "token" and every creature type match visibly. So does the set
      // CODE, and the gameplay roles derived from the type line.
      //
      // The set NAME is deliberately NOT searched. Every set is called "Final
      // Fantasy something", so "fantasy" matched all 1,365 cards, and
      // "commander" returned the whole Commander product rather than the cards
      // that can actually be a commander. The Card Set filter does that job.
      //
      // The frame treatment is searchable because it is printed on the tile as
      // a badge. "Default" is not - it has no badge, and it would match 755
      // cards with nothing on screen to explain the hit. The finish treatments
      // are left out for the same reason: a card can come in Surge Foil
      // without this particular printing being the surge foil one. Both are
      // reachable through the Treatment filter, which is exact.
      meta: normaliseForSearch(
        `${card.type_line} ${card.set} ${number} ${plainNumber} ${derivedTypeWords(card)} ` +
        `${card.treatment && card.treatment !== "Default" ? card.treatment : ""}`
      ),
      // What the card can DO, ranked above everything else - see MATCH_ROLE.
      role: normaliseForSearch(roleKeywords(card)),
      artist: normaliseForSearch(card.artist),
      // Rules text only. Flavour text is deliberately NOT searched: it is the
      // italic story quote, so a card can mention a character it has nothing
      // else to do with. Searching "sephi" was returning five cards on that
      // basis alone, none of which were Sephiroth cards.
      text: normaliseForSearch(card.oracle_text)
    });
  });
}

/** Split what was typed into searchable terms, discarding punctuation. */
function searchTerms(query) {
  return normaliseForSearch(query).trim().split(" ").filter(term => term.length > 0);
}

/**
 * Added to a card's score when it contains the whole query as a phrase, rather
 * than merely containing each word somewhere.
 *
 * Typing a type line - "card // card" - was returning "Sidequest: Card
 * Collection // Magicked Card" at the very top. That card genuinely contains the
 * word "card" twice, so it matched both terms, and a name match outranks a type
 * match. Correct by the letter of the rules, useless in practice.
 *
 * Requiring the words to be adjacent separates "this IS the thing you typed"
 * from "this happens to contain those words", and that distinction matters more
 * than which field the words were found in. Kept well above the tier values so
 * it always dominates; the tier survives as `score % PHRASE_BONUS`.
 */
const PHRASE_BONUS = 10;

function matchTier(score) {
  return score % PHRASE_BONUS;
}

function containsTerm(haystack, term) {
  return haystack.indexOf(" " + term) !== -1;
}

/**
 * Best match quality for a card, or -1 if it does not match.
 *
 * Every term must be found somewhere, otherwise typing two words would widen
 * the results instead of narrowing them. The score reflects the weakest field
 * any single term had to fall back on, so a card only counts as a name match
 * when the whole query is in its name.
 */
function scoreCard(card, terms, phrase) {
  const fields = searchIndex.get(card.id);
  if (!fields) return -1;

  // Start at the best tier there is. Starting at MATCH_NAME instead capped
  // every score there, so a role match scored the same as a name match and
  // MATCH_ROLE could never be the result - the whole point of ranking the role
  // above the name was lost.
  let weakest = MATCH_ROLE;

  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    let best = -1;

    if (containsTerm(fields.role, term)) best = MATCH_ROLE;
    else if (containsTerm(fields.name, term)) best = MATCH_NAME;
    else if (containsTerm(fields.meta, term)) best = MATCH_META;
    else if (containsTerm(fields.artist, term)) best = MATCH_ARTIST;
    else if (containsTerm(fields.text, term)) best = MATCH_TEXT;

    if (best === -1) return -1;
    if (best < weakest) weakest = best;
  }

  // Does the card contain the words together, in the order they were typed?
  const isPhrase = phrase && (
    containsTerm(fields.name, phrase) ||
    containsTerm(fields.meta, phrase) ||
    containsTerm(fields.artist, phrase) ||
    containsTerm(fields.text, phrase)
  );

  return weakest + (isPhrase ? PHRASE_BONUS : 0);
}

/**
 * Weak matches only appear when there is nothing better.
 *
 * Artist and rules-text hits are useful when they are all you have - typing an
 * artist's surname, or a keyword like "flying" - but they are noise the moment a
 * real name match exists. Rules text in particular is full of ordinary grammar:
 * "control" appears in 569 cards, "target" in 418, none of which show the word
 * anywhere on the tile.
 *
 * So: if anything matched on a name, type line, set or number, show only those.
 * Otherwise fall back to the weaker matches rather than returning nothing.
 */
function applySearchFallback() {
  const isStrong = card => matchTier(searchScores.get(card.id) || 0) >= MATCH_META;
  if (!filteredCards.some(isStrong)) return;
  filteredCards = filteredCards.filter(isStrong);
}

/** Explanation shown on results that matched nothing visible on the card. */
function matchLabel(cardId) {
  if (!searchScores.size) return "";
  const score = searchScores.get(cardId);
  return score === undefined ? "" : (MATCH_LABELS[matchTier(score)] || "");
}

/**
 * The filters live in a <details> that is `open` in the markup, so a desktop
 * visitor sees all seven of them laid out with no clicking. A <details> hides
 * its own contents when it is not open, and the summary is hidden on desktop by
 * the stylesheet - so leaving it closed made the filters invisible AND
 * unreachable on a normal screen.
 *
 * On a phone the summary is visible and the filters would otherwise push the
 * cards off the bottom of the screen, so collapse it there.
 */
function collapseFiltersOnSmallScreens() {
  const details = document.getElementById("filtersDetails");
  if (details && isSmallScreen()) details.removeAttribute("open");
}

/**
 * Show or hide the dashboard panel.
 *
 * The panel is hidden by a CSS sibling rule on the toggle's aria-expanded, so
 * the attribute is the state - there is no second place for it to drift to.
 */
function applyDashboardState() {
  const toggle = document.getElementById("dashboardToggle");
  if (!toggle) return;
  toggle.setAttribute("aria-expanded", String(dashboardOpen));
  setText("dashboardToggleText", dashboardOpen ? "Hide details" : "Show details");
}

function toggleDashboard() {
  dashboardOpen = !dashboardOpen;
  applyDashboardState();
  savePrefs();
}

/**
 * Show or hide the paid block on every tile.
 *
 * One class on the grid rather than a re-render: the blocks are already in the
 * markup, so switching them off is instant and nothing has to be rebuilt when
 * they come back.
 */
function applyPurchaseVisibility() {
  const grid = document.getElementById("binderGridView");
  if (grid) grid.classList.toggle("hide-purchases", !showPurchases);

  const btn = document.getElementById("purchaseToggleBtn");
  if (btn) {
    btn.style.display = currentView === "grid" ? "" : "none";
    btn.setAttribute("aria-pressed", String(showPurchases));
    btn.classList.toggle("is-off", !showPurchases);
    setText("purchaseToggleIcon", showPurchases ? "◉" : "○");
  }
}

function togglePurchaseDisplay() {
  showPurchases = !showPurchases;
  applyPurchaseVisibility();
  savePrefs();
}

// ---------------------------------------------------------------------------
// Table columns
//
// Hiding is done with generated CSS rather than by re-rendering the table: the
// classes are already on every cell, the rows can stay exactly as they are, and
// an open <input> keeps its focus and its half-typed value.
// ---------------------------------------------------------------------------

function isColumnHidden(key) {
  return hiddenColumns.indexOf(key) !== -1;
}

function applyColumnPrefs() {
  const table = document.querySelector(".tracker-table");
  if (table) {
    // The set / number / game / rarity line inside the name cell is normally
    // off on desktop. Reveal it the moment any of those four columns is hidden,
    // so switching them off compacts the table instead of losing the data.
    const needsFallback = TABLE_COLUMNS.some(col => col.inName && isColumnHidden(col.key));
    table.classList.toggle("show-name-meta", needsFallback);
  }

  let style = document.getElementById("columnStyles");
  if (!style) {
    style = document.createElement("style");
    style.id = "columnStyles";
    document.head.appendChild(style);
  }
  style.textContent = hiddenColumns
    .map(key => `.tracker-table .col-${key} { display: none; }`)
    .join("\n");

  renderColumnPicker();
}

function renderColumnPicker() {
  const picker = document.getElementById("columnPicker");
  if (picker) picker.style.display = currentView === "table" ? "" : "none";

  const shown = TABLE_COLUMNS.length - hiddenColumns.length;
  setText("columnPickerCount", `${shown}/${TABLE_COLUMNS.length}`);

  const list = document.getElementById("columnPickerList");
  if (!list) return;
  list.innerHTML = TABLE_COLUMNS.map(col => {
    const on = !isColumnHidden(col.key);
    return `
      <label class="column-picker-row ${col.locked ? "is-locked" : ""}">
        <input type="checkbox" data-column="${esc(col.key)}"
               ${on ? "checked" : ""} ${col.locked ? "disabled" : ""}>
        <span>${esc(col.label)}</span>
        ${col.locked ? `<span class="column-note">always</span>` : ""}
        ${col.inName ? `<span class="column-note">in name cell</span>` : ""}
      </label>`;
  }).join("");
}

function setColumnVisible(key, visible) {
  const col = TABLE_COLUMNS.find(item => item.key === key);
  if (!col || col.locked) return;
  hiddenColumns = hiddenColumns.filter(item => item !== key);
  if (!visible) hiddenColumns.push(key);
  applyColumnPrefs();
  savePrefs();
}

function showAllColumns() {
  hiddenColumns = [];
  applyColumnPrefs();
  savePrefs();
}

function toggleColumnPicker(force) {
  const btn = document.getElementById("columnPickerBtn");
  const panel = document.getElementById("columnPickerPanel");
  if (!btn || !panel) return;
  const open = force === undefined
    ? btn.getAttribute("aria-expanded") !== "true"
    : Boolean(force);
  btn.setAttribute("aria-expanded", String(open));
  panel.hidden = !open;
}

function distinctValues(getter) {
  const seen = new Set();
  CARDS_DATA.forEach(card => {
    const value = getter(card);
    if (value !== undefined && value !== null && value !== "") seen.add(value);
  });
  return Array.from(seen).sort();
}

function byCanonicalGameOrder(a, b) {
  const ia = GAME_ORDER.indexOf(a);
  const ib = GAME_ORDER.indexOf(b);
  if (ia === -1 && ib === -1) return a.localeCompare(b);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

function fillSelect(id, allLabel, options) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<option value="all">${esc(allLabel)}</option>` +
    options.map(opt => `<option value="${esc(opt.value)}">${esc(opt.label)}</option>`).join("");
}

// ---------------------------------------------------------------------------
// Event Listeners (delegated - no inline handlers)
// ---------------------------------------------------------------------------

function initEventListeners() {
  const searchInput = document.getElementById("searchInput");
  const clearSearchBtn = document.getElementById("clearSearchBtn");

  clearSearchBtn.style.display = searchInput.value ? "flex" : "none";

  // Debounced: filtering 1,365 cards on every keystroke is noticeably slow on a phone.
  searchInput.addEventListener("input", () => {
    clearSearchBtn.style.display = searchInput.value ? "flex" : "none";
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      currentPage = 1;
      applyFiltersAndRender();
      savePrefs();
    }, 160);
  });

  clearSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearSearchBtn.style.display = "none";
    currentPage = 1;
    applyFiltersAndRender();
    savePrefs();
  });

  FILTER_IDS.concat(["sortBySelect"]).forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      if (id === "filterGame") {
        activeGameFilter = el.value;
        syncGamePillActiveState();
      }
      currentPage = 1;
      applyFiltersAndRender();
      savePrefs();
    });
  });

  const pageSizeSelect = document.getElementById("pageSizeSelect");
  if (pageSizeSelect) {
    pageSizeSelect.value = String(pageSize);
    pageSizeSelect.addEventListener("change", () => {
      pageSize = Number(pageSizeSelect.value) || 60;
      currentPage = 1;
      renderCards();
      savePrefs();
    });
  }

  document.getElementById("resetFiltersBtn").addEventListener("click", resetAllFilters);
  document.getElementById("emptyResetBtn").addEventListener("click", resetAllFilters);

  document.getElementById("clearGameFilterBtn").addEventListener("click", () => {
    setValue("filterGame", "all");
    activeGameFilter = "all";
    syncGamePillActiveState();
    currentPage = 1;
    applyFiltersAndRender();
    savePrefs();
  });

  document.getElementById("viewToggleBtn").addEventListener("click", toggleViewMode);

  const dashboardToggle = document.getElementById("dashboardToggle");
  if (dashboardToggle) dashboardToggle.addEventListener("click", toggleDashboard);

  const purchaseToggle = document.getElementById("purchaseToggleBtn");
  if (purchaseToggle) purchaseToggle.addEventListener("click", togglePurchaseDisplay);

  const columnBtn = document.getElementById("columnPickerBtn");
  if (columnBtn) columnBtn.addEventListener("click", () => toggleColumnPicker());
  const columnList = document.getElementById("columnPickerList");
  if (columnList) {
    columnList.addEventListener("change", event => {
      const box = event.target.closest("input[data-column]");
      if (box) setColumnVisible(box.getAttribute("data-column"), box.checked);
    });
  }
  const columnReset = document.getElementById("columnResetBtn");
  if (columnReset) columnReset.addEventListener("click", showAllColumns);

  // Click anywhere else, or press Escape, and the panel closes.
  document.addEventListener("click", event => {
    const picker = document.getElementById("columnPicker");
    if (picker && !picker.contains(event.target)) toggleColumnPicker(false);
  });

  // Collapsible action menu (mobile)
  const menuToggle = document.getElementById("menuToggleBtn");
  if (menuToggle) {
    menuToggle.addEventListener("click", () => {
      const actions = document.getElementById("headerActions");
      const open = actions.classList.toggle("is-open");
      menuToggle.setAttribute("aria-expanded", String(open));
    });
  }

  // On a phone every tool lives inside the collapsed Tools menu. Leaving it
  // open after a tap hides the very thing the tool just changed.
  document.getElementById("headerActions").addEventListener("click", event => {
    if (event.target.closest("button, label")) closeToolsMenu();
  });

  document.getElementById("bindersBtn").addEventListener("click", openBindersModal);
  document.getElementById("bindersModalCloseBtn").addEventListener("click", closeBindersModal);
  document.getElementById("bindersModal").addEventListener("click", event => {
    if (event.target.id === "bindersModal") closeBindersModal();
  });
  document.getElementById("backupBtn").addEventListener("click", exportJsonBackup);
  document.getElementById("exportCsvBtn").addEventListener("click", exportCsvData);
  document.getElementById("restoreFileInput").addEventListener("change", importJsonBackup);
  document.getElementById("resetCollectionBtn").addEventListener("click", resetEntireCollection);

  document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
  document.getElementById("cardModal").addEventListener("click", event => {
    if (event.target.id === "cardModal") closeModal();
  });

  document.getElementById("syncBtn").addEventListener("click", () => openSyncModal());
  document.getElementById("syncModalCloseBtn").addEventListener("click", closeSyncModal);
  document.getElementById("syncModal").addEventListener("click", event => {
    if (event.target.id === "syncModal") closeSyncModal();
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    closeModal();
    closeSyncModal();
    closeBindersModal();
    toggleColumnPicker(false);
  });

  // One delegated click handler for every generated control.
  document.addEventListener("click", handleDelegatedClick);
  // One delegated change handler for generated inputs and selects.
  document.addEventListener("change", handleDelegatedChange);
  // Keyboard equivalent for the chip / tile roles that are not real buttons.
  document.addEventListener("keydown", handleDelegatedKeydown);

  const backToTop = document.getElementById("backToTopBtn");
  if (backToTop) {
    backToTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    window.addEventListener("scroll", () => {
      backToTop.classList.toggle("is-visible", window.scrollY > 600);
    }, { passive: true });
  }
}

function handleDelegatedClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  runAction(target, event);
}

const NATIVE_INTERACTIVE = ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"];

/**
 * Enter / Space activation for the elements that only *look* like buttons
 * (role="button" + tabindex). Native controls are skipped: the browser already
 * turns Enter into a click on them, and handling it here as well would fire the
 * chip's increment on top of the nested decrement button's own click.
 */
function handleDelegatedKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (NATIVE_INTERACTIVE.indexOf(event.target.tagName) !== -1) return;
  const target = event.target.closest("[data-action][tabindex]");
  if (!target) return;
  event.preventDefault();
  runAction(target, event);
}

function runAction(target, event) {
  const action = target.getAttribute("data-action");
  const cardId = target.getAttribute("data-card-id");
  const vkey = target.getAttribute("data-vkey");

  switch (action) {
    case "open-modal":
      event.preventDefault();
      openCardModal(cardId);
      break;
    case "add-purchase":
      // Opens the card window with the cursor already in the price box, so the
      // button on the tile leads straight to the thing it advertises.
      event.preventDefault();
      openCardModal(cardId);
      focusPurchasePrice();
      break;
    case "lot-add":
      event.preventDefault();
      focusNewLot(cardId, addInventoryLot(cardId, {}));
      break;
    case "lot-remove":
      event.preventDefault();
      removeInventoryLot(cardId, target.getAttribute("data-lot-id"));
      break;
    case "chip-inc":
      event.preventDefault();
      event.stopPropagation();
      // Only the tile chips ask for the purchase window; stepping inside the
      // card window or typing in the table should not move the cursor.
      stepVariant(cardId, vkey, 1, { revealPurchase: true });
      break;
    case "chip-dec":
      event.preventDefault();
      event.stopPropagation();
      stepVariant(cardId, vkey, -1);
      break;
    case "modal-step":
      event.preventDefault();
      stepVariant(cardId, vkey, Number(target.getAttribute("data-step")) || 1);
      break;
    case "flip-card":
      event.preventDefault();
      flipModalCard();
      break;
    case "goto-page":
      event.preventDefault();
      goToPage(Number(target.getAttribute("data-page")));
      break;
    case "select-game":
      event.preventDefault();
      selectGamePill(target.getAttribute("data-game"));
      break;
    case "select-location":
      event.preventDefault();
      selectLocationPill(target.getAttribute("data-location"));
      break;
    case "clear-filter":
      event.preventDefault();
      clearOneFilter(target.getAttribute("data-clear"));
      break;
    default:
      if (action.indexOf("sync-") === 0) {
        event.preventDefault();
        handleSyncAction(action, target);
      }
      break;
  }
}

function handleDelegatedChange(event) {
  const target = event.target.closest("[data-change]");
  if (!target) return;
  const action = target.getAttribute("data-change");
  const cardId = target.getAttribute("data-card-id");
  const vkey = target.getAttribute("data-vkey");
  const lotId = target.getAttribute("data-lot-id");

  switch (action) {
    case "qty":
      tableSetVariantQty(cardId, vkey, target.value);
      break;
    case "condition":
      setCardCondition(cardId, target.value);
      break;
    case "location":
      setCardLocation(cardId, target.value);
      break;
    case "serial":
      setCardSerial(cardId, target.value);
      break;
    case "lot-qty":
      updateInventoryLot(cardId, lotId, { quantity: target.value });
      break;
    case "lot-price":
      updateInventoryLot(cardId, lotId, { purchasePrice: target.value });
      showToast("Purchase price saved");
      break;
    case "lot-date":
      updateInventoryLot(cardId, lotId, { purchaseDate: target.value });
      showToast("Purchase date saved");
      break;
    case "lot-variant":
      updateInventoryLot(cardId, lotId, { variant: target.value });
      break;
    case "lot-condition":
      updateInventoryLot(cardId, lotId, { condition: target.value });
      break;
    default:
      break;
  }
}

function resetAllFilters() {
  setValue("searchInput", "");
  document.getElementById("clearSearchBtn").style.display = "none";
  FILTER_IDS.forEach(id => setValue(id, "all"));
  setValue("sortBySelect", "print_style");
  activeGameFilter = "all";
  activeLocationFilter = "all";
  locationUiSignature = "";
  syncGamePillActiveState();
  currentPage = 1;
  applyFiltersAndRender();
  savePrefs();
  showToast("Filters reset to default");
}

function toggleViewMode() {
  currentView = currentView === "grid" ? "table" : "grid";
  applyViewMode();
  renderCards();
  savePrefs();
}

function applyViewMode() {
  const gridEl = document.getElementById("binderGridView");
  const tableEl = document.getElementById("spreadsheetTableView");
  const btnText = document.getElementById("viewToggleText");
  const btnIcon = document.getElementById("viewToggleIcon");

  const isGrid = currentView === "grid";
  gridEl.style.display = isGrid ? "grid" : "none";
  tableEl.style.display = isGrid ? "none" : "block";
  if (btnText) btnText.textContent = isGrid ? "Table View" : "Binder View";
  if (btnIcon) btnIcon.textContent = isGrid ? "☷" : "▦";

  // Each view carries its own density control.
  renderColumnPicker();
  toggleColumnPicker(false);
  applyPurchaseVisibility();
}

// ---------------------------------------------------------------------------
// Filtering & Sorting Core
// ---------------------------------------------------------------------------

function applyFiltersAndRender() {
  const query = valueOf("searchInput").trim().toLowerCase();
  const ownedFilter = valueOf("filterOwned");
  const gameFilter = valueOf("filterGame");
  const setFilter = valueOf("filterSet");
  const variantFilter = valueOf("filterVariant");
  const treatmentFilter = valueOf("filterTreatment");
  const rarityFilter = valueOf("filterRarity");
  const colorFilter = valueOf("filterColor");
  const sortBy = valueOf("sortBySelect");

  const ownedVariantKey = ownedFilter.indexOf("has_") === 0 ? ownedFilter.slice(4) : null;

  validateLocationFilter();
  const locationFilter = activeLocationFilter;

  const terms = searchTerms(query);
  // The whole query as one phrase, for the adjacency bonus in scoreCard.
  const phrase = terms.join(" ");
  searchScores.clear();

  filteredCards = CARDS_DATA.filter(card => {
    const entry = readCard(card.id);
    const owned = entryTotalQty(entry) > 0;

    if (terms.length) {
      const score = scoreCard(card, terms, phrase);
      if (score < 0) return false;
      searchScores.set(card.id, score);
    }

    if (ownedFilter === "owned" && !owned) return false;
    if (ownedFilter === "unowned" && owned) return false;
    if (ownedVariantKey && (entry.variants[ownedVariantKey] || 0) <= 0) return false;

    if (locationFilter !== "all") {
      const container = locationContainer(entry.location).toLowerCase();
      if (locationFilter === NO_LOCATION) {
        // "No location set" only makes sense for cards you actually own.
        if (!owned || container) return false;
      } else if (container !== locationFilter) {
        return false;
      }
    }

    if (gameFilter !== "all" && card.game !== gameFilter) return false;
    if (setFilter !== "all" && card.set !== setFilter) return false;
    if (variantFilter !== "all" && card.variant !== variantFilter) return false;
    // Match against the full treatment list, not just the frame, so picking
    // "Surge Foil" or "Scene Card" works the same way "Borderless" does.
    if (treatmentFilter !== "all") {
      const list = card.treatments || [card.treatment];
      if (list.indexOf(treatmentFilter) === -1) return false;
    }
    if (rarityFilter !== "all" && card.rarity.toLowerCase() !== rarityFilter.toLowerCase()) return false;

    if (colorFilter !== "all") {
      if (colorFilter === "Colorless") {
        if (card.color_identity !== "Colorless") return false;
      } else if (colorFilter === "multi") {
        if (card.color_identity === "Colorless" || card.color_identity.length <= 1) return false;
      } else if (card.color_identity === "Colorless" || card.color_identity.indexOf(colorFilter) === -1) {
        return false;
      }
    }

    return true;
  });

  if (terms.length) applySearchFallback();

  sortFilteredCards(sortBy);
  updateFilterActiveState();
  updateDashboardStats();
  renderCards();
}

function sortFilteredCards(sortBy) {
  const searching = searchScores.size > 0;

  filteredCards.sort((a, b) => {
    // While searching, group by how well each card matched so the cards whose
    // NAME contains the query come first, ahead of ones that merely mention it
    // in their rules or flavour text. The chosen sort still orders within each
    // group.
    if (searching) {
      const byRelevance = (searchScores.get(b.id) || 0) - (searchScores.get(a.id) || 0);
      if (byRelevance !== 0) return byRelevance;
    }

    switch (sortBy) {
      case "ff_name_asc":
        return displayName(a.ff_name).localeCompare(displayName(b.ff_name));
      case "ff_name_desc":
        return displayName(b.ff_name).localeCompare(displayName(a.ff_name));
      case "mtg_name_asc":
        return (a.mtg_name || "").localeCompare(b.mtg_name || "");
      case "price_desc":
        return bestPriceValue(b) - bestPriceValue(a);
      case "price_asc":
        return bestPriceValue(a) - bestPriceValue(b);
      case "rarity_desc":
        return ((RARITY_ORDER[b.rarity] || 0) - (RARITY_ORDER[a.rarity] || 0)) || compareByPrintStyle(a, b);
      case "owned_desc":
        return ((isCardOwned(b.id) ? 1 : 0) - (isCardOwned(a.id) ? 1 : 0)) || compareByPrintStyle(a, b);
      case "qty_desc":
        return (getCardTotalQty(b.id) - getCardTotalQty(a.id)) || compareByPrintStyle(a, b);
      case "game_asc":
        return (gameRank(a) - gameRank(b)) || compareByPrintStyle(a, b);
      case "number_asc":
        return compareByNumber(a, b);
      case "print_style":
      default:
        return compareByPrintStyle(a, b);
    }
  });
}

/**
 * Just the number, for sorting.
 *
 * Sorting by price across two currencies is approximate - a euro is not a
 * dollar - but the alternative is dropping every euro-only card to the bottom
 * as if it were worthless, and one of them is a six-hundred-euro Cloud.
 */
function bestPriceValue(card) {
  return bestPrice(card).value;
}

/** The card's headline price, with its currency. Zero when it has none. */
function bestPrice(card) {
  const usd = cardPrice(card, "price_usd");
  if (usd.value !== null) return usd;
  const foil = cardPrice(card, "price_foil");
  if (foil.value !== null) return foil;
  return { value: 0, currency: "usd" };
}

function treatmentRank(card) {
  const at = TREATMENT_ORDER.indexOf(card.treatment);
  return at === -1 ? TREATMENT_ORDER.length : at;
}

/**
 * What kind of card this is, for the default order: the cards you actually cast
 * come first, then lands, then tokens, then the two kinds of art card, which
 * are not playable at all.
 *
 * Grouping by treatment alone put every token and full-art land ahead of most of
 * the playable cards, because all of them are Full Art and Full Art sorts before
 * Default.
 *
 * The Art Series (AFIN) and the Scene Box art cards (AFIC) both carry the
 * Art Card treatment, but they are different products and are kept apart.
 *
 * A double-faced card is judged by its FRONT face, the same way roleKeywords
 * does it: "Land - Town // Sorcery - Adventure" is a land, while
 * "Enchantment // Land" is not.
 */
const KIND_PLAYABLE = 0;
const KIND_LAND = 1;
const KIND_TOKEN = 2;
const KIND_ART_SERIES = 3;
const KIND_SCENE_ART = 4;

function cardKind(card) {
  const front = (card.type_line || "").toLowerCase().split("//")[0];
  // The art cards are checked first: their type line is just "Card // Card",
  // which none of the tests below would catch, so they would pass for playable.
  // AFIC before the general case, or the Scene Box would land in the Art Series.
  if (card.set === "AFIC") return KIND_SCENE_ART;
  if (card.set === "AFIN" || card.treatment === "Art Card") return KIND_ART_SERIES;
  // Emblems live with the tokens - they come out of the same products and are
  // not cards you own to play.
  if (card.set === "TFIN" || card.set === "TFIC"
      || front.indexOf("token") !== -1 || front.indexOf("emblem") !== -1) {
    return KIND_TOKEN;
  }
  if (front.indexOf("land") !== -1) return KIND_LAND;
  return KIND_PLAYABLE;
}

function setRank(card) {
  const at = SET_RELEASE_ORDER.indexOf(card.set);
  return at === -1 ? SET_RELEASE_ORDER.length : at;
}

/**
 * Release order of the Final Fantasy games, so sorting runs I to XVI rather
 * than alphabetically - which would put FF10 between FF1 and FF11.
 *
 * The catch-all buckets ("Spin-Off / Multi-Game", "Unknown") are already last
 * in GAME_ORDER, and anything missing from it sorts after them.
 */
function gameRank(card) {
  const at = GAME_ORDER.indexOf(card.game);
  return at === -1 ? GAME_ORDER.length : at;
}

function compareBySet(a, b) {
  const rankDiff = setRank(a) - setRank(b);
  if (rankDiff !== 0) return rankDiff;
  // Same rank means either the same set, or two sets not on the list at all.
  return a.set === b.set ? 0 : a.set.localeCompare(b.set);
}

/**
 * The default order: playable cards, then lands, then tokens, then the Art
 * Series, then the Scene Box art cards. Within each of those, group by print
 * style, and within each style run through the sets in release order, starting
 * with FIN.
 */
function compareByPrintStyle(a, b) {
  return (cardKind(a) - cardKind(b))
    || (treatmentRank(a) - treatmentRank(b))
    || compareBySet(a, b)
    || compareByNumber(a, b);
}

function compareByNumber(a, b) {
  if (a.set !== b.set) return a.set.localeCompare(b.set);
  const numA = parseInt(String(a.collector_number).replace(/\D/g, ""), 10) || 0;
  const numB = parseInt(String(b.collector_number).replace(/\D/g, ""), 10) || 0;
  if (numA !== numB) return numA - numB;
  return String(a.collector_number).localeCompare(String(b.collector_number));
}

/** Readable name for the binder currently being viewed. */
function locationFilterLabel() {
  if (activeLocationFilter === NO_LOCATION) return "Not filed anywhere";
  const place = locationSummary().places.find(entry => entry.key === activeLocationFilter);
  return place ? place.label : activeLocationFilter;
}

/**
 * Show every active filter as a chip you can tap to remove.
 *
 * On a phone the filters collapse behind a summary bar and the binder view is
 * reached from the Tools menu, so once something is filtered there is no visible
 * way back - you have to remember where the control was. These chips sit above
 * the cards and are always on screen.
 */
/**
 * Everything currently narrowing the view, as { key, label } pairs.
 *
 * Shared by the chip row and the empty state. Filters persist between visits,
 * and they combine: a Set or Game left over from a previous session ANDs with
 * whatever you pick next, so a perfectly good choice can come back empty. The
 * empty state names them for that reason.
 */
function activeFilterChips() {
  const chips = [];

  const query = valueOf("searchInput").trim();
  if (query) chips.push({ key: "search", label: `Search: ${query}` });

  FILTER_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.value === "all") return;
    const option = el.options[el.selectedIndex];
    chips.push({ key: id, label: option ? option.textContent.trim() : el.value });
  });

  if (activeLocationFilter !== "all") {
    chips.push({ key: "location", label: `\u{1F4D2} ${locationFilterLabel()}` });
  }

  return chips;
}

function renderActiveFilters() {
  const container = document.getElementById("activeFilters");
  if (!container) return;

  const chips = activeFilterChips();

  if (!chips.length) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }

  container.style.display = "flex";
  container.innerHTML =
    `<span class="active-filters-label">Showing only</span>` +
    chips.map(chip => `
      <button type="button" class="filter-chip" data-action="clear-filter"
              data-clear="${esc(chip.key)}"
              aria-label="Stop filtering by ${esc(chip.label)}">
        <span class="filter-chip-text">${esc(chip.label)}</span>
        <span class="filter-chip-x" aria-hidden="true">✕</span>
      </button>`).join("") +
    (chips.length > 1
      ? `<button type="button" class="filter-chip filter-chip-all" data-action="clear-filter" data-clear="__all__">Show everything</button>`
      : "");
}

/** Remove one active filter, or all of them. */
function clearOneFilter(key) {
  if (key === "__all__") {
    resetAllFilters();
    return;
  }

  if (key === "search") {
    setValue("searchInput", "");
    const clearBtn = document.getElementById("clearSearchBtn");
    if (clearBtn) clearBtn.style.display = "none";
  } else if (key === "location") {
    activeLocationFilter = "all";
    if (isBindersModalOpen()) renderBindersModal();
  } else {
    setValue(key, "all");
    if (key === "filterGame") {
      activeGameFilter = "all";
      syncGamePillActiveState();
    }
  }

  currentPage = 1;
  applyFiltersAndRender();
  savePrefs();
}

/** Highlight the reset control whenever a filter is actually narrowing results. */
function updateFilterActiveState() {
  const anyFilter = FILTER_IDS.some(id => valueOf(id) !== "all") ||
    activeLocationFilter !== "all" ||
    valueOf("searchInput").trim() !== "";
  const btn = document.getElementById("resetFiltersBtn");
  if (btn) btn.classList.toggle("is-active", anyFilter);
  const note = document.getElementById("filtersActiveNote");
  if (note) note.style.display = anyFilter ? "inline-flex" : "none";
  renderActiveFilters();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCards() {
  const total = filteredCards.length;
  setText("resultsCount", total.toLocaleString());
  setText("statFilteredTotal", `Filtered: ${total.toLocaleString()} cards`);

  const emptyEl = document.getElementById("emptyState");
  const gridEl = document.getElementById("binderGridView");
  const tableEl = document.getElementById("spreadsheetTableView");
  const tableBody = document.getElementById("trackerTableBody");

  if (total === 0) {
    // Say WHICH filters are responsible. They persist between visits and they
    // combine, so the usual reason nothing comes back is a filter left on from
    // a previous session rather than the one just chosen.
    const reasonEl = document.getElementById("emptyReason");
    if (reasonEl) {
      const chips = activeFilterChips();
      reasonEl.innerHTML = chips.length
        ? `Active right now: ${chips.map(c => `<strong>${esc(c.label)}</strong>`).join(" + ")}`
        : "";
      reasonEl.style.display = chips.length ? "block" : "none";
    }
    emptyEl.style.display = "block";
    gridEl.style.display = "none";
    tableEl.style.display = "none";
    gridEl.innerHTML = "";
    tableBody.innerHTML = "";
    renderPagination(0);
    return;
  }

  emptyEl.style.display = "none";
  applyViewMode();

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const startIndex = (currentPage - 1) * pageSize;
  const pageCards = filteredCards.slice(startIndex, startIndex + pageSize);

  if (currentView === "grid") {
    renderGridView(pageCards);
  } else {
    renderTableView(pageCards);
  }

  renderPagination(totalPages);
}

function renderVariantChips(card, entry) {
  return getCardVariantDefs(card).map(def => {
    const qty = entry.variants[def.key] || 0;
    const isActive = qty > 0;
    return `
      <div class="variant-chip ${isActive ? esc(def.badgeClass) : ""}"
           role="button" tabindex="0"
           data-action="chip-inc" data-card-id="${esc(card.id)}" data-vkey="${esc(def.key)}"
           aria-label="Add one ${esc(def.label)} copy. Currently ${qty}."
           title="Tap to add a ${esc(def.label)} copy (currently ${qty})">
        <span class="chip-label">${def.icon} ${esc(def.short || def.label)}</span>
        ${isActive ? `<span class="chip-count">${qty}</span>` : ""}
        ${isActive ? `<button type="button" class="chip-dec" data-action="chip-dec"
            data-card-id="${esc(card.id)}" data-vkey="${esc(def.key)}"
            aria-label="Remove one ${esc(def.label)} copy">−</button>` : ""}
      </div>`;
  }).join("");
}

/**
 * The tile's second line: where the card is from, then the two optional notes -
 * the original MTG name for a flavour reprint, and why it matched the search.
 *
 * Set, number and game are plain text rather than badges. As pills they took
 * roughly 150px of a 277px tile and pushed the treatment off the end of the
 * line; as text they take about 90px and leave the badge line above free for
 * the print identity, which is the part that actually distinguishes two
 * printings of the same card.
 *
 * Returned as one string with no padding, so the slot that holds it is either
 * genuinely empty or genuinely full.
 */
function noteLine(card) {
  const parts = [`<span class="card-origin">${esc(card.set)} #${esc(card.collector_number)} · ${esc(card.game)}</span>`];
  if (card.is_reprint) {
    parts.push(`<span class="card-mtg-subtitle" title="Original MTG name">aka: ${esc(displayName(card.mtg_name))}</span>`);
  }
  if (matchLabel(card.id)) {
    parts.push(`<span class="match-why">${esc(matchLabel(card.id))}</span>`);
  }
  return parts.join("");
}

function renderGridView(cards) {
  const gridEl = document.getElementById("binderGridView");
  gridEl.innerHTML = cards.map(card => {
    const entry = readCard(card.id);
    const totalQty = entryTotalQty(entry);
    const isOwned = totalQty > 0;
    const name = displayName(card.ff_name);
    const srcset = cardImageSrcset(card);

    return `
      <article class="card-item ${isOwned ? "is-owned" : ""}" data-card-tile="${esc(card.id)}">
        <div class="card-item-badge-owned" ${isOwned ? "" : 'style="display:none"'} data-owned-badge>✓ OWNED (<span data-owned-count>${totalQty}</span>)</div>

        <div class="card-media-wrapper" data-action="open-modal" data-card-id="${esc(card.id)}" role="button" tabindex="0" aria-label="Open details for ${esc(name)}">
          <img class="card-image"
               src="${esc(card.image_normal || card.image_small)}"
               ${srcset ? `srcset="${esc(srcset)}"` : ""}
               sizes="(max-width: 520px) 116px, (max-width: 767px) 46vw, (max-width: 900px) 31vw, 285px"
               alt="${esc(name)}" loading="lazy" decoding="async">
        </div>

        <div class="card-info">
          <div class="card-title-row">
            <h3 class="card-name" title="${esc(name)}">${esc(name)}</h3>
            <div class="card-collector">${esc(card.color_identity)}</div>
          </div>

          <!-- The print identity: rarity, official frame treatment, finish.
               Nothing sits on the artwork any more, and these three are what a
               flat scan cannot tell you apart. Badges only - the identifiers
               that are printed on the card itself go in the line below, as
               plain text, because text is far narrower than a pill. -->
          <div class="card-meta-line">
            <span class="tag-badge tag-rarity-${esc(card.rarity.toLowerCase())}">${esc(card.rarity)}</span>
            ${card.treatment && card.treatment !== "Default" ? `<span class="tag-badge tag-treatment">${esc(card.treatment)}</span>` : ""}
            ${card.variant !== "Basic/Non-foil" ? `<span class="tag-badge tag-variant">${esc(variantName(card.variant))}</span>` : ""}
          </div>

          <!-- One fixed line holding the set, number and game, plus whichever
               of the two optional notes apply. It was reserved and empty on 95%
               of tiles; putting the identifiers here costs no extra height and
               keeps the badge line above from overflowing.
               No whitespace inside, so :empty matches and the phone layout -
               a single column, with no row to level - can drop it. -->
          <div class="card-note-line">${noteLine(card)}</div>

          <div class="card-type" title="${esc(card.type_line)}">${esc(card.type_line)}</div>

          <div class="card-price-row">
            <div class="price-item">
              <span class="price-label">Normal ${esc(priceUnit(card, "price_usd"))}</span>
              <span class="price-val">${money(cardPrice(card, "price_usd").value, cardPrice(card, "price_usd").currency)}</span>
            </div>
            <div class="price-item" style="text-align: right;">
              <span class="price-label">Foil ${esc(priceUnit(card, "price_foil"))}</span>
              <span class="price-val price-foil">${money(cardPrice(card, "price_foil").value, cardPrice(card, "price_foil").currency)}</span>
            </div>
          </div>

          ${purchaseRow(card, entry)}

          <div class="card-variants-hub">
            <div class="variants-hub-label">
              <span>Available Variants</span>
              <span class="hub-owned-count" data-owned-label>${totalQty} Owned</span>
            </div>
            <div class="variant-chips-grid" data-chips>
              ${renderVariantChips(card, entry)}
            </div>
          </div>

          <div class="card-actions-row">
            <button type="button" class="btn-open-modal" data-action="open-modal" data-card-id="${esc(card.id)}">
              <span>\u{1F50D} Manage Variants &amp; Prices</span>
            </button>
          </div>
        </div>
      </article>`;
  }).join("");
}

function renderTableView(cards) {
  const tbody = document.getElementById("trackerTableBody");
  tbody.innerHTML = cards.map(card => {
    const entry = readCard(card.id);
    const totalQty = entryTotalQty(entry);
    const isOwned = totalQty > 0;
    const name = displayName(card.ff_name);
    const defs = getCardVariantDefs(card);

    const availBadges = defs
      .map(def => `<span class="tag-badge ${esc(def.badgeClass)}">${def.icon} ${esc(def.short || def.label)}</span>`)
      .join(" ");

    const qtyRows = defs.map(def => {
      const qty = entry.variants[def.key] || 0;
      return `
        <label class="table-qty-row">
          <span class="table-qty-label ${qty > 0 ? "has-qty" : ""}">${def.icon} ${esc(def.short || def.label)}</span>
          <input type="number" class="table-input table-qty-input" inputmode="numeric" pattern="[0-9]*"
                 value="${qty}" min="0" step="1"
                 aria-label="${esc(def.label)} quantity for ${esc(name)}"
                 data-change="qty" data-card-id="${esc(card.id)}" data-vkey="${esc(def.key)}">
        </label>`;
    }).join("");

    return `
      <tr class="${isOwned ? "row-owned" : ""}" data-card-row="${esc(card.id)}">
        <td class="col-image">
          <img class="table-thumb" src="${esc(card.image_small || card.image_normal)}" alt="${esc(name)}"
               loading="lazy" decoding="async"
               data-action="open-modal" data-card-id="${esc(card.id)}">
        </td>
        <td class="col-name">
          <button type="button" class="link-name" data-action="open-modal" data-card-id="${esc(card.id)}">${esc(name)}</button>
          ${matchLabel(card.id) ? `<span class="match-why">${esc(matchLabel(card.id))}</span>` : ""}
          <span class="col-name-meta">${esc(card.set)} #${esc(card.collector_number)} · ${esc(card.game)} · ${esc(card.rarity)}</span>
        </td>
        <td class="col-mtg">${card.is_reprint ? `<span class="tag-mtg-name">${esc(displayName(card.mtg_name))}</span>` : `<span class="dim">—</span>`}</td>
        <td class="col-set"><span class="tag-badge tag-set">${esc(card.set)}</span></td>
        <td class="col-number"><code>${esc(card.collector_number)}</code></td>
        <td class="col-game"><span class="tag-badge tag-game">${esc(card.game)}</span></td>
        <td class="col-rarity"><span class="tag-badge tag-rarity-${esc(card.rarity.toLowerCase())}">${esc(card.rarity)}</span></td>
        <td class="col-avail"><div class="table-variants-badges">${availBadges}</div></td>
        <td class="col-inventory"><div class="table-qty-stack">${qtyRows}</div></td>
        <td class="col-total"><span class="table-total ${isOwned ? "has-qty" : ""}" data-row-total>${totalQty}</span></td>
        <td class="col-condition">
          <select class="table-select" data-change="condition" data-card-id="${esc(card.id)}" aria-label="Condition for ${esc(name)}">
            ${CONDITION_OPTIONS.map(opt => `<option value="${esc(opt)}" ${entry.condition === opt ? "selected" : ""}>${esc(opt)}</option>`).join("")}
          </select>
        </td>
        <td class="col-price">${money(cardPrice(card, "price_usd").value, cardPrice(card, "price_usd").currency)}</td>
        <td class="col-price-foil">${money(cardPrice(card, "price_foil").value, cardPrice(card, "price_foil").currency)}</td>
        <td class="col-paid">${purchaseCell(card, entry)}</td>
        <td class="col-location">
          <input type="text" class="table-input" placeholder="Binder page, box..."
                 value="${esc(entry.location)}" aria-label="Storage location for ${esc(name)}"
                 data-change="location" data-card-id="${esc(card.id)}">
        </td>
      </tr>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Targeted UI updates
//
// Stepping a quantity used to re-render the whole page (60 cards of innerHTML),
// which was slow on a phone and dropped focus out of table inputs mid-edit.
// These update only the nodes that actually changed.
// ---------------------------------------------------------------------------

function refreshCardUI(cardId) {
  const card = cardsById.get(cardId);
  if (!card) return;
  const entry = readCard(cardId);
  const totalQty = entryTotalQty(entry);

  const tile = document.querySelector(`[data-card-tile="${cssEscape(cardId)}"]`);
  if (tile) {
    tile.classList.toggle("is-owned", totalQty > 0);
    const badge = tile.querySelector("[data-owned-badge]");
    if (badge) {
      badge.style.display = totalQty > 0 ? "" : "none";
      const count = badge.querySelector("[data-owned-count]");
      if (count) count.textContent = String(totalQty);
    }
    const label = tile.querySelector("[data-owned-label]");
    if (label) label.textContent = `${totalQty} Owned`;
    const chips = tile.querySelector("[data-chips]");
    if (chips) chips.innerHTML = renderVariantChips(card, entry);
  }

  const row = document.querySelector(`[data-card-row="${cssEscape(cardId)}"]`);
  if (row) {
    row.classList.toggle("row-owned", totalQty > 0);
    const totalEl = row.querySelector("[data-row-total]");
    if (totalEl) {
      totalEl.textContent = String(totalQty);
      totalEl.classList.toggle("has-qty", totalQty > 0);
    }
    getCardVariantDefs(card).forEach(def => {
      const input = row.querySelector(`input[data-vkey="${cssEscape(def.key)}"]`);
      if (!input) return;
      const qty = entry.variants[def.key] || 0;
      if (document.activeElement !== input) input.value = String(qty);
      const labelEl = input.parentElement ? input.parentElement.querySelector(".table-qty-label") : null;
      if (labelEl) labelEl.classList.toggle("has-qty", qty > 0);
    });
  }

  const modalTotal = document.getElementById("modalTotalCopiesBadge");
  if (modalTotal && modalTotal.getAttribute("data-card-id") === cardId) {
    modalTotal.textContent = `${totalQty} Total Copies`;
    getCardVariantDefs(card).forEach(def => {
      const qty = entry.variants[def.key] || 0;
      const valEl = document.getElementById(`modalVal_${def.key}`);
      if (valEl) valEl.textContent = String(qty);
      const statusEl = document.getElementById(`modalStatus_${def.key}`);
      if (statusEl) {
        statusEl.textContent = qty > 0 ? "✓ Collected" : "—";
        statusEl.classList.toggle("is-collected", qty > 0);
      }
    });
    // The purchase fields live in the inventory panel now, one row per lot.
    refreshInventoryPanel(cardId);
  }

  refreshPurchaseDisplays(cardId, card, entry);
}

/** A field on one purchase lot in the open card window. */
function lotField(change, lotId) {
  return document.querySelector(
    `#modalContent [data-change="${change}"][data-lot-id="${cssEscape(lotId)}"]`);
}

/**
 * Redraw the paid / gain-loss block on the tile and in the table row.
 *
 * Both are summaries of the whole card, so any quantity change moves them - and
 * clearing a purchase on removal has to take the block away, not leave a stale
 * one behind.
 */
function refreshPurchaseDisplays(cardId, card, entry) {
  const tile = document.querySelector(`[data-card-tile="${cssEscape(cardId)}"]`);
  if (tile) {
    const host = tile.querySelector("[data-purchase-row]");
    if (host) host.outerHTML = purchaseRow(card, entry);
  }
  const row = document.querySelector(`[data-card-row="${cssEscape(cardId)}"]`);
  if (row) {
    const cell = row.querySelector(".col-paid");
    if (cell) cell.innerHTML = purchaseCell(card, entry);
  }
  refreshDetailFields(cardId, entry);
}

/**
 * Put the condition, location and serial boxes back in step with the entry.
 *
 * Removing the last copy clears all three, and without this the old values sit
 * on screen looking saved - then get written back the next time the field is
 * touched.
 */
function refreshDetailFields(cardId, entry) {
  const setIfIdle = (el, value) => {
    if (el && document.activeElement !== el) el.value = value;
  };

  const row = document.querySelector(`[data-card-row="${cssEscape(cardId)}"]`);
  if (row) {
    setIfIdle(row.querySelector('[data-change="location"]'), entry.location || "");
    setIfIdle(row.querySelector('[data-change="condition"]'), entry.condition || DEFAULT_CONDITION);
  }

  const modalCondition = document.getElementById("modalConditionSelect");
  if (modalCondition && modalCondition.getAttribute("data-card-id") === cardId) {
    setIfIdle(modalCondition, entry.condition || DEFAULT_CONDITION);
  }
  const modalLocation = document.getElementById("modalLocationInput");
  if (modalLocation && modalLocation.getAttribute("data-card-id") === cardId) {
    setIfIdle(modalLocation, entry.location || "");
  }
  const serial = document.querySelector(
    `#modalContent [data-change="serial"][data-card-id="${cssEscape(cardId)}"]`);
  setIfIdle(serial, (entry.serialNumbers && entry.serialNumbers.serialized) || "");
}

/** CSS.escape with a fallback for older mobile browsers. */
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/["\\\]\[]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Pagination UI
// ---------------------------------------------------------------------------

function renderPagination(totalPages) {
  const topPagination = document.getElementById("topPagination");
  const bottomPagination = document.getElementById("bottomPagination");

  if (totalPages <= 1) {
    topPagination.innerHTML = "";
    bottomPagination.innerHTML = "";
    return;
  }

  const html = `
    <button type="button" class="page-btn" ${currentPage === 1 ? "disabled" : ""} data-action="goto-page" data-page="1" aria-label="First page">«</button>
    <button type="button" class="page-btn" ${currentPage === 1 ? "disabled" : ""} data-action="goto-page" data-page="${currentPage - 1}" aria-label="Previous page">‹</button>
    <span class="page-indicator">Page ${currentPage} / ${totalPages}</span>
    <button type="button" class="page-btn" ${currentPage === totalPages ? "disabled" : ""} data-action="goto-page" data-page="${currentPage + 1}" aria-label="Next page">›</button>
    <button type="button" class="page-btn" ${currentPage === totalPages ? "disabled" : ""} data-action="goto-page" data-page="${totalPages}" aria-label="Last page">»</button>
  `;

  topPagination.innerHTML = html;
  bottomPagination.innerHTML = html;
}

function goToPage(page) {
  if (!page || Number.isNaN(page)) return;
  currentPage = page;
  renderCards();
  const anchor = document.getElementById("cardsSection");
  const top = anchor ? anchor.offsetTop - 12 : 0;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

// ---------------------------------------------------------------------------
// Collection mutations
// ---------------------------------------------------------------------------

/**
 * Set how many copies of one finish are owned.
 *
 * Removing the last copy also clears what was paid for it. A price and a date
 * describe a copy you HAVE; once it is gone they are stale, and leaving them
 * behind meant a card you had removed still carried its old cost into the
 * portfolio totals and still drew a gain/loss line on its tile.
 *
 * Only the finish being emptied is cleared - the other finishes of the same
 * card keep their own records.
 */
function setVariantQuantity(cardId, variantKey, quantity, options) {
  const entry = editCard(cardId);
  const opts = options || {};
  const heldBefore = entryTotalQty(entry);
  const lotsBefore = entry.inventory.length;

  // The quantity map is derived, so the change is made to the lots underneath
  // and the map recomputed from them. reconcileVariantQuantity decides which
  // lots absorb it; see the note there on why unpriced ones go first.
  reconcileVariantQuantity(entry, variantKey, Math.max(0, quantity));

  // Nothing left at all: clear everything that described the copies. Condition,
  // storage location and serial number all describe cards you HAVE, so leaving
  // them behind meant a card you had removed still sat in the sheet - and still
  // showed up in its old binder - carrying every original detail.
  //
  // The entry itself stays, zeroed, with its updatedAt. That zero is what tells
  // your other devices the card is gone; delete it outright and a phone that
  // has not synced would push its old copy back and resurrect the card.
  if (!entry.inventory.length) {
    entry.serialNumbers = {};
    entry.location = "";
    entry.condition = DEFAULT_CONDITION;
  }

  syncEntryVariants(entry);
  entry.acquired = summariseAcquired(entry.inventory);
  saveCollectionState();
  refreshCardUI(cardId);
  // Stepping a quantity can create or destroy a lot, so the panel may be a
  // different shape; rebuild it rather than trusting the focus guard.
  if (modalCardId === cardId) refreshInventoryPanel(cardId, lotsBefore !== entry.inventory.length);

  // First copy of a card, added from a tile: open the details window with the
  // cursor in that finish's price box. The tile no longer carries an "Add
  // Purchase Price" button, so this is what keeps the purchase fields reachable
  // at the moment they are actually wanted.
  //
  // Only on the 0 -> owned edge, so adding a second copy does not interrupt,
  // and only when the window is not already showing this card.
  if (opts.revealPurchase && heldBefore === 0 && entryTotalQty(entry) > 0
      && modalCardId !== cardId) {
    openCardModal(cardId);
    focusPurchasePrice(variantKey);
  }
}

function stepVariant(cardId, variantKey, step, options) {
  const current = readCard(cardId).variants[variantKey] || 0;
  setVariantQuantity(cardId, variantKey, current + step, options);
}

function tableSetVariantQty(cardId, variantKey, value) {
  setVariantQuantity(cardId, variantKey, parseInt(value, 10) || 0);
}

function setCardCondition(cardId, value) {
  editCard(cardId).condition = value;
  saveCollectionState("Condition updated");
}

function setCardLocation(cardId, value) {
  editCard(cardId).location = value;
  saveCollectionState("Storage location saved");
}

function setCardSerial(cardId, value) {
  editCard(cardId).serialNumbers.serialized = value;
  saveCollectionState("Serial number saved");
}

// ---------------------------------------------------------------------------
// Live Dashboard & Game Pills
// ---------------------------------------------------------------------------

function updateDashboardStats() {
  const totalCardsInSet = CARDS_DATA.length;
  let uniqueOwned = 0;
  let totalCopies = 0;
  let totalNonFoil = 0;
  let totalFoil = 0;
  let totalSpecial = 0;
  let estimatedValue = 0;
  let costBasis = 0;
  let pricedMarketValue = 0;
  let pricedCount = 0;

  const gameStats = {};
  GAME_LIST.forEach(game => { gameStats[game] = { total: 0, owned: 0 }; });

  CARDS_DATA.forEach(card => {
    const entry = readCard(card.id);
    const qty = entryTotalQty(entry);
    const variants = entry.variants;

    if (qty > 0) {
      uniqueOwned++;
      totalCopies += qty;
      totalNonFoil += variants.nonfoil || 0;
      totalFoil += variants.foil || 0;
      totalSpecial += (variants.surge || 0) + (variants.wave || 0) + (variants.etched || 0) +
                      (variants.promo || 0) + (variants.serialized || 0);

      // One shared calculation, so the dashboard and the per-card figures can
      // never disagree about what a finish is worth. Named `totals` rather than
      // `money` so it cannot shadow the money() formatter.
      const totals = cardFinancials(card, entry);
      estimatedValue += totals.marketValue;
      if (totals.costBasis > 0) {
        costBasis += totals.costBasis;
        pricedMarketValue += totals.pricedMarket;
        pricedCount++;
      }
    }

    if (gameStats[card.game]) {
      gameStats[card.game].total++;
      if (qty > 0) gameStats[card.game].owned++;
    }
  });

  const completionPct = totalCardsInSet > 0 ? (uniqueOwned / totalCardsInSet) * 100 : 0;

  setText("statTotalSet", totalCardsInSet.toLocaleString());
  setText("statUniqueOwned", uniqueOwned.toLocaleString());
  setText("statUniquePct", `${completionPct.toFixed(1)}% unique completion`);
  setText("statTotalCopies", totalCopies.toLocaleString());
  setText("statVariantsBreakdown", `${totalNonFoil} Non-Foil • ${totalFoil} Foil • ${totalSpecial} Special`);
  setText("statMarketValue", usd(estimatedValue));

  // Portfolio gain / loss. Only the cards with a purchase price recorded are in
  // the cost basis, so the market value used here is theirs alone - comparing a
  // whole collection's value against a partial cost would overstate the gain.
  const net = pricedMarketValue - costBasis;
  const roi = costBasis > 0 ? (net / costBasis) * 100 : null;
  const netEl = document.getElementById("statNetGain");
  if (netEl) {
    const sign = net > 0 ? "+" : net < 0 ? "−" : "";
    netEl.textContent = `${sign}${usd(Math.abs(net))}`;
    netEl.classList.toggle("is-up", net > 0);
    netEl.classList.toggle("is-down", net < 0);
  }
  setText("statNetGainSub", costBasis > 0
    ? `${usd(costBasis)} spent on ${pricedCount.toLocaleString()} card${pricedCount === 1 ? "" : "s"} • ROI ${roi >= 0 ? "+" : "−"}${Math.abs(roi).toFixed(1)}%`
    : "Record a purchase price to see gain or loss");
  setText("progressBarPercent", `${completionPct.toFixed(1)}% (${uniqueOwned.toLocaleString()} / ${totalCardsInSet.toLocaleString()})`);

  // The collapsed strip. Fed from the same figures as the cards above it, so
  // hiding the panel can never show you a different number.
  setText("stripOwned", uniqueOwned.toLocaleString());
  setText("stripCopies", totalCopies.toLocaleString());
  setText("stripValue", usd(estimatedValue));
  setText("stripPct", `${completionPct.toFixed(1)}%`);
  const stripNet = document.getElementById("stripNet");
  if (stripNet) {
    const sign = net > 0 ? "+" : net < 0 ? "−" : "";
    stripNet.textContent = costBasis > 0 ? `${sign}${usd(Math.abs(net))}` : "—";
    stripNet.classList.toggle("is-up", costBasis > 0 && net > 0);
    stripNet.classList.toggle("is-down", costBasis > 0 && net < 0);
  }

  const fill = document.getElementById("progressBarFill");
  if (fill) fill.style.width = `${completionPct}%`;
  const track = document.getElementById("progressTrack");
  if (track) track.setAttribute("aria-valuenow", completionPct.toFixed(1));

  updateGamePillValues(gameStats);
  refreshLocationUi();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function buildGamePills() {
  const container = document.getElementById("gamePillsRow");
  container.innerHTML = GAME_LIST.map(game => `
    <button type="button" class="game-pill" data-game="${esc(game)}" data-action="select-game" aria-pressed="false">
      <span class="game-pill-name">${esc(game)}</span>
      <span class="game-pill-stat" id="pillStat_${esc(cssId(game))}">0/0</span>
      <span class="game-pill-pct" id="pillPct_${esc(cssId(game))}">0%</span>
    </button>`).join("");
}

/** Game names contain spaces and slashes; make them safe for use in an id. */
function cssId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
}

function updateGamePillValues(gameStats) {
  GAME_LIST.forEach(game => {
    const data = gameStats[game] || { total: 0, owned: 0 };
    const pct = data.total > 0 ? (data.owned / data.total) * 100 : 0;
    setText(`pillStat_${cssId(game)}`, `${data.owned}/${data.total}`);
    setText(`pillPct_${cssId(game)}`, `${pct.toFixed(0)}%`);
  });
}

function selectGamePill(game) {
  activeGameFilter = activeGameFilter === game ? "all" : game;
  setValue("filterGame", activeGameFilter);
  syncGamePillActiveState();
  currentPage = 1;
  applyFiltersAndRender();
  savePrefs();
}

function syncGamePillActiveState() {
  document.querySelectorAll(".game-pill").forEach(pill => {
    const isActive = pill.getAttribute("data-game") === activeGameFilter;
    pill.classList.toggle("active", isActive);
    pill.setAttribute("aria-pressed", String(isActive));
  });
  const clearBtn = document.getElementById("clearGameFilterBtn");
  if (clearBtn) clearBtn.style.display = activeGameFilter !== "all" ? "inline-block" : "none";
}

// ---------------------------------------------------------------------------
// Card Detail / Multi-Variant Modal
// ---------------------------------------------------------------------------

let modalShowingBack = false;
let modalCardId = null;

// ---------------------------------------------------------------------------
// Price history
//
// price_history.js is a separate file, loaded the first time a card is opened
// rather than up front. It is not needed to browse or to record a collection,
// and it grows by about 13 KB every week, so making the whole page wait for it
// would be paying for it on every visit to use it on some.
// ---------------------------------------------------------------------------

/** Below this many readings there is no trend to look at, so nothing is shown. */
const PRICE_HISTORY_MIN_POINTS = 3;

let priceHistoryPromise = null;

function priceHistoryLoaded() {
  return typeof PRICE_HISTORY !== "undefined";
}

function loadPriceHistory() {
  if (priceHistoryLoaded()) return Promise.resolve(true);
  if (priceHistoryPromise) return priceHistoryPromise;

  priceHistoryPromise = new Promise(resolve => {
    const script = document.createElement("script");
    script.src = "price_history.js";
    script.onload = () => resolve(true);
    // No history file yet, or offline before it was ever cached. The rest of
    // the card details are unaffected, so fail quietly.
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return priceHistoryPromise;
}

/** What this card calls the finish behind a price column. */
function priceSeriesLabel(card, variantKey) {
  const defs = getCardVariantDefs(card);
  for (let i = 0; i < defs.length; i++) {
    if (defs[i].key === variantKey) return defs[i].label;
  }
  return variantKey === "foil" ? "Foil" : "Non-Foil";
}

/**
 * Readings for one card, as a list of series with the gaps closed up.
 *
 * A null reading is a week the card had no price, not a price of zero, so it is
 * dropped rather than plotted. Returns null when nothing has enough readings.
 */
function priceSeriesFor(card) {
  if (!priceHistoryLoaded()) return null;
  const all = PRICE_HISTORY && PRICE_HISTORY.cards;
  const entry = all && all[card.id];
  if (!entry) return null;

  const dates = (PRICE_HISTORY && PRICE_HISTORY.dates) || [];
  const series = [];

  // Every column Scryfall gives, in the order they should be shown. The euro
  // ones are the only prices the art cards and a few promos ever have.
  const COLUMNS = [
    { key: "usd", variant: "nonfoil", currency: "usd" },
    { key: "foil", variant: "foil", currency: "usd" },
    { key: "etched", variant: "etched", currency: "usd" },
    { key: "eur", variant: "nonfoil", currency: "eur" },
    { key: "eurFoil", variant: "foil", currency: "eur" }
  ];

  COLUMNS.forEach(column => {
    const values = entry[column.key] || [];
    const points = [];
    for (let i = 0; i < dates.length; i++) {
      if (typeof values[i] === "number") points.push({ date: dates[i], value: values[i] });
    }
    if (points.length < PRICE_HISTORY_MIN_POINTS) return;
    // Do not show the euro line for a card that already has a dollar one for
    // the same finish - it would be the same card twice.
    const already = series.some(s => s.variant === column.variant && s.currency === "usd");
    if (column.currency === "eur" && already) return;
    series.push({
      label: priceSeriesLabel(card, column.variant),
      variant: column.variant,
      currency: column.currency,
      points: points
    });
  });

  return series.length ? series : null;
}

/** "2026-08-24" -> "24 Aug 26". Kept short: it sits under a small chart. */
function shortDate(iso) {
  const parts = String(iso || "").split("-");
  if (parts.length !== 3) return String(iso || "");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(parts[1]) - 1] || parts[1];
  return `${Number(parts[2])} ${month} ${parts[0].slice(2)}`;
}

/** A line chart of one series, as inline SVG - no charting library, no CDN. */
function sparkline(points, rising, currency) {
  const W = 320;
  const H = 74;
  const PAD = 8;

  let min = points[0].value;
  let max = points[0].value;
  for (let i = 1; i < points.length; i++) {
    if (points[i].value < min) min = points[i].value;
    if (points[i].value > max) max = points[i].value;
  }
  // A perfectly flat series would divide by zero; give it a band so the line
  // sits in the middle instead of on an edge.
  if (max === min) {
    max = min + Math.max(0.01, Math.abs(min) * 0.1);
    min = min - Math.max(0.01, Math.abs(min) * 0.1);
  }

  const x = i => PAD + (i * (W - 2 * PAD)) / (points.length - 1);
  const y = v => H - PAD - ((v - min) * (H - 2 * PAD)) / (max - min);

  let path = "";
  for (let i = 0; i < points.length; i++) {
    path += `${i ? "L" : "M"}${x(i).toFixed(1)},${y(points[i].value).toFixed(1)}`;
  }
  const last = points.length - 1;
  const area = `${path}L${x(last).toFixed(1)},${(H - PAD).toFixed(1)}L${x(0).toFixed(1)},${(H - PAD).toFixed(1)}Z`;
  const tone = rising ? "is-up" : "is-down";

  return `
    <svg class="price-chart ${tone}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
         role="img" aria-label="${points.length} readings, ${esc(money(min, currency))} to ${esc(money(max, currency))}">
      <path class="price-chart-area" d="${area}"></path>
      <path class="price-chart-line" d="${path}" vector-effect="non-scaling-stroke"></path>
      <circle class="price-chart-dot" cx="${x(last).toFixed(1)}" cy="${y(points[last].value).toFixed(1)}" r="3"></circle>
    </svg>`;
}

/**
 * How a purchase has moved since, as one shared calculation.
 *
 * Used by the card tiles, the table and the card window, so the three can never
 * disagree. Returns null when there is nothing to compare - no purchase price,
 * no market price, or a market price quoted in a different currency from the
 * one that was paid.
 */
/**
 * The card's overall purchase position, summed across every finish bought.
 *
 * Each finish is costed at its OWN purchase price and valued at its OWN market
 * price. Multiplying one price across every copy - which is what a single
 * per-card field forced - mispriced any card held in more than one finish.
 *
 * Null when there is nothing honest to say: nothing recorded, no market price,
 * or a market price quoted in a currency the purchase was not.
 */
function purchaseMove(card, entry) {
  const totals = cardFinancials(card, entry);
  if (!totals.comparable) return null;

  const delta = totals.netGainLoss;
  return {
    totalCost: totals.costBasis,
    totalMarket: totals.pricedMarket,
    quantity: totals.pricedQty,
    finishes: totals.lines.filter(line => line.paid !== null).length,
    delta: delta,
    pct: totals.roiPercent,
    up: delta >= 0,
    // Solid triangles rather than arrows: they read at any size.
    arrow: delta > 0 ? "▲" : delta < 0 ? "▼" : "–",
    sign: delta > 0 ? "+" : delta < 0 ? "−" : ""
  };
}

/** "▲ +$1.05 (+23.3%)" - the movement on its own, for a tile or a table cell. */
function purchaseMoveText(move) {
  const pct = move.pct === null ? "" : ` (${move.sign}${Math.abs(move.pct).toFixed(1)}%)`;
  return `${move.arrow} ${move.sign}${money2(Math.abs(move.delta))}${pct}`;
}

/** The compact form for a table row. */
function purchaseCell(card, entry) {
  const totals = cardFinancials(card, entry);
  const paid = totals.costBasis > 0 ? totals.costBasis : null;
  if (paid === null) {
    return `<button type="button" class="btn-add-purchase is-compact" data-action="add-purchase"
             data-card-id="${esc(card.id)}" title="Record what you paid">＋ Add</button>`;
  }
  const move = purchaseMove(card, entry);
  return `<button type="button" class="table-purchase" data-action="add-purchase"
           data-card-id="${esc(card.id)}" title="Edit what you paid">
      <span class="purchase-paid">${esc(money2(paid))}</span>
      ${move ? `<span class="purchase-move ${move.up ? "is-up" : "is-down"}">${esc(purchaseMoveText(move))}</span>` : ""}
    </button>`;
}

/**
 * The purchase line on a card tile.
 *
 * With nothing recorded this is a button rather than blank space - otherwise
 * the feature is invisible and nobody finds it.
 */
function purchaseRow(card, entry) {
  const totals = cardFinancials(card, entry);
  const paid = totals.costBasis > 0 ? totals.costBasis : null;

  // Three states, not two.
  //
  // Nothing recorded and nothing owned: an anchor with no height. A purchase
  // price is meaningless on a card you do not have, and prompting for one on
  // all ~1,300 of those was the dead band that had to go.
  //
  // Nothing recorded but the card IS owned: a small prompt. Dropping this
  // outright went too far - with the Purchases switch on, an owned card with no
  // price showed nothing at all, so the switch looked broken and there was no
  // way back to the field from the binder. This is the compact form of it, not
  // the full-width dashed banner that used to sit on every card.
  //
  // Either way the node carries data-purchase-row, so refreshPurchaseDisplays
  // has something to replace the moment a price is entered.
  if (paid === null) {
    if (entryTotalQty(entry) === 0) {
      return `<div class="card-purchase-slot" data-purchase-row hidden></div>`;
    }
    return `
      <button type="button" class="card-purchase-add" data-purchase-row
              data-action="add-purchase" data-card-id="${esc(card.id)}"
              title="Record what you paid for this card">
        <span aria-hidden="true">＋</span> Add purchase price
      </button>`;
  }

  const move = purchaseMove(card, entry);
  const detail = move
    ? `<span class="purchase-move ${move.up ? "is-up" : "is-down"}">${esc(purchaseMoveText(move))}</span>`
    : `<span class="purchase-move is-flat">no comparable price</span>`;

  return `
    <button type="button" class="card-purchase ${move ? (move.up ? "is-up" : "is-down") : ""}"
            data-purchase-row data-action="add-purchase" data-card-id="${esc(card.id)}"
            title="Edit what you paid">
      <span class="purchase-label">Paid${totals.pricedQty > 1 ? ` (${totals.pricedQty} copies)` : ""}</span>
      <span class="purchase-paid">${esc(money2(paid))}</span>
      ${detail}
    </button>`;
}

/**
 * What you paid, per finish, and how each has moved.
 *
 * One line per finish bought, because a non-foil at two dollars and a surge
 * foil at forty are two separate purchases that share nothing but a card name.
 */
/**
 * Every copy held, one row per purchase lot, with the aggregate underneath.
 *
 * This replaces the single price-and-date pair that used to sit in the variant
 * table. Three copies bought on three days at three prices are three rows here,
 * and the cost basis adds them up instead of pricing all three at whichever
 * figure happened to be typed first.
 */
function inventoryPanel(card, entry) {
  const totals = cardFinancials(card, entry);
  const defs = getCardVariantDefs(card);
  const rows = totals.lots.map(lot => {
    const def = MASTER_VARIANTS_BY_KEY[lot.variant];
    const options = defs.map(d =>
      `<option value="${esc(d.key)}" ${d.key === lot.variant ? "selected" : ""}>${esc(d.label)}</option>`).join("");
    const move = lot.purchasePrice !== null && lot.unitMarket > 0 && lot.currency === "usd"
      ? lot.market - lot.cost
      : null;

    return `
      <tr class="lot-row" data-lot-id="${esc(lot.id)}">
        <td class="lot-variant">
          ${defs.length > 1
            ? `<select class="table-select" aria-label="Finish for this purchase"
                       data-change="lot-variant" data-card-id="${esc(card.id)}" data-lot-id="${esc(lot.id)}">
                 ${options}
               </select>`
            : `<span>${def ? def.icon : ""} ${esc(def ? def.label : lot.variant)}</span>`}
        </td>
        <td class="lot-qty">
          <input type="number" min="0" step="1" inputmode="numeric" class="table-input"
                 value="${lot.quantity}" aria-label="Copies in this purchase"
                 data-change="lot-qty" data-card-id="${esc(card.id)}" data-lot-id="${esc(lot.id)}">
        </td>
        <td class="lot-price">
          <input type="number" min="0" step="0.01" inputmode="decimal"
                 class="table-input bought-price" placeholder="Paid each"
                 value="${lot.purchasePrice === null ? "" : esc(lot.purchasePrice.toFixed(2))}"
                 aria-label="Price paid per copy"
                 data-change="lot-price" data-card-id="${esc(card.id)}" data-lot-id="${esc(lot.id)}">
        </td>
        <td class="lot-date">
          <input type="date" class="table-input bought-date" aria-label="Date bought"
                 value="${esc(lot.purchaseDate || "")}"
                 data-change="lot-date" data-card-id="${esc(card.id)}" data-lot-id="${esc(lot.id)}">
        </td>
        <td class="lot-condition">
          <select class="table-select" aria-label="Condition of these copies"
                  data-change="lot-condition" data-card-id="${esc(card.id)}" data-lot-id="${esc(lot.id)}">
            ${CONDITION_OPTIONS.map(opt =>
              `<option value="${esc(opt)}" ${lot.condition === opt ? "selected" : ""}>${esc(opt)}</option>`).join("")}
          </select>
        </td>
        <td class="lot-cost" data-lot-cost>${lot.purchasePrice === null ? "—" : esc(money2(lot.cost))}</td>
        <td class="lot-market" data-lot-market>${esc(money(lot.market, lot.currency))}</td>
        <td class="lot-move" data-lot-move>${move === null ? "" :
          `<span class="acquired-delta ${move >= 0 ? "is-up" : "is-down"}">${move >= 0 ? "▲" : "▼"} ${move >= 0 ? "+" : "−"}${esc(money2(Math.abs(move)))}</span>`}</td>
        <td class="lot-remove">
          <button type="button" class="lot-remove-btn" data-action="lot-remove"
                  data-card-id="${esc(card.id)}" data-lot-id="${esc(lot.id)}"
                  aria-label="Remove this purchase" title="Remove this purchase">×</button>
        </td>
      </tr>`;
  }).join("");

  const empty = `
    <tr class="lot-empty"><td colspan="9">
      No copies recorded yet. Add one to start tracking what you paid.
    </td></tr>`;

  return `
    <div id="modalInventoryPanel" class="inventory-panel">
      <div class="inventory-head">
        <span>Copies &amp; purchases</span>
        <button type="button" class="btn btn-outline btn-small" data-action="lot-add"
                data-card-id="${esc(card.id)}">＋ Add copy / purchase</button>
      </div>
      <div class="inventory-table-wrap">
        <table class="inventory-table">
          <thead>
            <tr>
              <th>Finish</th><th>Qty</th><th>Paid each</th><th>Bought</th>
              <th>Condition</th><th>Cost</th><th>Value</th><th></th><th></th>
            </tr>
          </thead>
          <tbody>${rows || empty}</tbody>
        </table>
      </div>
      <div id="modalInventoryTotals">${inventoryTotals(totals)}</div>
    </div>`;
}

/** The aggregate line under the breakdown. */
function inventoryTotals(totals) {
  if (!totals.quantity && !totals.costBasis) return "";

  const cells = [
    ["Owned", String(totals.quantity)],
    ["Avg cost", totals.averageCost === null ? "—" : money2(totals.averageCost)],
    ["Total cost", totals.costBasis > 0 ? money2(totals.costBasis) : "—"],
    ["Market value", money(totals.marketValue, totals.currency)]
  ];

  let gain = "";
  if (totals.comparable) {
    const up = totals.netGainLoss >= 0;
    const sign = totals.netGainLoss > 0 ? "+" : totals.netGainLoss < 0 ? "−" : "";
    const roi = totals.roiPercent === null
      ? "" : ` (${sign}${Math.abs(totals.roiPercent).toFixed(1)}%)`;
    gain = `
      <div class="inventory-total-cell inventory-gain">
        <span class="inventory-total-label">Gain / loss</span>
        <span class="acquired-delta ${up ? "is-up" : "is-down"}">
          ${up ? "▲" : "▼"} ${sign}${money2(Math.abs(totals.netGainLoss))}${roi}
        </span>
      </div>`;
  }

  // Says so plainly rather than quietly comparing unlike things: the gain is
  // measured over the copies whose cost is known, not over every copy held.
  const partial = totals.costBasis > 0 && totals.pricedQty < totals.quantity
    ? `<div class="inventory-note">Gain / loss covers the ${totals.pricedQty} of
       ${totals.quantity} copies with a price recorded.</div>`
    : "";

  return `
    <div class="inventory-totals">
      ${cells.map(([label, value]) => `
        <div class="inventory-total-cell">
          <span class="inventory-total-label">${esc(label)}</span>
          <span class="inventory-total-value">${esc(value)}</span>
        </div>`).join("")}
      ${gain}
    </div>
    ${partial}`;
}

/** Redraw the panel in place, without rebuilding the modal around it. */
function refreshInventoryPanel(cardId, force) {
  const host = document.getElementById("modalInventoryPanel");
  const card = cardsById.get(cardId);
  if (!host || !card || modalCardId !== cardId) return;

  // Not while a field in it is being typed into - that would drop the caret
  // mid-edit - unless a row has been added or deleted, in which case the panel
  // is a different shape and has to be rebuilt whatever has focus.
  //
  // Without that exception, adding a purchase did nothing at all whenever the
  // cursor was already sitting in a price box, which is exactly where the tile
  // prompt puts it.
  const active = document.activeElement;
  if (!force && active && host.contains(active)
      && (active.tagName === "INPUT" || active.tagName === "SELECT")) {
    // Blocked, but the numbers still moved. Update what is computed and leave
    // the inputs alone, so the totals keep up with the price being typed
    // instead of waiting for the cursor to leave the box.
    refreshInventoryDerived(cardId, card);
    return;
  }
  host.outerHTML = inventoryPanel(card, readCard(cardId));
}

/**
 * Redraw only the parts of the panel that are calculated - each row's cost and
 * value, and the aggregate underneath. The inputs are not touched.
 */
function refreshInventoryDerived(cardId, card) {
  const totals = cardFinancials(card, readCard(cardId));
  totals.lots.forEach(lot => {
    const row = document.querySelector(
      `#modalInventoryPanel .lot-row[data-lot-id="${cssEscape(lot.id)}"]`);
    if (!row) return;
    const costEl = row.querySelector("[data-lot-cost]");
    if (costEl) costEl.textContent = lot.purchasePrice === null ? "—" : money2(lot.cost);
    const marketEl = row.querySelector("[data-lot-market]");
    if (marketEl) marketEl.textContent = money(lot.market, lot.currency);
    const moveEl = row.querySelector("[data-lot-move]");
    if (moveEl) {
      const move = lot.purchasePrice !== null && lot.unitMarket > 0 && lot.currency === "usd"
        ? lot.market - lot.cost : null;
      moveEl.innerHTML = move === null ? ""
        : `<span class="acquired-delta ${move >= 0 ? "is-up" : "is-down"}">` +
          `${move >= 0 ? "▲" : "▼"} ${move >= 0 ? "+" : "−"}` +
          `${esc(money2(Math.abs(move)))}</span>`;
    }
  });
  const totalsHost = document.getElementById("modalInventoryTotals");
  if (totalsHost) totalsHost.innerHTML = inventoryTotals(totals);
}

function priceHistoryMarkup(series) {
  const rows = series.map(s => {
    const points = s.points;
    const first = points[0].value;
    const last = points[points.length - 1].value;
    const delta = last - first;
    const pct = first ? (delta / first) * 100 : 0;
    const rising = delta >= 0;
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
    const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "–";

    return `
      <div class="price-history-row">
        <div class="price-history-row-head">
          <span class="price-history-label">${esc(s.label)}</span>
          <span class="price-history-now">${esc(money(last, s.currency))}</span>
          <span class="price-history-delta ${rising ? "is-up" : "is-down"}">
            ${arrow} ${sign}${esc(money(Math.abs(delta), s.currency))} (${sign}${Math.abs(pct).toFixed(1)}%)
          </span>
        </div>
        ${sparkline(points, rising, s.currency)}
        <div class="price-history-axis">
          <span>${esc(shortDate(points[0].date))}</span>
          <span>${points.length} readings</span>
          <span>${esc(shortDate(points[points.length - 1].date))}</span>
        </div>
      </div>`;
  }).join("");

  return `<h4 class="price-history-title">Price history</h4>${rows}`;
}

/**
 * Fill in the price history once the file is available.
 *
 * The modal is already on screen by then, so this checks the card has not
 * changed underneath it - open a card, close it, open another, and the first
 * load could otherwise write the wrong card's chart into the new modal.
 */
function renderPriceHistoryInto(card) {
  const paint = () => {
    if (modalCardId !== card.id) return;
    const host = document.getElementById("modalPriceHistory");
    if (!host) return;
    const series = priceSeriesFor(card);
    host.innerHTML = series ? priceHistoryMarkup(series) : "";
  };

  if (priceHistoryLoaded()) {
    paint();
    return;
  }
  loadPriceHistory().then(paint);
}

/**
 * Put the cursor in the price box and scroll it into view.
 *
 * Takes the finish so that adding a Surge Foil copy lands in the Surge Foil
 * price box rather than the non-foil one that happens to be first in the table.
 */
function focusPurchasePrice(variantKey) {
  const key = variantKey ? variantStorageKey(variantKey) : null;

  // The lot for the finish just added, if there is one; otherwise the first
  // price box in the panel.
  let field = null;
  if (key && modalCardId) {
    const lots = lotsForVariant(readCard(modalCardId), key);
    if (lots.length) field = lotField("lot-price", lots[lots.length - 1].id);
  }
  focusField(field || document.querySelector("#modalContent .bought-price"));
}

/** Put the cursor in the price box of a lot that was just created. */
function focusNewLot(cardId, lotId) {
  if (!lotId) return;
  // addInventoryLot redraws the panel, so the row exists by the time we look.
  focusField(lotField("lot-price", lotId));
}

function focusField(field) {
  if (!field) return;
  field.focus();
  if (typeof field.select === "function") field.select();
  if (typeof field.scrollIntoView === "function") {
    field.scrollIntoView({ block: "center" });
  }
}

function openCardModal(cardId) {
  const card = cardsById.get(cardId);
  if (!card) return;

  const entry = readCard(cardId);
  const totalQty = entryTotalQty(entry);
  const modal = document.getElementById("cardModal");
  const content = document.getElementById("modalContent");
  const name = displayName(card.ff_name);

  modalCardId = cardId;
  modalShowingBack = false;

  const hasBack = Boolean(card.back_image);

  const variantRows = getCardVariantDefs(card).map(def => {
    const qty = entry.variants[def.key] || 0;
    const price = variantPrice(card, def);
    return `
      <tr>
        <td><strong>${def.icon} ${esc(def.label)}</strong></td>
        <td class="variant-price">${money(price.value, price.currency)}</td>
        <td>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" data-action="modal-step" data-card-id="${esc(card.id)}" data-vkey="${esc(def.key)}" data-step="-1" aria-label="Remove one ${esc(def.label)}">−</button>
            <div class="stepper-val" id="modalVal_${esc(def.key)}">${qty}</div>
            <button type="button" class="stepper-btn" data-action="modal-step" data-card-id="${esc(card.id)}" data-vkey="${esc(def.key)}" data-step="1" aria-label="Add one ${esc(def.label)}">+</button>
          </div>
        </td>
        <td>
          ${def.key === "serialized"
            ? `<input type="text" class="table-input serial-input" placeholder="# 042 / 500"
                 value="${esc(entry.serialNumbers.serialized || "")}"
                 aria-label="Serial number"
                 data-change="serial" data-card-id="${esc(card.id)}">`
            : `<span class="variant-status ${qty > 0 ? "is-collected" : ""}" id="modalStatus_${esc(def.key)}">${qty > 0 ? "✓ Collected" : "—"}</span>`}
        </td>
      </tr>`;
  }).join("");

  content.innerHTML = `
    <div class="modal-image-col">
      <img id="modalCardImg" class="modal-image-large"
           src="${esc(card.image_large || card.image_normal)}" alt="${esc(name)}" decoding="async">
      ${hasBack ? `<button type="button" class="btn btn-outline" data-action="flip-card">\u{1F504} Flip Card</button>` : ""}
    </div>

    <div class="modal-details-col">
      <div>
        <div class="tag-badge tag-game" style="margin-bottom: 6px;">${esc(card.game)}</div>
        <h2 class="modal-title">${esc(name)}</h2>
        ${card.is_reprint ? `<div class="modal-mtg-ref">Original Magic card name: <strong>${esc(displayName(card.mtg_name))}</strong></div>` : ""}
        <div class="modal-type">${esc(card.type_line)}${card.mana_cost ? ` • ${esc(card.mana_cost)}` : ""}</div>
      </div>

      <div class="modal-variant-inventory">
        <div class="modal-variant-inventory-title">
          <span>\u{1F451} AVAILABLE PRINT VARIANTS</span>
          <span class="modal-total-badge" id="modalTotalCopiesBadge" data-card-id="${esc(card.id)}">${totalQty} Total Copies</span>
        </div>
        <div class="variant-table-wrap">
          <table class="variant-table">
            <thead>
              <tr><th>Variant Finish</th><th>Est. Price</th><th>Quantity Owned</th><th>Status / Notes</th></tr>
            </thead>
            <tbody>${variantRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Your copies: what you paid, and where they physically are. The
           storage box used to sit far below, past the price history and the
           card's own facts, while the prices it belongs with were entered in
           the table above. Same section now, directly under the entry fields. -->
      <div class="modal-your-copies">
        <div class="modal-your-copies-title">\u{1F4B0} PURCHASE &amp; STORAGE</div>
        ${inventoryPanel(card, entry)}
        <div class="modal-field-grid">
          <div>
            <label class="field-label" for="modalLocationInput">Storage location</label>
            <input id="modalLocationInput" type="text" class="table-input" placeholder="e.g. Binder 1, page 3"
                   value="${esc(entry.location)}" data-change="location" data-card-id="${esc(card.id)}">
          </div>
          <div>
            <label class="field-label" for="modalConditionSelect">Overall condition</label>
            <select id="modalConditionSelect" class="table-select" data-change="condition" data-card-id="${esc(card.id)}">
              ${CONDITION_OPTIONS.map(opt => `<option value="${esc(opt)}" ${entry.condition === opt ? "selected" : ""}>${esc(opt)}</option>`).join("")}
            </select>
          </div>
        </div>
      </div>

      <div id="modalPriceHistory" class="price-history"></div>

      ${card.oracle_text ? `<div class="modal-oracle-box">${esc(card.oracle_text)}</div>` : ""}
      ${card.flavor_text ? `<div class="modal-flavor-box">${esc(card.flavor_text)}</div>` : ""}

      <div class="modal-meta-grid">
        <div class="modal-meta-item"><strong>Set:</strong> ${esc(card.set_name)} (${esc(card.set)})</div>
        <div class="modal-meta-item"><strong>Collector #:</strong> ${esc(card.collector_number)}</div>
        <div class="modal-meta-item"><strong>Base printing:</strong> ${esc(card.variant)}</div>
        <div class="modal-meta-item"><strong>Treatment:</strong> ${esc((card.treatments || [card.treatment]).join(", "))}</div>
        <div class="modal-meta-item"><strong>Rarity:</strong> ${esc(card.rarity)}</div>
        <div class="modal-meta-item"><strong>Artist:</strong> ${esc(card.artist || "Unknown")}</div>
      </div>

      <div class="modal-footer-actions">
        <a href="${esc(card.scryfall_uri)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline">View on Scryfall ↗</a>
      </div>
    </div>`;

  modal.style.display = "flex";
  document.body.classList.add("modal-open");

  // Fills itself in once price_history.js has loaded; stays empty if this card
  // has fewer than PRICE_HISTORY_MIN_POINTS readings.
  renderPriceHistoryInto(card);
}

function closeModal() {
  const modal = document.getElementById("cardModal");
  if (!modal || modal.style.display === "none") return;
  modal.style.display = "none";
  document.body.classList.remove("modal-open");
  modalCardId = null;
}

/**
 * Toggle between the front and back face. Tracked with an explicit flag - the
 * previous version compared the <img> src against the front URL, but the modal
 * opens with image_large while the comparison used image_normal, so the first
 * tap never actually flipped anything.
 */
function flipModalCard() {
  const card = cardsById.get(modalCardId);
  const img = document.getElementById("modalCardImg");
  if (!card || !img || !card.back_image) return;
  modalShowingBack = !modalShowingBack;
  img.src = modalShowingBack ? card.back_image : (card.image_large || card.image_normal);
}

// ---------------------------------------------------------------------------
// Backup, Restore & Export
// ---------------------------------------------------------------------------

/**
 * Download via a Blob rather than a data: URI. A data: URI of the whole CSV
 * breaks on any '#' that encodeURI leaves alone, and iOS Safari refuses very
 * long data: URLs outright.
 */
function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function exportJsonBackup() {
  pruneCollection();
  const payload = JSON.stringify(collection, null, 2);
  downloadFile(`MTG_FF_Collection_Backup_${todayStamp()}.json`, payload, "application/json");
  const count = Object.keys(collection.cards).length;
  showToast(`Backup downloaded (${count} card${count === 1 ? "" : "s"})`);
}

function importJsonBackup(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    let parsed;
    try {
      parsed = JSON.parse(e.target.result);
    } catch (err) {
      alert("That file is not valid JSON, so nothing was imported.\n\nYour collection has not been changed.");
      input.value = "";
      return;
    }

    const incoming = normaliseCollection(parsed);
    if (!incoming) {
      alert("That file does not look like a collection backup, so nothing was imported.\n\nYour collection has not been changed.");
      input.value = "";
      return;
    }

    const incomingCount = Object.keys(incoming.cards).length;
    const currentCount = Object.keys(collection.cards).length;
    const message =
      "Restore this backup?\n\n" +
      `  Backup file: ${incomingCount} card${incomingCount === 1 ? "" : "s"} with data\n` +
      `  On this device now: ${currentCount} card${currentCount === 1 ? "" : "s"} with data\n\n` +
      "This REPLACES what is on this device. Cancel if you are not sure.";

    if (!confirm(message)) {
      input.value = "";
      showToast("Restore cancelled");
      return;
    }

    collection = incoming;
    saveCollectionState(`Restored ${incomingCount} card${incomingCount === 1 ? "" : "s"}`);
    applyFiltersAndRender();
    input.value = "";
  };
  reader.readAsText(file);
}

function csvCell(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function exportCsvData() {
  const variantDefs = availableVariantKeys();

  const headers = [
    "Final Fantasy Name", "Original MTG Name", "Set", "Collector Number", "FF Game", "Rarity",
    "Available Variants"
  ]
    .concat(variantDefs.map(def => `${def.label} Qty`))
    .concat([
      "Serial Number", "Total Qty Owned", "Owned Status", "Condition",
      "Price USD (Normal)", "Price USD (Foil)", "Storage Location", "Image URL"
    ]);

  const rows = [headers.map(csvCell).join(",")];

  CARDS_DATA.forEach(card => {
    const entry = readCard(card.id);
    const totalQty = entryTotalQty(entry);
    const cells = [
      csvCell(displayName(card.ff_name)),
      csvCell(displayName(card.mtg_name)),
      csvCell(card.set),
      csvCell(card.collector_number),
      csvCell(card.game),
      csvCell(card.rarity),
      csvCell((card.avail_variants || []).join(", "))
    ]
      .concat(variantDefs.map(def => csvCell(entry.variants[def.key] || 0)))
      .concat([
        csvCell(entry.serialNumbers.serialized || ""),
        csvCell(totalQty),
        csvCell(totalQty > 0 ? "Yes" : "No"),
        csvCell(entry.condition),
        csvCell(typeof card.price_usd === "number" ? card.price_usd.toFixed(2) : ""),
        csvCell(typeof card.price_foil === "number" ? card.price_foil.toFixed(2) : ""),
        csvCell(entry.location),
        csvCell(card.image_normal || "")
      ]);
    rows.push(cells.join(","));
  });

  // UTF-8 BOM so Excel opens the accented card names correctly.
  const csv = "﻿" + rows.join("\r\n");
  downloadFile(`MTG_FF_Collection_${todayStamp()}.csv`, csv, "text/csv;charset=utf-8");
  showToast("CSV export downloaded");
}

function resetEntireCollection() {
  const count = Object.keys(collection.cards).length;
  if (count === 0) {
    showToast("Nothing to reset - the collection is already empty");
    return;
  }
  const message =
    "Reset the whole collection?\n\n" +
    `This clears the recorded copies, conditions and locations for ${count} card${count === 1 ? "" : "s"} on this device.\n\n` +
    "This cannot be undone unless you have a JSON backup.";
  if (!confirm(message)) return;

  collection = createEmptyCollection();
  saveCollectionState("Collection reset");
  applyFiltersAndRender();
}

// ---------------------------------------------------------------------------
// Toast, connectivity & service worker
// ---------------------------------------------------------------------------

let toastTimer = null;

function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle("is-error", Boolean(isError));
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // A file:// page cannot register a service worker; skip quietly when testing locally.
  if (location.protocol !== "http:" && location.protocol !== "https:") return;

  // Reload once when a new service worker takes over.
  //
  // Without this, the first visit after an upload still runs the JS and card
  // data the browser had already loaded: the new worker installs, claims
  // control, and caches the new files - but the page in front of you is the old
  // one, and only the NEXT visit shows the update. That made every change look
  // like it had not taken, and made a filter built from new data but matched by
  // old code return nothing at all.
  //
  // Guarded twice: `hadController` is false on the very first registration, when
  // clients.claim() fires this for a page that is already current, and
  // `reloading` stops the reload repeating.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(err => {
      console.info("Service worker registration skipped:", err && err.message);
    });
  });
}

// ===========================================================================
// Google Sheet sync
//
// The device copy in localStorage is the working copy: every edit lands there
// first, instantly, online or not. The sheet is the shared copy that lets a
// laptop and a phone see the same collection.
//
// Merging happens in the Apps Script, not here, so two devices saving at the
// same moment fold into each other instead of overwriting. Each card carries
// its own updatedAt, so "newest wins" is decided per card rather than per
// device - editing a different card on each device loses nothing.
//
// Requests are deliberately plain: GET with query parameters, POST with a
// text/plain body. That keeps them "simple" cross-origin requests. Sending
// application/json would make the browser fire a preflight OPTIONS check that
// Apps Script cannot answer, and every save would fail.
// ===========================================================================

const SYNC_KEY = "ff_mtg_sync_v1";

/** Marks that the one-time repair of already-removed cards has run. */
const REMOVAL_REPAIR_KEY = "ff_mtg_removal_repair_v1";
const SYNC_DEBOUNCE_MS = 4000;
const SYNC_TIMEOUT_MS = 25000;

/**
 * The Code.gs version this tracker expects, checked on every sync.
 *
 * A Google Apps Script web app serves a frozen snapshot from whenever it was
 * last deployed - saving the editor changes nothing until a new version is
 * published. That failure is completely silent: the sync keeps working, it just
 * runs old code. Checking the version turns a baffling "my fix did nothing" into
 * a message that says exactly what to do.
 */
const REQUIRED_SCRIPT_VERSION = 8;

const STALE_SCRIPT_MESSAGE =
  "Your sheet is running an old copy of the sync script, so recent fixes are not " +
  "active. In the Apps Script editor choose Deploy, then Manage deployments, then " +
  "the pencil icon, set Version to New version, and click Deploy. The web address " +
  "does not change.";

/** True when the sheet's deployed script is older than this tracker needs. */
/**
 * Set once a reply shows the deployed script is behind, and cleared only when a
 * reply shows it is current again.
 *
 * While it is set, this device stops PUSHING. An old script silently ignores
 * fields it does not know about - the per-finish purchase records, for one - so
 * pushing into it does not fail, it just quietly drops half the edit and writes
 * the rest back over the sheet. Holding the changes on the device until the
 * redeploy is the only lossless option; pulling is still safe and continues.
 */
let syncScriptStale = false;

function isScriptStale(result) {
  return !result || Number(result.scriptVersion || 0) < REQUIRED_SCRIPT_VERSION;
}
/** Tolerance for the two devices disagreeing about what time it is. */
const SYNC_CLOCK_GRACE_MS = 10 * 60 * 1000;

let syncConfig = { mode: "unset", url: "", lastSync: 0 };
let syncStatus = "idle";      // idle | syncing | ok | error | offline
let syncMessage = "";
let syncTimer = null;
let syncInFlight = false;
let syncQueuedAgain = false;
let syncModalView = "auto";   // auto | chooser | connect | connected
let syncTestResult = null;

function loadSyncConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(SYNC_KEY) || "null");
    if (saved && typeof saved === "object") {
      syncConfig = {
        mode: saved.mode === "sheet" || saved.mode === "local" ? saved.mode : "unset",
        url: typeof saved.url === "string" ? saved.url : "",
        lastSync: Number(saved.lastSync) || 0
      };
    }
  } catch (e) {
    console.error("Could not read sync settings", e);
  }
  if (syncConfig.mode === "sheet" && !syncConfig.url) syncConfig.mode = "unset";
}

function saveSyncConfig() {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(syncConfig));
  } catch (e) {
    console.error("Could not save sync settings", e);
  }
}

function initSync() {
  renderSyncBadge();

  window.addEventListener("online", () => {
    renderSyncBadge();
    if (syncConfig.mode === "sheet" && hasPendingChanges()) runSync({ silent: true });
  });
  window.addEventListener("offline", renderSyncBadge);

  // Leaving the page with unsaved changes: send them with sendBeacon, which
  // survives the page going away. A normal fetch would be cancelled.
  window.addEventListener("pagehide", flushSyncOnExit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSyncOnExit();
  });

  // Keep the "Last synced 5 min ago" wording honest without re-rendering.
  setInterval(renderSyncBadge, 60000);

  if (syncConfig.mode === "unset") {
    // First visit on this device: ask where the collection should live.
    openSyncModal("chooser");
    return;
  }

  if (syncConfig.mode === "sheet") {
    // Pick up anything the other device changed while this one was closed.
    runSync({ silent: true });
  }
}

// ---------------------------------------------------------------------------
// What needs sending
// ---------------------------------------------------------------------------

/**
 * Cards edited since the last successful sync, in the shape the script expects.
 * The name / set / number fields are along for the ride so the sheet is
 * readable by a human; they are never read back into the collection.
 */
function cardsChangedSince(since) {
  const payload = {};
  for (const id in collection.cards) {
    const entry = collection.cards[id];
    if (!entry || (entry.updatedAt || 0) <= since) continue;
    const card = cardsById.get(id);
    payload[id] = {
      variants: entry.variants,
      serialNumbers: entry.serialNumbers,
      condition: entry.condition,
      location: entry.location,
      // The lots are the truth. `acquired` and `variants` go with them as
      // derived summaries so the sheet stays readable and a device still on the
      // old build sees sensible figures instead of blanks.
      inventory: entryInventory(entry),
      acquired: entry.acquired || {},
      updatedAt: entry.updatedAt,
      ff_name: card ? displayName(card.ff_name) : "",
      set: card ? card.set : "",
      number: card ? card.collector_number : ""
    };
  }
  return payload;
}

function hasPendingChanges() {
  for (const id in collection.cards) {
    const entry = collection.cards[id];
    if (entry && (entry.updatedAt || 0) > syncConfig.lastSync) return true;
  }
  return false;
}

function countPendingChanges() {
  let count = 0;
  for (const id in collection.cards) {
    const entry = collection.cards[id];
    if (entry && (entry.updatedAt || 0) > syncConfig.lastSync) count++;
  }
  return count;
}

/**
 * Adopt the merged result from the sheet. Local wins ties - it just pushed.
 *
 * Conflicts are settled by the timestamp written by whichever device made the
 * edit, NOT by which push arrived last. That is deliberate: a phone that has
 * been offline for a week must not overwrite newer work done on the laptop just
 * because it reconnected afterwards. The cost is that the rule trusts device
 * clocks, so a device whose clock is minutes out could lose an edit it believes
 * is newer. Phones and laptops keep network time, so that trade is worth making.
 *
 * `syncStartedAt` is when this sync began. Rows typed into the sheet by hand
 * have no timestamp, so they are stamped as of now - which is necessarily after
 * the sync started, and therefore guarantees they get written back to the sheet
 * with a real timestamp on the next push instead of being re-adopted forever.
 */
function mergeRemoteCards(remoteCards, syncStartedAt) {
  if (!remoteCards || typeof remoteCards !== "object") return 0;
  let changed = 0;

  for (const id in remoteCards) {
    const raw = remoteCards[id];
    const remote = normaliseEntry(raw);
    if (!remote) continue;

    const hadTimestamp = Boolean(raw && Number(raw.updatedAt));
    if (!hadTimestamp) {
      remote.updatedAt = Math.max(nowMs(), (syncStartedAt || 0) + 1);
    }

    const local = collection.cards[id];
    if (!local || remote.updatedAt > local.updatedAt) {
      // A sheet written by an older script has no purchase columns, so an
      // incoming entry can be silent about them. Keep what this device already
      // knows rather than blanking it; an explicit '' or null still clears.
      if (local) {
        const sentAcquired = raw && (
          Object.prototype.hasOwnProperty.call(raw, "acquired") ||
          Object.prototype.hasOwnProperty.call(raw, "acquiredPrice") ||
          Object.prototype.hasOwnProperty.call(raw, "acquiredDate"));
        if (!sentAcquired) {
          remote.acquired = local.acquired || {};
        }
      }
      collection.cards[id] = remote;
      changed++;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Talking to the Apps Script
// ---------------------------------------------------------------------------

function sheetUrlWith(url, params) {
  const separator = url.indexOf("?") === -1 ? "?" : "&";
  const query = Object.keys(params)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");
  return url + separator + query;
}

function fetchWithTimeout(url, options) {
  if (typeof AbortController !== "function") return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  const settings = Object.assign({}, options, { signal: controller.signal });
  return fetch(url, settings).then(
    response => { clearTimeout(timer); return response; },
    error => { clearTimeout(timer); throw error; }
  );
}

/**
 * Read a response as JSON, turning the ways Apps Script fails into messages
 * that say what to actually fix.
 */
function readSheetResponse(response) {
  return response.text().then(text => {
    const trimmed = (text || "").trim();

    if (trimmed.charAt(0) === "<") {
      // Google served a sign-in or error page instead of the script's output.
      if (trimmed.toLowerCase().indexOf("sign in") !== -1 ||
          trimmed.toLowerCase().indexOf("accounts.google.com") !== -1) {
        throw new Error('Google asked this browser to sign in. In Apps Script, set "Who has access" to "Anyone", then deploy a new version.');
      }
      throw new Error("The web address did not return collection data. Check that it is the /exec address from Deploy, and that the script was deployed after you last edited it.");
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error("The sheet sent back something unreadable. Try deploying a new version of the script.");
    }

    if (!parsed || parsed.ok !== true) {
      throw new Error((parsed && parsed.error) || "The sheet reported an error.");
    }
    return parsed;
  });
}

function sheetGet(url, action) {
  return fetchWithTimeout(sheetUrlWith(url, { action: action }), {
    method: "GET",
    redirect: "follow"
  }).then(readSheetResponse);
}

function sheetPost(url, body) {
  return fetchWithTimeout(url, {
    method: "POST",
    redirect: "follow",
    // text/plain keeps this a simple request. Do not change it to
    // application/json - Apps Script cannot answer the preflight that triggers.
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body)
  }).then(readSheetResponse);
}

// ---------------------------------------------------------------------------
// The sync cycle
// ---------------------------------------------------------------------------

function scheduleSyncPush() {
  if (syncConfig.mode !== "sheet") return;
  renderSyncBadge();
  clearTimeout(syncTimer);
  // Wait for a pause in the tapping, so a burst of edits becomes one save.
  syncTimer = setTimeout(() => runSync({ silent: true }), SYNC_DEBOUNCE_MS);
}

function runSync(options) {
  const settings = options || {};
  if (syncConfig.mode !== "sheet" || !syncConfig.url) return Promise.resolve(false);

  if (syncInFlight) {
    // Something changed mid-flight; go round again when this one lands.
    syncQueuedAgain = true;
    return Promise.resolve(false);
  }

  if (!navigator.onLine) {
    setSyncStatus("offline", "Waiting for a connection");
    return Promise.resolve(false);
  }

  clearTimeout(syncTimer);
  syncInFlight = true;
  setSyncStatus("syncing", "");

  const startedAt = nowMs();

  // A routine save sends only what changed. A full sync re-sends everything this
  // device knows about, which is also what repairs a sheet whose readable
  // name / set / number columns have gone blank - those values live on the
  // device, so only the device can restore them.
  // Nothing is sent while the deployed script is known to be out of date. The
  // edits stay on the device - they are not lost - and go up as soon as a reply
  // shows the new version is live.
  const changes = syncScriptStale
    ? {}
    : cardsChangedSince(settings.full ? 0 : syncConfig.lastSync);

  /**
   * How far back to ask the sheet for changes.
   *
   * A full reconciliation (since = 0) on a first connection or when the user
   * presses "Sync now". Otherwise only what changed since the last sync, which
   * keeps a routine save small on mobile data.
   *
   * The grace window matters: the timestamps come from whichever device made
   * the edit, so a phone whose clock is a couple of minutes off could otherwise
   * write a change that this device then considers older than its own last sync
   * and never asks for again. Re-reading a few extra minutes each time is far
   * cheaper than silently missing an edit.
   */
  const since = (settings.full || !syncConfig.lastSync)
    ? 0
    : Math.max(0, syncConfig.lastSync - SYNC_CLOCK_GRACE_MS);

  return sheetPost(syncConfig.url, {
    action: "push",
    deviceId: collection.deviceId,
    since: since,
    cards: changes
  })
    .then(result => {
      const adopted = mergeRemoteCards(result.cards, startedAt);

      // Only move the watermark forward when this device's changes actually
      // went up. cardsChangedSince() sends what is newer than lastSync, so
      // advancing it after a push that deliberately sent nothing would step
      // straight over those edits and never send them again - the sync would
      // look healthy, with the work silently stranded on this device.
      //
      // syncScriptStale is not modified until further down, so it still says
      // whether the push above carried anything.
      if (!syncScriptStale) {
        syncConfig.lastSync = startedAt;
        saveSyncConfig();
      }

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
      } catch (e) {
        console.error("Could not save merged collection", e);
      }

      if (adopted > 0) {
        updateDashboardStats();
        applyFiltersAndRender();
      } else {
        updateDashboardStats();
      }

      if (isScriptStale(result)) {
        // The sync itself worked, but against old code. Say so loudly rather
        // than letting fixes appear to do nothing - and stop sending until it
        // is fixed, so an edit cannot be half-written and half-dropped.
        syncScriptStale = true;
        setSyncStatus("error", STALE_SCRIPT_MESSAGE);
        if (!settings.silent) showToast("Sheet script is out of date - open Sync", true);
        return true;
      }

      // Back in step. lastSync was left where it was for every held-back sync,
      // so the changes are still inside the window and the push below sends
      // them.
      if (syncScriptStale) {
        syncScriptStale = false;
        scheduleSyncPush();
      }
      setSyncStatus("ok", "");
      if (!settings.silent) {
        const sent = Object.keys(changes).length;
        showToast(describeSyncResult(sent, adopted, result.cardCount));
      }
      return true;
    })
    .catch(error => {
      setSyncStatus("error", error && error.message ? error.message : String(error));
      if (!settings.silent) showToast("Sync failed - open Sync for details", true);
      return false;
    })
    .then(outcome => {
      syncInFlight = false;
      if (syncQueuedAgain) {
        syncQueuedAgain = false;
        scheduleSyncPush();
      }
      if (isSyncModalOpen()) renderSyncModal();
      return outcome;
    });
}

function describeSyncResult(sent, adopted, total) {
  if (sent === 0 && adopted === 0) return "Already up to date";
  const parts = [];
  if (sent > 0) parts.push(`sent ${sent}`);
  if (adopted > 0) parts.push(`received ${adopted}`);
  return `Synced - ${parts.join(", ")} (${total} in sheet)`;
}

/**
 * Last-gasp save when the page is closing. sendBeacon survives the page going
 * away; a fetch would be cancelled. Fire and forget - there is no response to
 * read, so lastSync is not advanced and the next load will re-send if needed.
 */
function flushSyncOnExit() {
  if (syncConfig.mode !== "sheet" || !syncConfig.url) return;
  if (!hasPendingChanges()) return;
  if (typeof navigator.sendBeacon !== "function") return;

  try {
    const body = JSON.stringify({
      action: "push",
      deviceId: collection.deviceId,
      cards: cardsChangedSince(syncConfig.lastSync)
    });
    navigator.sendBeacon(syncConfig.url, new Blob([body], { type: "text/plain;charset=UTF-8" }));
  } catch (e) {
    /* nothing useful to do while the page is going away */
  }
}

function setSyncStatus(status, message) {
  syncStatus = status;
  syncMessage = message || "";
  renderSyncBadge();
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function relativeTime(timestamp) {
  if (!timestamp) return "never";
  const seconds = Math.round((nowMs() - timestamp) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 min ago";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 7200) return "1 hour ago";
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

function renderSyncBadge() {
  const button = document.getElementById("syncBtn");
  const label = document.getElementById("syncBtnText");
  const dot = document.getElementById("syncDot");
  if (!button || !label || !dot) return;

  let text = "Sync";
  let tone = "neutral";
  let title = "Set up collection syncing";

  if (syncConfig.mode === "local") {
    text = "This device";
    title = "Your collection is saved on this device only. Click to set up syncing.";
  } else if (syncConfig.mode === "sheet") {
    const pending = countPendingChanges();
    if (syncStatus === "syncing") {
      text = "Saving...";
      tone = "busy";
      title = "Saving to your Google Sheet";
    } else if (syncStatus === "error") {
      text = "Sync problem";
      tone = "bad";
      title = syncMessage || "The last sync failed";
    } else if (!navigator.onLine) {
      text = pending ? `Offline (${pending})` : "Offline";
      tone = "warn";
      title = "No connection. Changes are saved here and will sync when you are back online.";
    } else if (pending > 0) {
      text = `${pending} to save`;
      tone = "warn";
      title = "Changes waiting to be sent to your sheet";
    } else {
      text = "Synced";
      tone = "good";
      title = `Last synced ${relativeTime(syncConfig.lastSync)}`;
    }
  }

  label.textContent = text;
  button.setAttribute("title", title);
  dot.className = `sync-dot sync-dot-${tone}`;
}

// ---------------------------------------------------------------------------
// Sync settings modal
// ---------------------------------------------------------------------------

function isSyncModalOpen() {
  const modal = document.getElementById("syncModal");
  return Boolean(modal) && modal.style.display !== "none";
}

function openSyncModal(view) {
  syncModalView = view || (syncConfig.mode === "sheet" ? "connected"
    : syncConfig.mode === "local" ? "connect" : "chooser");
  syncTestResult = null;
  renderSyncModal();
  const modal = document.getElementById("syncModal");
  modal.style.display = "flex";
  document.body.classList.add("modal-open");
}

function closeSyncModal() {
  const modal = document.getElementById("syncModal");
  if (!modal || modal.style.display === "none") return;

  // Closing the first-run chooser without picking counts as "this device only",
  // so the question is not asked again on every visit.
  if (syncConfig.mode === "unset") {
    syncConfig.mode = "local";
    saveSyncConfig();
    renderSyncBadge();
  }

  modal.style.display = "none";
  document.body.classList.remove("modal-open");
}

function handleSyncAction(action, target) {
  switch (action) {
    case "sync-choose-sheet":
      syncModalView = "connect";
      syncTestResult = null;
      renderSyncModal();
      break;
    case "sync-choose-local":
      syncConfig.mode = "local";
      syncConfig.url = "";
      saveSyncConfig();
      renderSyncBadge();
      closeSyncModal();
      showToast("Saving on this device only");
      break;
    case "sync-test":
      testSyncConnection();
      break;
    case "sync-save":
      connectSheet();
      break;
    case "sync-now":
      // Explicit button press means "reconcile everything", not just the
      // changes since last time.
      runSync({ silent: false, full: true });
      break;
    case "sync-disconnect":
      disconnectSheet();
      break;
    case "sync-back":
      syncModalView = "chooser";
      syncTestResult = null;
      renderSyncModal();
      break;
    default:
      break;
  }
}

function syncUrlInputValue() {
  const input = document.getElementById("syncUrlInput");
  return input ? input.value.trim() : "";
}

function validateSyncUrl(url) {
  if (!url) return "Paste the web address you copied from Apps Script.";
  if (url.indexOf("https://") !== 0) return "That does not look like a web address. It should start with https://";
  if (url.indexOf("script.google.com") === -1) {
    return "That is not an Apps Script address. It should look like https://script.google.com/macros/s/..../exec";
  }
  if (url.slice(-5) !== "/exec") {
    if (url.slice(-4) === "/dev") {
      return 'That is the test address. Go to Deploy > Manage deployments and copy the Web app address ending in /exec.';
    }
    return "The address should end in /exec";
  }
  return null;
}

function testSyncConnection() {
  const url = syncUrlInputValue();
  const problem = validateSyncUrl(url);
  if (problem) {
    syncTestResult = { ok: false, message: problem };
    renderSyncModal();
    return;
  }

  syncTestResult = { pending: true, message: "Checking..." };
  renderSyncModal();

  sheetGet(url, "ping")
    .then(result => {
      const connected = `Connected to "${result.sheetName || "your sheet"}" - ${result.cardCount || 0} card rows found.`;
      syncTestResult = isScriptStale(result)
        ? { ok: false, message: `${connected}\n\n${STALE_SCRIPT_MESSAGE}` }
        : { ok: true, message: connected };
    })
    .catch(error => {
      syncTestResult = { ok: false, message: error && error.message ? error.message : String(error) };
    })
    .then(() => renderSyncModal());
}

function connectSheet() {
  const url = syncUrlInputValue();
  const problem = validateSyncUrl(url);
  if (problem) {
    syncTestResult = { ok: false, message: problem };
    renderSyncModal();
    return;
  }

  const switchingSheets = syncConfig.url && syncConfig.url !== url;

  syncConfig.mode = "sheet";
  syncConfig.url = url;
  // A different sheet knows nothing about this device's history, so offer
  // everything rather than only what changed since the last sync.
  if (switchingSheets || !syncConfig.lastSync) syncConfig.lastSync = 0;
  saveSyncConfig();

  syncModalView = "connected";
  renderSyncModal();
  renderSyncBadge();

  runSync({ silent: false }).then(success => {
    if (success) showToast("Connected - your sheet is in sync");
  });
}

function disconnectSheet() {
  const message =
    "Stop syncing with your Google Sheet?\n\n" +
    "Your collection stays on this device, and your sheet is left exactly as it is.\n" +
    "You can reconnect any time by pasting the address again.";
  if (!confirm(message)) return;

  syncConfig.mode = "local";
  syncConfig.url = "";
  syncConfig.lastSync = 0;
  saveSyncConfig();
  setSyncStatus("idle", "");
  syncModalView = "connect";
  renderSyncModal();
  showToast("Disconnected from the sheet");
}

const SYNC_SETUP_STEPS = `
  <details class="sync-help">
    <summary>I have not made the sheet yet - show me how</summary>
    <ol class="sync-steps">
      <li>Go to <a href="https://sheets.new" target="_blank" rel="noopener noreferrer">sheets.new</a> to make a blank spreadsheet, and give it a name.</li>
      <li>In that spreadsheet click <strong>Extensions</strong> &rarr; <strong>Apps Script</strong>.</li>
      <li>Delete the few lines of code that are there, then paste in the contents of <code>google-apps-script/Code.gs</code> from the tracker's files. Click the save icon.</li>
      <li>Click <strong>Deploy</strong> &rarr; <strong>New deployment</strong>. Next to <strong>Select type</strong> click the gear and pick <strong>Web app</strong>.</li>
      <li>Set <strong>Execute as</strong> to <strong>Me</strong>, and <strong>Who has access</strong> to <strong>Anyone</strong>. Click <strong>Deploy</strong>.</li>
      <li>Approve the permission screens. When it warns that Google has not verified the app, click <strong>Advanced</strong>, then <strong>Go to ... (unsafe)</strong>, then <strong>Allow</strong>. This is normal for a script you wrote yourself.</li>
      <li>Copy the <strong>Web app</strong> address it gives you - it ends in <code>/exec</code> - and paste it above.</li>
    </ol>
    <p class="sync-note">The full version of these steps, with what each screen looks like, is in <code>SETUP.md</code> Part 3.</p>
  </details>
`;

function renderSyncModal() {
  const container = document.getElementById("syncModalContent");
  if (!container) return;

  if (syncModalView === "chooser") {
    container.innerHTML = `
      <h2 class="sync-title">Where should your collection live?</h2>
      <p class="sync-lede">Your cards are saved as you tap. Choose where that saving happens.</p>

      <div class="sync-choices">
        <button type="button" class="sync-choice sync-choice-primary" data-action="sync-choose-sheet">
          <span class="sync-choice-icon" aria-hidden="true">\u{1F4C4}</span>
          <span class="sync-choice-body">
            <span class="sync-choice-title">Sync with a Google Sheet</span>
            <span class="sync-choice-text">
              Your collection lives in your own spreadsheet, so it is the same on your
              laptop and your phone. You can open the sheet and edit it by hand too.
              Needs a one-time setup of about ten minutes.
            </span>
          </span>
        </button>

        <button type="button" class="sync-choice" data-action="sync-choose-local">
          <span class="sync-choice-icon" aria-hidden="true">\u{1F4F1}</span>
          <span class="sync-choice-body">
            <span class="sync-choice-title">Just use this device</span>
            <span class="sync-choice-text">
              Nothing to set up. Your collection is saved in this browser only and does
              not travel to other devices. You can switch to syncing later.
            </span>
          </span>
        </button>
      </div>

      <p class="sync-note">
        Either way, the <strong>Backup</strong> button always saves a copy you can keep.
      </p>
    `;
    return;
  }

  if (syncModalView === "connect") {
    const result = syncTestResult;
    const resultClass = !result ? "" : result.pending ? "is-pending" : (result.ok ? "is-ok" : "is-bad");
    container.innerHTML = `
      <h2 class="sync-title">Connect your Google Sheet</h2>
      <p class="sync-lede">Paste the web address from your sheet's Apps Script deployment.</p>

      <label class="field-label" for="syncUrlInput">Web app address</label>
      <input type="url" id="syncUrlInput" class="table-input sync-url-input"
             placeholder="https://script.google.com/macros/s/..../exec"
             spellcheck="false" autocapitalize="off" autocorrect="off"
             value="${esc(syncConfig.url)}">

      ${result ? `<div class="sync-result ${resultClass}">${esc(result.message)}</div>` : ""}

      <div class="sync-actions">
        <button type="button" class="btn btn-secondary" data-action="sync-test">Test connection</button>
        <button type="button" class="btn btn-primary" data-action="sync-save">Save and sync</button>
      </div>

      ${SYNC_SETUP_STEPS}

      <div class="sync-footer-links">
        <button type="button" class="btn-text" data-action="sync-back">Back</button>
      </div>
    `;
    return;
  }

  // connected
  const pending = countPendingChanges();
  const rows = Object.keys(collection.cards).length;
  let statusLine;
  let statusClass;

  if (syncStatus === "syncing") {
    statusLine = "Saving to your sheet...";
    statusClass = "is-pending";
  } else if (syncStatus === "error") {
    statusLine = syncMessage || "The last sync failed.";
    statusClass = "is-bad";
  } else if (!navigator.onLine) {
    statusLine = `No connection. ${pending} change${pending === 1 ? "" : "s"} will be sent when you are back online.`;
    statusClass = "is-warn";
  } else if (pending > 0) {
    statusLine = `${pending} change${pending === 1 ? "" : "s"} waiting to be sent.`;
    statusClass = "is-warn";
  } else {
    statusLine = `Everything is saved. Last synced ${relativeTime(syncConfig.lastSync)}.`;
    statusClass = "is-ok";
  }

  container.innerHTML = `
    <h2 class="sync-title">Google Sheet sync</h2>

    <div class="sync-result ${statusClass}">${esc(statusLine)}</div>

    <dl class="sync-facts">
      <div><dt>Cards tracked on this device</dt><dd>${rows}</dd></div>
      <div><dt>Sheet address</dt><dd class="sync-url-display">${esc(shortenUrl(syncConfig.url))}</dd></div>
    </dl>

    <div class="sync-actions">
      <button type="button" class="btn btn-primary" data-action="sync-now">Sync now</button>
      <button type="button" class="btn btn-secondary" data-action="sync-choose-sheet">Change address</button>
      <button type="button" class="btn btn-danger-outline" data-action="sync-disconnect">Disconnect</button>
    </div>

    <p class="sync-note">
      Changes save to this device straight away and are sent to your sheet a few seconds later.
      You can edit the sheet by hand at any time - press <strong>Sync now</strong> afterwards to pick the changes up.
    </p>
  `;
}

/** Apps Script addresses are far too long to display in full. */
function shortenUrl(url) {
  if (!url) return "none";
  if (url.length <= 52) return url;
  return `${url.slice(0, 34)}...${url.slice(-10)}`;
}
