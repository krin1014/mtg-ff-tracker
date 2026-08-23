/**
 * Final Fantasy MTG Collection Tracker — Google Sheet sync
 * ========================================================
 *
 * Paste this whole file into Apps Script inside YOUR Google Sheet, then deploy
 * it as a Web app. Full instructions are in SETUP.md, Part 3.
 *
 *   Sheet  ->  Extensions  ->  Apps Script  ->  paste  ->  Deploy
 *   Execute as:      Me
 *   Who has access:  Anyone
 *
 * The tracker website then talks to the /exec address you get back.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 * It keeps one row per card you own in a tab called "Collection". The website
 * sends changes; this script merges them in, newest change per card wins, and
 * sends the merged result back. That means two devices can never wipe each
 * other's work — they meet in the middle, card by card.
 *
 * You can edit the sheet by hand at any time. Change a number, press Enter, and
 * the website picks it up next time it syncs.
 *
 * IF YOU EDIT THIS SCRIPT
 * -----------------------
 * Changes do NOT go live until you publish a new version:
 *   Deploy -> Manage deployments -> pencil icon -> Version: New version -> Deploy
 * The web address stays the same.
 */

/** Bump only if the sheet layout changes in a way the website must know about. */
var SCHEMA_VERSION = 3;

var DATA_SHEET = 'Collection';
var META_SHEET = '_meta';

/** The finishes a card can be owned in. Must match the website. */
var VARIANT_KEYS = ['nonfoil', 'foil', 'surge', 'wave', 'etched', 'promo', 'serialized'];

/**
 * Column order used when the sheet is first created.
 *
 * You may reorder or insert columns afterwards — the script reads the header
 * row and finds columns by name, so it will keep working. Just don't rename
 * these headers.
 */
var COLUMNS = [
  'card_id',        // Scryfall ID. This is the key. Don't edit it.
  'ff_name',        // For your eyes only — the script rewrites it on sync
  'set',            // Same
  'number',         // Same
  'nonfoil',
  'foil',
  'surge',
  'wave',
  'etched',
  'promo',
  'serialized',
  'serial_number',
  'condition',
  'location',
  'updated_at'      // Milliseconds. Used to decide which change is newer.
];

var DEFAULT_CONDITION = 'Near Mint (NM)';

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

