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
  "Wave Foil": { key: "wave", label: "Wave Foil", short: "Wave", icon: "⚡", priceKey: "price_foil", badgeClass: "active-wave" },
  "Foil Etched": { key: "etched", label: "Foil Etched", short: "Etched", icon: "\u{1F48E}", priceKey: "price_etched", badgeClass: "active-foil" },
  "Promo": { key: "promo", label: "Promo / Prerelease", short: "Promo", icon: "\u{1F396}️", priceKey: "price_foil", badgeClass: "active-promo" },
  "Serialized": { key: "serialized", label: "Serialized", short: "Serial", icon: "\u{1F522}", priceKey: "price_foil", badgeClass: "active-serialized" }
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
  "Wave Foil": "Wave Foil (Chocobo Track)",
  "Foil Etched": "Foil Etched",
  "Promo": "Promo / Prerelease",
  "Serialized": "Serialized Print"
};

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

function money(value) {
  return typeof value === "number" && isFinite(value) ? `$${value.toFixed(2)}` : "--";
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
    updatedAt: nowMs()
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
  if (!entry.variants) entry.variants = createCardEntry().variants;
  if (!entry.serialNumbers) entry.serialNumbers = {};
  if (!entry.condition) entry.condition = DEFAULT_CONDITION;
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
  const variants = raw.variants && typeof raw.variants === "object" ? raw.variants : {};
  for (const key in base.variants) {
    base.variants[key] = Math.max(0, parseInt(variants[key], 10) || 0);
  }
  // Preserve any finish key we do not recognise rather than discarding data.
  for (const key in variants) {
    if (!(key in base.variants)) {
      base.variants[key] = Math.max(0, parseInt(variants[key], 10) || 0);
    }
  }
  base.serialNumbers = raw.serialNumbers && typeof raw.serialNumbers === "object" ? Object.assign({}, raw.serialNumbers) : {};
  base.condition = typeof raw.condition === "string" && raw.condition ? raw.condition : DEFAULT_CONDITION;
  base.location = typeof raw.location === "string" ? raw.location : "";
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
  pruneCollection();
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

function savePrefs() {
  const prefs = {
    view: currentView,
    pageSize: pageSize,
    sort: valueOf("sortBySelect"),
    search: valueOf("searchInput"),
    location: activeLocationFilter,
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
  if ([24, 60, 120].indexOf(Number(prefs.pageSize)) !== -1) pageSize = Number(prefs.pageSize);
  setValue("sortBySelect", prefs.sort);
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
  const direct = card[def.priceKey];
  if (typeof direct === "number") return direct;
  if (def.key === "nonfoil") return typeof card.price_usd === "number" ? card.price_usd : null;
  if (typeof card.price_foil === "number") return card.price_foil;
  if (typeof card.price_usd === "number") return card.price_usd;
  return null;
}

/** Union of finish keys that any card in the data can actually be printed in. */
function availableVariantKeys() {
  const seen = new Map();
  CARDS_DATA.forEach(card => {
    getCardVariantDefs(card).forEach(def => {
      if (!seen.has(def.key)) seen.set(def.key, def);
    });
  });
  return Array.from(seen.values());
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

  const treatments = distinctValues(card => card.treatment);
  fillSelect("filterTreatment", "All Frames", treatments.map(v => ({ value: v, label: v })));

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
      meta: normaliseForSearch(`${card.type_line} ${card.set} ${number} ${plainNumber}`),
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
function scoreCard(card, terms) {
  const fields = searchIndex.get(card.id);
  if (!fields) return -1;

  let weakest = MATCH_NAME;

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

  return weakest;
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
  const hasStrongMatch = filteredCards.some(card => (searchScores.get(card.id) || 0) >= MATCH_META);
  if (!hasStrongMatch) return;
  filteredCards = filteredCards.filter(card => (searchScores.get(card.id) || 0) >= MATCH_META);
}

/** Explanation shown on results that matched nothing visible on the card. */
function matchLabel(cardId) {
  if (!searchScores.size) return "";
  const score = searchScores.get(cardId);
  return score === undefined ? "" : (MATCH_LABELS[score] || "");
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
    case "chip-inc":
      event.preventDefault();
      event.stopPropagation();
      stepVariant(cardId, vkey, 1);
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
    default:
      break;
  }
}

function resetAllFilters() {
  setValue("searchInput", "");
  document.getElementById("clearSearchBtn").style.display = "none";
  FILTER_IDS.forEach(id => setValue(id, "all"));
  setValue("sortBySelect", "number_asc");
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
  searchScores.clear();

  filteredCards = CARDS_DATA.filter(card => {
    const entry = readCard(card.id);
    const owned = entryTotalQty(entry) > 0;

    if (terms.length) {
      const score = scoreCard(card, terms);
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
    if (treatmentFilter !== "all" && card.treatment !== treatmentFilter) return false;
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
        return bestPrice(b) - bestPrice(a);
      case "price_asc":
        return bestPrice(a) - bestPrice(b);
      case "rarity_desc":
        return ((RARITY_ORDER[b.rarity] || 0) - (RARITY_ORDER[a.rarity] || 0)) || compareByNumber(a, b);
      case "owned_desc":
        return ((isCardOwned(b.id) ? 1 : 0) - (isCardOwned(a.id) ? 1 : 0)) || compareByNumber(a, b);
      case "qty_desc":
        return (getCardTotalQty(b.id) - getCardTotalQty(a.id)) || compareByNumber(a, b);
      case "number_asc":
      default:
        return compareByNumber(a, b);
    }
  });
}

function bestPrice(card) {
  if (typeof card.price_usd === "number") return card.price_usd;
  if (typeof card.price_foil === "number") return card.price_foil;
  return 0;
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
function renderActiveFilters() {
  const container = document.getElementById("activeFilters");
  if (!container) return;

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
               sizes="(max-width: 520px) 116px, (max-width: 900px) 45vw, 280px"
               alt="${esc(name)}" loading="lazy" decoding="async">
          <div class="card-pill-tags">
            <span class="tag-badge tag-game">${esc(card.game)}</span>
            <span class="tag-badge tag-set">${esc(card.set)} #${esc(card.collector_number)}</span>
            <span class="tag-badge tag-rarity-${esc(card.rarity.toLowerCase())}">${esc(card.rarity)}</span>
            ${card.variant !== "Basic/Non-foil" ? `<span class="tag-badge tag-variant">${esc(card.variant)}</span>` : ""}
          </div>
        </div>

        <div class="card-info">
          <div class="card-title-row">
            <h3 class="card-name" title="${esc(name)}">${esc(name)}</h3>
            <div class="card-collector">${esc(card.color_identity)}</div>
          </div>

          ${card.is_reprint ? `<div class="card-mtg-subtitle" title="Original MTG name">aka: ${esc(displayName(card.mtg_name))}</div>` : ""}

          ${matchLabel(card.id) ? `<div class="match-why">${esc(matchLabel(card.id))}</div>` : ""}

          <div class="card-type" title="${esc(card.type_line)}">${esc(card.type_line)}</div>

          <div class="card-price-row">
            <div class="price-item">
              <span class="price-label">Normal USD</span>
              <span class="price-val">${money(card.price_usd)}</span>
            </div>
            <div class="price-item" style="text-align: right;">
              <span class="price-label">Foil USD</span>
              <span class="price-val price-foil">${money(card.price_foil)}</span>
            </div>
          </div>

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
              <span>\u{1F50D} Manage Variants &amp; Details</span>
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
        <td class="col-price">${money(card.price_usd)}</td>
        <td class="col-price-foil">${money(card.price_foil)}</td>
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
  }
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

function stepVariant(cardId, variantKey, step) {
  const entry = editCard(cardId);
  const current = entry.variants[variantKey] || 0;
  entry.variants[variantKey] = Math.max(0, current + step);
  saveCollectionState();
  refreshCardUI(cardId);
}

function tableSetVariantQty(cardId, variantKey, value) {
  const entry = editCard(cardId);
  entry.variants[variantKey] = Math.max(0, parseInt(value, 10) || 0);
  saveCollectionState();
  refreshCardUI(cardId);
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

      const pUsd = typeof card.price_usd === "number" ? card.price_usd : 0;
      const pFoil = typeof card.price_foil === "number" ? card.price_foil : pUsd;
      const pEtched = typeof card.price_etched === "number" ? card.price_etched : pFoil;

      estimatedValue += (variants.nonfoil || 0) * pUsd;
      estimatedValue += (variants.foil || 0) * pFoil;
      estimatedValue += (variants.surge || 0) * pFoil;
      estimatedValue += (variants.wave || 0) * pFoil;
      estimatedValue += (variants.etched || 0) * pEtched;
      estimatedValue += (variants.promo || 0) * pFoil;
      estimatedValue += (variants.serialized || 0) * (pFoil > 0 ? pFoil * 5 : SERIALIZED_FALLBACK_USD);
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
  setText("statMarketValue", `$${estimatedValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  setText("progressBarPercent", `${completionPct.toFixed(1)}% (${uniqueOwned.toLocaleString()} / ${totalCardsInSet.toLocaleString()})`);

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
        <td class="variant-price">${money(price)}</td>
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

      ${card.oracle_text ? `<div class="modal-oracle-box">${esc(card.oracle_text)}</div>` : ""}
      ${card.flavor_text ? `<div class="modal-flavor-box">${esc(card.flavor_text)}</div>` : ""}

      <div class="modal-meta-grid">
        <div class="modal-meta-item"><strong>Set:</strong> ${esc(card.set_name)} (${esc(card.set)})</div>
        <div class="modal-meta-item"><strong>Collector #:</strong> ${esc(card.collector_number)}</div>
        <div class="modal-meta-item"><strong>Base printing:</strong> ${esc(card.variant)}</div>
        <div class="modal-meta-item"><strong>Frame treatment:</strong> ${esc(card.treatment)}</div>
        <div class="modal-meta-item"><strong>Rarity:</strong> ${esc(card.rarity)}</div>
        <div class="modal-meta-item"><strong>Artist:</strong> ${esc(card.artist || "Unknown")}</div>
      </div>

      <div class="modal-field-grid">
        <div>
          <label class="field-label" for="modalConditionSelect">Overall condition</label>
          <select id="modalConditionSelect" class="table-select" data-change="condition" data-card-id="${esc(card.id)}">
            ${CONDITION_OPTIONS.map(opt => `<option value="${esc(opt)}" ${entry.condition === opt ? "selected" : ""}>${esc(opt)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label class="field-label" for="modalLocationInput">Storage location</label>
          <input id="modalLocationInput" type="text" class="table-input" placeholder="e.g. Binder 1, page 3"
                 value="${esc(entry.location)}" data-change="location" data-card-id="${esc(card.id)}">
        </div>
      </div>

      <div class="modal-footer-actions">
        <a href="${esc(card.scryfall_uri)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline">View on Scryfall ↗</a>
      </div>
    </div>`;

  modal.style.display = "flex";
  document.body.classList.add("modal-open");
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
const REQUIRED_SCRIPT_VERSION = 4;

const STALE_SCRIPT_MESSAGE =
  "Your sheet is running an old copy of the sync script, so recent fixes are not " +
  "active. In the Apps Script editor choose Deploy, then Manage deployments, then " +
  "the pencil icon, set Version to New version, and click Deploy. The web address " +
  "does not change.";

/** True when the sheet's deployed script is older than this tracker needs. */
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
  const changes = cardsChangedSince(settings.full ? 0 : syncConfig.lastSync);

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
      syncConfig.lastSync = startedAt;
      saveSyncConfig();

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
        // than letting fixes appear to do nothing.
        setSyncStatus("error", STALE_SCRIPT_MESSAGE);
        if (!settings.silent) showToast("Sheet script is out of date - open Sync", true);
        return true;
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
