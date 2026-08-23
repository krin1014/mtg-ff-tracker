/**
 * Google Apps Script: Magic: The Gathering - Final Fantasy Collection Tracker
 * 
 * Instructions:
 * 1. Open Google Sheets (https://sheets.new)
 * 2. Click Extensions > Apps Script
 * 3. Delete any code in the editor, paste this entire script, and click Save (disk icon).
 * 4. Select the function 'buildFFTracker' from the dropdown and click 'Run'.
 *    (Authorize permissions when prompted).
 * 5. Return to your Google Sheet to watch the tracker generate with live images,
 *    dropdowns, conditional formatting, and dashboard analytics!
 */

const SCRYFALL_API_BASE = 'https://api.scryfall.com/cards/search?q=(game:paper)+(set:fin+OR+set:fic+OR+set:fca+OR+set:afic+OR+set:afin+OR+set:rfin+OR+set:pfin+OR+set:tfin+OR+set:tfic)+include:extras+unique:prints&prefer=best';

const MAIN_COLUMNS = [
  "Card Name",
  "Card Image",
  "Card Set",
  "Card Number",
  "Print Variant",
  "Treatment / Frame",
  "Game Number",
  "Rarity",
  "Type Line",
  "Color Identity",
  "Owned",
  "Quantity Owned",
  "Condition",
  "Price (USD)",
  "Price (Foil)",
  "Storage Location"
];

const VALIDATION_DATA = {
  "Card Set": ["FIN", "FIC", "FCA", "AFIC", "AFIN", "RFIN", "PFIN", "TFIN", "TFIC"],
  "Print Variant": ["Basic/Non-foil", "Traditional Foil", "Surge Foil", "Wave Foil", "Foil Etched", "Promo", "Serialized"],
  "Treatment / Frame": ["Standard", "Borderless", "Extended Art", "Showcase", "Art Card", "Retro Frame"],
  "Game Number": ["FF1", "FF2", "FF3", "FF4", "FF5", "FF6", "FF7", "FF8", "FF9", "FF10", "FF11", "FF12", "FF13", "FF14", "FF15", "FF16", "Tactics", "Spin-Off / Multi-Game", "Unknown"],
  "Owned": ["Yes", "No"],
  "Condition": ["Near Mint (NM)", "Lightly Played (LP)", "Moderately Played (MP)", "Heavily Played (HP)", "Damaged (DMG)"]
};

const ROMAN_MAP = {
  'ffi': 'FF1', 'ffii': 'FF2', 'ffiii': 'FF3', 'ffiv': 'FF4',
  'ffv': 'FF5', 'ffvi': 'FF6', 'ffvii': 'FF7', 'ffviii': 'FF8',
  'ffix': 'FF9', 'ffx': 'FF10', 'ffxi': 'FF11', 'ffxii': 'FF12',
  'ffxiii': 'FF13', 'ffxiv': 'FF14', 'ffxv': 'FF15', 'ffxvi': 'FF16',
  'fft': 'Tactics', 'fftactics': 'Tactics'
};

