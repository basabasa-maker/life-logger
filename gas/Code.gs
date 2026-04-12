/**
 * 暮らしの記録 - Google Apps Script 同期API
 * GitHub Pages のアプリからデータを受け取り、Google Sheets に保存する
 *
 * ※このファイルはGitHub上の記録用。実際のGASはclasp管理のスタンドアロンプロジェクト。
 * clasp project: /tmp/claude/life-logger-gas/.clasp.json
 * script ID: 1P24erqoDPsLlTNArsF8qajNiPtv-Ze5zFdpGX_cJ_tP6BOVTEdWejB7w
 */

const SPREADSHEET_ID = "1Z3KD6O3Uv47bTQ8bj-TM1KHxACrwWqGyvBzhkgUURT8";
const SHEET_NAME = "暮らしの記録 - LifeLog";
const ROUTINES = ["meditation","taskCheck","emailCheck","calendarCheck","stretch","supplement","housework","wifeContribution"];
const BASE_HEADERS = ["date","sleepStart","sleepEnd","sleepHours","nap","lastMeal","water","weight","bodyFat","calories","steps","tabelogFollowers","tabelogReactions","instaFollowers"];
const ROUTINE_HEADERS = ROUTINES.map(r => "routine_" + r);
const ALL_HEADERS = [...BASE_HEADERS, ...ROUTINE_HEADERS, "memo", "savedAt"];

function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function doGet(e) {
  try {
    const data = getData();
    const callback = e.parameter.callback;
    const result = JSON.stringify({ success: true, data: data, count: Object.keys(data).length, timestamp: new Date().toISOString() });
    if (callback) {
      return ContentService.createTextOutput(callback + "(" + result + ")").setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService.createTextOutput(result).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    const result = JSON.stringify({ success: false, error: error.message });
    const callback = e.parameter.callback;
    if (callback) {
      return ContentService.createTextOutput(callback + "(" + result + ")").setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService.createTextOutput(result).setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    let payload;
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e.parameter && e.parameter.data) {
      payload = JSON.parse(e.parameter.data);
    } else {
      throw new Error("データが空です");
    }

    if (payload.source === "health") {
      const result = mergeHealthData(payload);
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    writeData(payload);

    return ContentService
      .createTextOutput(JSON.stringify({
        success: true,
        message: Object.keys(payload).length + " 日分のデータを同期しました",
        timestamp: new Date().toISOString()
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function setupSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  const headers = ALL_HEADERS.slice();
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight("bold");
  headerRange.setBackground("#5856D6");
  headerRange.setFontColor("white");
  sheet.setFrozenRows(1);
  Logger.log("シートを初期化しました: " + SHEET_NAME);
}

function getData() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return {};

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return {};

  const data = sheet.getRange(1, 1, lastRow, ALL_HEADERS.length).getValues();
  const headers = data[0];
  const result = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    const dateStr = String(row[0]);
    const entry = {};

    headers.forEach((h, j) => {
      if (h.startsWith("routine_")) return;
      entry[h] = row[j] === "" ? "" : row[j];
    });

    entry.routines = {};
    ROUTINES.forEach((r, idx) => {
      const colIdx = BASE_HEADERS.length + idx;
      entry.routines[r] = { done: row[colIdx] === "TRUE" || row[colIdx] === true, time: "" };
    });

    result[dateStr] = entry;
  }
  return result;
}

function writeData(allData) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { setupSheet(); sheet = ss.getSheetByName(SHEET_NAME); }

  // 既存データを読み込み、送信データとマージ（upsert方式）
  const existingData = getData();
  const incomingDates = Object.keys(allData);
  if (incomingDates.length === 0) return;

  // 既存データに送信データをマージ（同一日付は上書き、新規日付は追加）
  incomingDates.forEach(date => {
    existingData[date] = allData[date];
  });

  // マージ後の全データを書き込み
  const allDates = Object.keys(existingData).sort();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, ALL_HEADERS.length).clearContent();

  const rows = allDates.map(date => {
    const d = existingData[date];
    const sleepH = calcSleepHours(d.sleepStart, d.sleepEnd);
    const row = [
      date, d.sleepStart || "", d.sleepEnd || "", sleepH,
      d.nap || 0, d.lastMeal || "", d.water || 0, d.weight || 0,
      d.bodyFat || 0, d.calories || 0, d.steps || 0,
      d.tabelogFollowers || 0, d.tabelogReactions || 0, d.instaFollowers || 0
    ];
    ROUTINES.forEach(r => {
      row.push(d.routines && d.routines[r] && d.routines[r].done ? "TRUE" : "FALSE");
    });
    row.push(d.memo || "");
    row.push(d.savedAt || new Date().toISOString());
    return row;
  });

  sheet.getRange(2, 1, rows.length, ALL_HEADERS.length).setValues(rows);
}

function calcSleepHours(start, end) {
  if (!start || !end) return 0;
  let s = parseInt(start.split(":")[0]) * 60 + parseInt(start.split(":")[1]);
  let e = parseInt(end.split(":")[0]) * 60 + parseInt(end.split(":")[1]);
  if (e <= s) e += 1440;
  return ((e - s) / 60).toFixed(1);
}

function mergeHealthData(payload) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { setupSheet(); sheet = ss.getSheetByName(SHEET_NAME); }

  const dateStr = payload.date || Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");

  const allData = getData();
  const existing = allData[dateStr] || {};

  if (payload.weight !== undefined && payload.weight !== null) existing.weight = payload.weight;
  if (payload.bodyFat !== undefined && payload.bodyFat !== null) existing.bodyFat = payload.bodyFat;
  if (payload.steps !== undefined && payload.steps !== null) existing.steps = payload.steps;
  if (payload.calories !== undefined && payload.calories !== null) existing.calories = payload.calories;

  existing.date = dateStr;
  existing.savedAt = new Date().toISOString();
  allData[dateStr] = existing;

  writeData(allData);

  return {
    success: true,
    message: dateStr + " のヘルスケアデータを更新しました",
    data: {
      weight: existing.weight || null,
      bodyFat: existing.bodyFat || null,
      steps: existing.steps || null,
      calories: existing.calories || null
    }
  };
}