/**
 * Handles GET requests: ?action=ping and ?action=pull
 * Used for the "Test connection" button and for reading the collection.
 */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'pull';
  try {
    if (action === 'ping') return respond(ping());
    if (action === 'pull') return respond(pull());
    return respond({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return respond({ ok: false, error: describeError(err) });
  }
}

/**
 * Handles POST requests. The website sends JSON with a text/plain content type
 * on purpose: that keeps it a "simple" cross-origin request, which Apps Script
 * can answer. Sending it as application/json would trigger a preflight check
 * that Apps Script does not support, and every save would fail.
 */
function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var action = body.action || 'push';

    if (action === 'ping') return respond(ping());
    if (action === 'pull') return respond(pull());
    if (action === 'push') return respond(push(body));
    return respond({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return respond({ ok: false, error: describeError(err) });
  }
}

function respond(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function describeError(err) {
  if (!err) return 'Unknown error';
  return err.message ? String(err.message) : String(err);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function ping() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheets(spreadsheet);
  return {
    ok: true,
    action: 'ping',
    schema: SCHEMA_VERSION,
    sheetName: spreadsheet.getName(),
    sheetUrl: spreadsheet.getUrl(),
    cardCount: countRows(spreadsheet)
  };
}

function pull() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheets(spreadsheet);
  var state = readCards(spreadsheet);
  return {
    ok: true,
    action: 'pull',
    schema: SCHEMA_VERSION,
    cards: state.cards,
    updatedAt: state.updatedAt,
    cardCount: countKeys(state.cards)
  };
}

/**
 * Merge the incoming cards into the sheet and return the merged result.
 *
 * Merging happens here rather than on the website so that two devices saving at
 * the same moment cannot overwrite one another: each one's changes are folded
 * into whatever is already in the sheet.
 */
function push(body) {
  var incoming = body.cards || {};

  // The website tells us how up to date it already is. We send back only what
  // changed after that, instead of the whole collection on every save - which
  // matters a lot on a phone using mobile data. A "since" of 0 means "send me
  // everything", which is what a first connection and the Sync now button do.
  var since = toTimestamp(body.since);

  // One writer at a time. Without this, two phones saving together could
  // interleave their read-modify-write and lose a change.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return { ok: false, error: 'The sheet was busy. Try again in a moment.' };
  }

  try {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    ensureSheets(spreadsheet);

    var existing = readCards(spreadsheet).cards;
    var merged = {};
    var id;

    for (id in existing) {
      if (existing.hasOwnProperty(id)) merged[id] = existing[id];
    }

    var applied = 0;
    var skipped = 0;

    for (id in incoming) {
      if (!incoming.hasOwnProperty(id)) continue;
      var candidate = normaliseEntry(incoming[id]);
      if (!candidate) continue;

      var current = merged[id];
      // Newest change wins. Ties go to the incoming change so that a device
      // re-sending its own state is never rejected.
      if (!current || candidate.updatedAt >= current.updatedAt) {
        merged[id] = candidate;
        applied++;
      } else {
        skipped++;
      }
    }

    writeCards(spreadsheet, merged);
    writeMeta(spreadsheet, body.deviceId || 'unknown', countKeys(merged));

    var reply = {};
    for (id in merged) {
      if (!merged.hasOwnProperty(id)) continue;
      if (since <= 0 || merged[id].updatedAt > since) reply[id] = merged[id];
    }

    return {
      ok: true,
      action: 'push',
      schema: SCHEMA_VERSION,
      cards: reply,
      partial: since > 0,
      cardCount: countKeys(merged),
      returned: countKeys(reply),
      applied: applied,
      skipped: skipped,
      updatedAt: new Date().getTime()
    };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Sheet reading and writing
// ---------------------------------------------------------------------------

/** Create the Collection and _meta tabs if they are not there yet. */
function ensureSheets(spreadsheet) {
  var data = spreadsheet.getSheetByName(DATA_SHEET);

  if (!data) {
    // A brand-new spreadsheet has one empty sheet called "Sheet1". Rename it
    // rather than leaving an unused tab lying around.
    var sheets = spreadsheet.getSheets();
    if (sheets.length === 1 && sheets[0].getLastRow() === 0 && sheets[0].getLastColumn() === 0) {
      data = sheets[0].setName(DATA_SHEET);
    } else {
      data = spreadsheet.insertSheet(DATA_SHEET);
    }
  }

  if (data.getLastRow() === 0) {
    data.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
    data.getRange(1, 1, 1, COLUMNS.length)
      .setFontWeight('bold')
      .setBackground('#1E293B')
      .setFontColor('#FFFFFF');
    data.setFrozenRows(1);
    data.setColumnWidth(1, 280); // card_id
    data.setColumnWidth(2, 220); // ff_name
    if (data.getMaxColumns() > COLUMNS.length) {
      data.deleteColumns(COLUMNS.length + 1, data.getMaxColumns() - COLUMNS.length);
    }
  }

  var meta = spreadsheet.getSheetByName(META_SHEET);
  if (!meta) {
    meta = spreadsheet.insertSheet(META_SHEET);
    meta.getRange(1, 1, 1, 2).setValues([['key', 'value']])
      .setFontWeight('bold')
      .setBackground('#1E293B')
      .setFontColor('#FFFFFF');
    meta.setFrozenRows(1);
    meta.setColumnWidth(1, 160);
    meta.setColumnWidth(2, 320);
    meta.hideSheet();
  }

  return data;
}

/**
 * Map header name -> column index (0 based), so the script keeps working if you
 * reorder or insert columns in the sheet.
 */
function headerIndex(sheet) {
  var lastColumn = Math.max(1, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  var index = {};
  for (var i = 0; i < headers.length; i++) {
    var name = String(headers[i] || '').trim().toLowerCase();
    if (name) index[name] = i;
  }
  return index;
}

function readCards(spreadsheet) {
  var sheet = ensureSheets(spreadsheet);
  var lastRow = sheet.getLastRow();
  var cards = {};
  var newest = 0;

  if (lastRow < 2) return { cards: cards, updatedAt: newest };

  var index = headerIndex(sheet);
  if (index['card_id'] === undefined) {
    throw new Error('The Collection tab has no "card_id" column. Restore it, or delete the tab and sync again to rebuild it.');
  }

  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var id = String(row[index['card_id']] || '').trim();
    if (!id) continue;

    var entry = {
      variants: {},
      serialNumbers: {},
      condition: DEFAULT_CONDITION,
      location: '',
      updatedAt: 0
    };

    for (var v = 0; v < VARIANT_KEYS.length; v++) {
      var key = VARIANT_KEYS[v];
      entry.variants[key] = toCount(index[key] === undefined ? 0 : row[index[key]]);
    }

    var serial = index['serial_number'] === undefined ? '' : String(row[index['serial_number']] || '').trim();
    if (serial) entry.serialNumbers.serialized = serial;

    var condition = index['condition'] === undefined ? '' : String(row[index['condition']] || '').trim();
    entry.condition = condition || DEFAULT_CONDITION;

    entry.location = index['location'] === undefined ? '' : String(row[index['location']] || '').trim();
    entry.updatedAt = toTimestamp(index['updated_at'] === undefined ? 0 : row[index['updated_at']]);

    if (entry.updatedAt > newest) newest = entry.updatedAt;
    cards[id] = entry;
  }

  return { cards: cards, updatedAt: newest };
}

function writeCards(spreadsheet, cards) {
  var sheet = ensureSheets(spreadsheet);
  var index = headerIndex(sheet);
  var width = Math.max(sheet.getLastColumn(), COLUMNS.length);

  var ids = Object.keys(cards);
  ids.sort(function (a, b) {
    var ca = cards[a], cb = cards[b];
    var sa = String(ca.set || ''), sb = String(cb.set || '');
    if (sa !== sb) return sa < sb ? -1 : 1;
    var na = parseInt(String(ca.number || '').replace(/\D/g, ''), 10) || 0;
    var nb = parseInt(String(cb.number || '').replace(/\D/g, ''), 10) || 0;
    if (na !== nb) return na - nb;
    return a < b ? -1 : (a > b ? 1 : 0);
  });

  var rows = [];
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var card = cards[id];
    var row = new Array(width);
    for (var c = 0; c < width; c++) row[c] = '';

    put(row, index, 'card_id', id);
    put(row, index, 'ff_name', card.ff_name || '');
    put(row, index, 'set', card.set || '');
    put(row, index, 'number', card.number || '');
    for (var v = 0; v < VARIANT_KEYS.length; v++) {
      put(row, index, VARIANT_KEYS[v], card.variants[VARIANT_KEYS[v]] || 0);
    }
    put(row, index, 'serial_number', card.serialNumbers.serialized || '');
    put(row, index, 'condition', card.condition || DEFAULT_CONDITION);
    put(row, index, 'location', card.location || '');
    put(row, index, 'updated_at', card.updatedAt || 0);

    rows.push(row);
  }

  // Clear the old body, then write the new one in a single call. Rewriting the
  // whole block keeps the sheet sorted and avoids leaving stale rows behind.
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, width).clearContent();
  }
  if (rows.length) {
    if (sheet.getMaxRows() < rows.length + 1) {
      sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
    }
    sheet.getRange(2, 1, rows.length, width).setValues(rows);
  }
}