const LORE_KEYWORDS = {
  "Tactics": ["ramza", "delita", "ivalice", "agrias", "tg cid", "orlandeau", "orbonne", "lucavi", "zodiac brave"],
  "FF1": ["garland", "chaos", "warrior of light", "princess sarah", "matoya", "bikke", "astos", "lukahn", "pravoka", "onrac", "lufenia", "cornelia"],
  "FF2": ["firion", "maria", "guy", "leon", "minwu", "gordon", "josef", "leila", "ricard", "emperor mateus", "hilda", "dreadnought", "paramekia", "pandemonium", "wild rose"],
  "FF3": ["luneth", "arc", "refia", "ingus", "cloud of darkness", "xande", "doga", "unei", "desch", "aria", "hein", "crystal tower", "floating continent"],
  "FF4": ["cecil", "kain", "rosa", "rydia", "edge", "golbez", "zeromus", "yang", "palom", "porom", "edward", "tellah", "fusoya", "cid pollan", "rubicante", "cagnazzo", "barbariccia", "scarmiglione", "lunar whale", "baron"],
  "FF5": ["bartz", "lenna", "galuf", "faris", "krile", "exdeath", "gilgamesh", "enuo", "shinryu", "omega", "ghido", "tycoon", "void", "syldra"],
  "FF6": ["terra", "locke", "celes", "edgar", "sabin", "shadow", "cyan", "gau", "setzer", "strago", "relm", "mog", "umaro", "gogo", "kefka", "gestahl", "general leo", "opera house", "narshe", "figaro", "vector", "esper"],
  "FF7": ["cloud", "tifa", "aerith", "barret", "sephiroth", "red xiii", "yuffie", "vincent", "cait sith", "cid highwind", "zack", "midgar", "shinra", "jenova", "materia", "chocobo", "buster sword", "gold saucer", "sector 7", "nibelheim", "hojo", "rufus", "avalanche"],
  "FF8": ["squall", "rinoa", "seifer", "zell", "irvine", "quistis", "selphie", "laguna", "kiros", "ward", "edea", "ultimecia", "balamb", "seed", "galbadia", "esthar", "sorceress", "gunblade", "lionheart", "ragnarok", "triple triad"],
  "FF9": ["zidane", "garnet", "dagger", "vivi", "steiner", "freya", "quina", "eiko", "amarant", "kuja", "brahne", "beatrix", "alexandria", "lindblum", "burmecia", "mist continent", "prima vista", "trance", "eidolons"],
  "FF10": ["tidus", "yuna", "auron", "wakka", "lulu", "kimahri", "rikku", "seymour", "sin", "jecht", "spira", "zanarkand", "besaid", "kilika", "luca", "blitzball", "bevelle", "aeon", "calm lands", "macalania", "gagazet", "yu yevon"],
  "FF11": ["shantotto", "ayame", "curilla", "zeid", "prishe", "aphmau", "lilisette", "arciela", "shadow lord", "vana'diel", "san d'oria", "bastok", "windurst", "jeuno", "aht urhgan", "absolute virtue", "tarutaru", "elvaan", "mithra", "galka", "hume"],
  "FF12": ["vaan", "penelo", "balthier", "fran", "basch", "ashe", "vayne", "gabranth", "cidolfus", "dalmasca", "rabanastre", "archadia", "strahl", "yiazmat", "occuria", "nethicite", "judge magister", "skypirate"],
  "FF13": ["lightning", "snow", "vanille", "fang", "hope", "sazh", "serah", "noel", "caius", "barthandelus", "bhunivelze", "cocoon", "pulse", "fal'cie", "l'cie", "eidolons", "bodhum", "eden"],
  "FF14": ["alphinaud", "alisaie", "yshtola", "y'shtola", "thancred", "urianger", "estinien", "graha", "g'raha", "scions", "hydaelyn", "zodiark", "emet-selch", "elidibus", "lahabrea", "zenos", "hades", "eorzea", "scion", "warrior of light", "venat", "meteion", "limsa", "gridania", "uldah", "ishgard", "kugane", "scion of the seventh dawn", "a realm reborn"],
  "FF15": ["noctis", "gladiolus", "ignis", "prompto", "lunafreya", "ardyn", "cor", "regalia", "lucis", "insomnia", "niflheim", "astral", "armiger", "cindy", "chocobo post", "king of lucis", "ring of the lucii"],
  "FF16": ["clive", "joshua", "jill", "dion", "barnabas", "benedikta", "hugo", "cidolfus", "torgal", "ifrit", "phoenix", "garuda", "titan", "ramuh", "bahamut", "odin", "ultima", "valisthea", "rosaria", "sanbreque", "dhalmekia", "walood", "dominant", "eikon", "bearer", "mothercrystal"]
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MTG Final Fantasy')
    .addItem('Build / Refresh Collection Tracker', 'buildFFTracker')
    .addToUi();
}

function buildFFTracker() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Fetch data from Scryfall API
  const rawCards = fetchAllScryfallCards();
  if (!rawCards || rawCards.length === 0) {
    SpreadsheetApp.getUi().alert('Failed to retrieve card data from Scryfall API.');
    return;
  }
  
  // 2. Setup Lookup dictionary for Games
  const nameToGame = {};
  rawCards.forEach(c => {
    const pts = c.promo_types || [];
    pts.forEach(p => {
      const pl = p.toLowerCase();
      if (ROMAN_MAP[pl]) {
        const g = ROMAN_MAP[pl];
        const name = (c.name || '').trim();
        nameToGame[name] = g;
        if (name.includes(' // ')) {
          name.split(' // ').forEach(part => nameToGame[part.trim()] = g);
        }
      }
    });
  });
  
  // 3. Process Sheet Tabs
  let mainSheet = ss.getSheetByName('FF MTG Collection');
  if (!mainSheet) mainSheet = ss.insertSheet('FF MTG Collection');
  else mainSheet.clear();
  
  let dashSheet = ss.getSheetByName('Collection Dashboard');
  if (!dashSheet) dashSheet = ss.insertSheet('Collection Dashboard');
  else dashSheet.clear();
  
  let valSheet = ss.getSheetByName('_Validation');
  if (!valSheet) valSheet = ss.insertSheet('_Validation');
  else valSheet.clear();
  valSheet.hideSheet();

  // Populate Validation Sheet
  const valKeys = Object.keys(VALIDATION_DATA);
  valKeys.forEach((key, colIdx) => {
    valSheet.getRange(1, colIdx + 1).setValue(key);
    const opts = VALIDATION_DATA[key];
    const rangeData = opts.map(o => [o]);
    valSheet.getRange(2, colIdx + 1, rangeData.length, 1).setValues(rangeData);
  });

  // 4. Build Main Tracker Data
  const rows = [];
  rows.push(MAIN_COLUMNS); // Header row

  for (let i = 0; i < rawCards.length; i++) {
    const card = rawCards[i];
    
    // Card Name
    const name = card.name || "Unknown";
    
    // Image URL
    let imgUrl = "";
    if (card.image_uris && (card.image_uris.normal || card.image_uris.small)) {
      imgUrl = card.image_uris.normal || card.image_uris.small;
    } else if (card.card_faces && card.card_faces.length > 0 && card.card_faces[0].image_uris) {
      imgUrl = card.card_faces[0].image_uris.normal || card.card_faces[0].image_uris.small || "";
    }
    const imgFormula = imgUrl ? `=IMAGE("${imgUrl}", 1)` : "";
    
    // Set & Collector Number
    const setCode = (card.set || "").toUpperCase();
    let colNum = String(card.collector_number || "");
    if (/^\d+$/.test(colNum)) {
      colNum = colNum.padStart(4, "0");
    }
    
    // Variant, Treatment, Game
    const variant = getPrintVariant(card);
    const treatment = getTreatment(card);
    const game = getFFGame(card, nameToGame);
    
    // Rarity & Types
    const rarity = (card.rarity || "Unknown").charAt(0).toUpperCase() + (card.rarity || "Unknown").slice(1);
    const typeLine = card.type_line || "";
    const colorId = (card.color_identity && card.color_identity.length > 0) ? card.color_identity.join("") : "Colorless";
    
    // Prices
    const prices = card.prices || {};
    const priceUsd = prices.usd ? parseFloat(prices.usd) : "";
    const priceFoil = prices.usd_foil ? parseFloat(prices.usd_foil) : "";
    
    rows.push([
      name,
      imgFormula,
      setCode,
      colNum,
      variant,
      treatment,
      game,
      rarity,
      typeLine,
      colorId,
      "No", // Owned
      0,    // Quantity Owned
      "Near Mint (NM)", // Condition
      priceUsd,
      priceFoil,
      ""    // Storage Location
    ]);
  }
  
  // Write rows to Main Sheet
  const totalRows = rows.length;
  const totalCols = MAIN_COLUMNS.length;
  mainSheet.getRange(1, 1, totalRows, totalCols).setValues(rows);
  
  // Format Main Sheet Header
  const headerRange = mainSheet.getRange(1, 1, 1, totalCols);
  headerRange.setBackground("#1E293B")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  mainSheet.setRowHeight(1, 35);
  mainSheet.setFrozenRows(1);

  // Set Row Heights for Card Image display (~80px)
  mainSheet.setRowHeights(2, totalRows - 1, 80);

  // Set Column Widths & Alignments
  const colWidths = [220, 90, 80, 90, 140, 140, 120, 90, 240, 110, 80, 120, 160, 100, 100, 160];
  for (let c = 0; c < colWidths.length; c++) {
    mainSheet.setColumnWidth(c + 1, colWidths[c]);
  }
  
  // Alignments & Number Formats
  mainSheet.getRange(2, 1, totalRows - 1, 1).setFontWeight("bold").setVerticalAlignment("middle");
  mainSheet.getRange(2, 2, totalRows - 1, 1).setHorizontalAlignment("center").setVerticalAlignment("middle");
  mainSheet.getRange(2, 3, totalRows - 1, 6).setHorizontalAlignment("center").setVerticalAlignment("middle");
  mainSheet.getRange(2, 9, totalRows - 1, 1).setHorizontalAlignment("left").setVerticalAlignment("middle");
  mainSheet.getRange(2, 10, totalRows - 1, 4).setHorizontalAlignment("center").setVerticalAlignment("middle");
  mainSheet.getRange(2, 12, totalRows - 1, 1).setNumberFormat("#,##0");
  mainSheet.getRange(2, 14, totalRows - 1, 2).setNumberFormat("$#,##0.00").setHorizontalAlignment("right").setVerticalAlignment("middle");
  mainSheet.getRange(2, 16, totalRows - 1, 1).setHorizontalAlignment("left").setVerticalAlignment("middle");

  // Apply Data Validation Dropdowns (with in-cell dropdown arrows enabled)
  applyDataValidation(mainSheet, totalRows);
  
  // Apply Conditional Formatting for Owned status
  applyConditionalFormatting(mainSheet, totalRows, totalCols);
  
  // Create AutoFilter on Header Row
  if (mainSheet.getFilter()) {
    mainSheet.getFilter().remove();
  }
  mainSheet.getRange(1, 1, totalRows, totalCols).createFilter();
  
  // 5. Build Dashboard Tab
  buildDashboard(dashSheet, totalRows);
  
  SpreadsheetApp.getUi().alert(`Final Fantasy MTG Tracker generated successfully! Total cards: ${totalRows - 1}`);
}