function put(row, index, column, value) {
  var at = index[column];
  if (at !== undefined) row[at] = value;
}

function writeMeta(spreadsheet, deviceId, cardCount) {
  var meta = spreadsheet.getSheetByName(META_SHEET);
  if (!meta) return;
  var values = [
    ['key', 'value'],
    ['schema', SCHEMA_VERSION],
    ['last_sync', new Date().toISOString()],
    ['last_device', deviceId],
    ['card_rows', cardCount],
    ['note', 'Written by the Final Fantasy MTG Collection Tracker. Safe to hide.']
  ];
  meta.getRange(1, 1, values.length, 2).setValues(values);
}

function countRows(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(DATA_SHEET);
  if (!sheet) return 0;
  return Math.max(0, sheet.getLastRow() - 1);
}

function countKeys(object) {
  return Object.keys(object || {}).length;
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

/** Accept anything the sheet might hold and turn it into a whole number >= 0. */
function toCount(value) {
  if (value === '' || value === null || value === undefined) return 0;
  var number = parseInt(value, 10);
  if (isNaN(number) || number < 0) return 0;
  return number;
}

/** updated_at may arrive as a number, a string, or a real Date if reformatted. */
function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (value === '' || value === null || value === undefined) return 0;
  var number = Number(value);
  return isNaN(number) || number < 0 ? 0 : number;
}

function normaliseEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;

  var entry = {
    variants: {},
    serialNumbers: {},
    condition: DEFAULT_CONDITION,
    location: '',
    updatedAt: 0,
    ff_name: '',
    set: '',
    number: ''
  };

  var variants = raw.variants || {};
  for (var i = 0; i < VARIANT_KEYS.length; i++) {
    entry.variants[VARIANT_KEYS[i]] = toCount(variants[VARIANT_KEYS[i]]);
  }

  var serials = raw.serialNumbers || {};
  if (serials.serialized) entry.serialNumbers.serialized = String(serials.serialized);

  entry.condition = raw.condition ? String(raw.condition) : DEFAULT_CONDITION;
  entry.location = raw.location ? String(raw.location) : '';
  entry.updatedAt = toTimestamp(raw.updatedAt);

  // Display-only columns, sent by the website so the sheet is readable by a
  // human. They are never read back into the collection.
  entry.ff_name = raw.ff_name ? String(raw.ff_name) : '';
  entry.set = raw.set ? String(raw.set) : '';
  entry.number = raw.number ? String(raw.number) : '';

  return entry;
}

// ---------------------------------------------------------------------------
// Run this from the editor to check everything works, before deploying.
// Select "testSetup" in the function dropdown and click Run.
// ---------------------------------------------------------------------------

function testSetup() {
  var result = ping();
  Logger.log('Sheet: %s', result.sheetName);
  Logger.log('Rows in Collection tab: %s', result.cardCount);
  Logger.log('Schema: %s', result.schema);
  Logger.log('OK — the tabs exist and the script can read your sheet.');
  return result;
}