function fetchAllScryfallCards() {
  let cards = [];
  let url = SCRYFALL_API_BASE;
  let page = 1;
  
  while (url) {
    try {
      const response = UrlFetchApp.fetch(url, {
        headers: {
          'User-Agent': 'GoogleSheets-MTG-Tracker/1.0',
          'Accept': 'application/json'
        },
        muteHttpExceptions: true
      });
      
      if (response.getResponseCode() !== 200) {
        Logger.log('Scryfall API Error: ' + response.getContentText());
        break;
      }
      
      const data = JSON.parse(response.getContentText());
      if (data.data) {
        cards = cards.concat(data.data);
      }
      
      url = data.has_more ? data.next_page : null;
      page++;
      
      if (url) {
        Utilities.sleep(100); // 100ms API rate limit delay
      }
    } catch (e) {
      Logger.log('Fetch error: ' + e);
      break;
    }
  }
  return cards;
}

function getFFGame(card, nameLookup) {
  const pts = card.promo_types || [];
  for (let p of pts) {
    if (ROMAN_MAP[p.toLowerCase()]) return ROMAN_MAP[p.toLowerCase()];
  }
  const name = (card.name || '').trim();
  if (nameLookup[name]) return nameLookup[name];
  if (name.includes(' // ')) {
    for (let part of name.split(' // ')) {
      if (nameLookup[part.trim()]) return nameLookup[part.trim()];
    }
  }
  const corpus = [name, card.flavor_text || "", card.oracle_text || "", card.type_line || ""].join(" ").toLowerCase();
  for (let [game, kws] of Object.entries(LORE_KEYWORDS)) {
    for (let kw of kws) {
      if (new RegExp('\\b' + kw + '\\b').test(corpus)) return game;
    }
  }
  if (card.layout === 'token' || card.layout === 'double_faced_token' || (card.type_line && card.type_line.toLowerCase().includes('token'))) {
    return 'Spin-Off / Multi-Game';
  }
  return 'Unknown';
}

function getPrintVariant(card) {
  const pts = card.promo_types || [];
  const finishes = card.finishes || [];
  const set = (card.set || '').toLowerCase();
  if (pts.includes('serialized')) return 'Serialized';
  if (pts.includes('surgefoil')) return 'Surge Foil';
  if (pts.includes('chocobotrackfoil') || pts.includes('wavefoil')) return 'Wave Foil';
  if (finishes.includes('etched') || pts.includes('foiletched')) return 'Foil Etched';
  if (set === 'pfin' || set === 'rfin' || pts.some(p => ['prerelease', 'buyabox', 'bundle', 'datestamped', 'starterdeck'].includes(p))) return 'Promo';
  if (finishes.length === 1 && finishes[0] === 'foil') return 'Traditional Foil';
  return 'Basic/Non-foil';
}

function getTreatment(card) {
  const set = (card.set || '').toLowerCase();
  const border = card.border_color || '';
  const frame = card.frame || '';
  const frameEffects = card.frame_effects || [];
  const promoTypes = card.promo_types || [];
  if (card.layout === 'art_series' || set === 'afin' || set === 'afic') return 'Art Card';
  if (frameEffects.includes('retro') || frame === '1993' || frame === '1997') return 'Retro Frame';
  if (border === 'borderless' || promoTypes.includes('borderless')) return 'Borderless';
  if (frameEffects.includes('extendedart')) return 'Extended Art';
  if (promoTypes.includes('showcase') || frameEffects.includes('showcase') || promoTypes.includes('boosterfun')) return 'Showcase';
  return 'Standard';
}

function applyDataValidation(sheet, totalRows) {
  const valKeys = Object.keys(VALIDATION_DATA);
  valKeys.forEach((key, idx) => {
    const colIdx = MAIN_COLUMNS.indexOf(key) + 1;
    if (colIdx > 0) {
      const opts = VALIDATION_DATA[key];
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(opts, true)
        .setAllowInvalid(true)
        .build();
      sheet.getRange(2, colIdx, totalRows - 1, 1).setDataValidation(rule);
    }
  });
}

function applyConditionalFormatting(sheet, totalRows, totalCols) {
  const ownedColLetter = "K"; // Column K is Owned
  const range = sheet.getRange(2, 1, totalRows - 1, totalCols);
  
  const ruleYes = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=$${ownedColLetter}2="Yes"`)
    .setBackground("#E2EFDA")
    .setRanges([range])
    .build();

  const ruleNo = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=$${ownedColLetter}2="No"`)
    .setBackground("#FCE4D6")
    .setRanges([range])
    .build();

  sheet.setConditionalFormatRules([ruleYes, ruleNo]);
}

function buildDashboard(sheet, totalRows) {
  sheet.getRange("A1:E1").merge()
    .setValue("FINAL FANTASY MTG COLLECTION DASHBOARD")
    .setBackground("#0F172A")
    .setFontColor("#FFFFFF")
    .setFontSize(14)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sheet.setRowHeight(1, 40);

  sheet.getRange("A2:E2").merge()
    .setValue("Live Collection Statistics & Set Completion Tracking")
    .setBackground("#1E293B")
    .setFontColor("#94A3B8")
    .setFontSize(10)
    .setFontStyle("italic")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sheet.setRowHeight(2, 22);

  const kpis = [
    ["Total Cards in Set", `=COUNTA('FF MTG Collection'!A2:A${totalRows})`, "#,##0", "Total unique prints indexed from Scryfall"],
    ["Unique Cards Owned", `=COUNTIF('FF MTG Collection'!K2:K${totalRows}, "Yes")`, "#,##0", "Unique card variants in your collection"],
    ["Total Cards Quantity", `=SUM('FF MTG Collection'!L2:L${totalRows})`, "#,##0", "Total count of all physical card copies"],
    ["Completion Rate (%)", "=B5/B4", "0.0%", "Overall unique set completion percentage"],
    ["Estimated Market Value", `=SUMPRODUCT('FF MTG Collection'!L2:L${totalRows}, 'FF MTG Collection'!N2:N${totalRows})`, "$#,##0.00", "Total estimated market value of owned cards"]
  ];

  for (let i = 0; i < kpis.length; i++) {
    const row = i + 4;
    sheet.setRowHeight(row, 26);
    
    sheet.getRange(row, 1).setValue(kpis[i][0])
      .setBackground("#F1F5F9").setFontWeight("bold").setFontColor("#1E293B")
      .setVerticalAlignment("middle");
      
    sheet.getRange(row, 2).setFormula(kpis[i][1])
      .setNumberFormat(kpis[i][2]).setFontWeight("bold").setFontColor("#0F172A")
      .setHorizontalAlignment("right").setVerticalAlignment("middle");
      
    sheet.getRange(row, 3, 1, 3).merge().setValue(kpis[i][3])
      .setFontColor("#64748B").setFontStyle("italic").setFontSize(9)
      .setBackground("#FAFAFA").setVerticalAlignment("middle");
  }

  // Breakdown Table Header
  sheet.getRange("A11:E11").merge()
    .setValue("COLLECTION PROGRESS BY FINAL FANTASY GAME")
    .setBackground("#1E293B").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.setRowHeight(11, 28);

  const tableHeaders = ["FF Game", "Total Cards", "Cards Owned", "Total Copies", "% Completed"];
  sheet.getRange(12, 1, 1, 5).setValues([tableHeaders])
    .setBackground("#334155").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.setRowHeight(12, 24);

  const games = VALIDATION_DATA["Game Number"];
  const startRow = 13;

  for (let i = 0; i < games.length; i++) {
    const r = startRow + i;
    sheet.setRowHeight(r, 22);
    const g = games[i];
    
    sheet.getRange(r, 1).setValue(g).setFontWeight("bold").setFontColor("#1E293B").setVerticalAlignment("middle");
    sheet.getRange(r, 2).setFormula(`=COUNTIF('FF MTG Collection'!$G$2:$G$${totalRows}, A${r})`).setNumberFormat("#,##0").setHorizontalAlignment("right").setVerticalAlignment("middle");
    sheet.getRange(r, 3).setFormula(`=COUNTIFS('FF MTG Collection'!$G$2:$G$${totalRows}, A${r}, 'FF MTG Collection'!$K$2:$K$${totalRows}, "Yes")`).setNumberFormat("#,##0").setHorizontalAlignment("right").setVerticalAlignment("middle");
    sheet.getRange(r, 4).setFormula(`=SUMIFS('FF MTG Collection'!$L$2:$L$${totalRows}, 'FF MTG Collection'!$G$2:$G$${totalRows}, A${r})`).setNumberFormat("#,##0").setHorizontalAlignment("right").setVerticalAlignment("middle");
    sheet.getRange(r, 5).setFormula(`=IF(B${r}>0, C${r}/B${r}, 0)`).setNumberFormat("0.0%").setFontWeight("bold").setFontColor("#2563EB").setHorizontalAlignment("right").setVerticalAlignment("middle");
  }

  // Summary Row
  const summaryRow = startRow + games.length;
  sheet.setRowHeight(summaryRow, 26);
  sheet.getRange(summaryRow, 1).setValue("Total / Overall").setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#1E293B").setVerticalAlignment("middle");
  sheet.getRange(summaryRow, 2).setFormula(`=SUM(B${startRow}:B${summaryRow - 1})`).setNumberFormat("#,##0").setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#1E293B").setHorizontalAlignment("right").setVerticalAlignment("middle");
  sheet.getRange(summaryRow, 3).setFormula(`=SUM(C${startRow}:C${summaryRow - 1})`).setNumberFormat("#,##0").setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#1E293B").setHorizontalAlignment("right").setVerticalAlignment("middle");
  sheet.getRange(summaryRow, 4).setFormula(`=SUM(D${startRow}:D${summaryRow - 1})`).setNumberFormat("#,##0").setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#1E293B").setHorizontalAlignment("right").setVerticalAlignment("middle");
  sheet.getRange(summaryRow, 5).setFormula(`=IF(B${summaryRow}>0, C${summaryRow}/B${summaryRow}, 0)`).setNumberFormat("0.0%").setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#1E293B").setHorizontalAlignment("right").setVerticalAlignment("middle");

  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 130);
  sheet.setColumnWidth(3, 130);
  sheet.setColumnWidth(4, 130);
  sheet.setColumnWidth(5, 130);
}
