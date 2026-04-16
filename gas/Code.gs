/**
 * 習慣ログ - Google Apps Script 同期API
 * GitHub Pages のアプリからデータを受け取り、Google Sheets に保存する
 *
 * 設計方針: rawJSON列にフロントエンドのデータをそのまま保存し、
 * フィールドマッピング不一致によるデータ欠損を構造的に防止する。
 * 個別カラムは視認用のみ（正はrawJSON）。
 *
 * clasp project script ID: 1P24erqoDPsLlTNArsF8qajNiPtv-Ze5zFdpGX_cJ_tP6BOVTEdWejB7w
 */

const SPREADSHEET_ID = "1Z3KD6O3Uv47bTQ8bj-TM1KHxACrwWqGyvBzhkgUURT8";
const SHEET_NAME = "習慣ログ";
const DISPLAY_HEADERS = ["date", "sleepStart", "sleepEnd", "sleepHours", "nap", "lastMeal", "water", "weight", "bodyFat", "calories", "steps", "memo", "savedAt", "rawJSON"];

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

function ensureSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    // 旧シート名からのマイグレーション
    sheet = ss.getSheetByName("暮らしの記録 - LifeLog");
    if (sheet) {
      sheet.setName(SHEET_NAME);
    } else {
      sheet = ss.insertSheet(SHEET_NAME);
    }
  }

  // ヘッダー確認・設定
  const firstRow = sheet.getRange(1, 1, 1, DISPLAY_HEADERS.length).getValues()[0];
  const rawJSONIdx = firstRow.indexOf("rawJSON");
  if (rawJSONIdx === -1) {
    // rawJSON列がない = 旧フォーマット。ヘッダーを再設定
    const headerRange = sheet.getRange(1, 1, 1, DISPLAY_HEADERS.length);
    headerRange.setValues([DISPLAY_HEADERS]);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#5856D6");
    headerRange.setFontColor("white");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * データ読み取り: rawJSON列があればそこから復元（正確）、なければ個別カラムからベストエフォート復元
 */
function getData() {
  const sheet = ensureSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return {};

  const numCols = sheet.getLastColumn();
  const data = sheet.getRange(1, 1, lastRow, numCols).getValues();
  const headers = data[0];
  const rawJSONIdx = headers.indexOf("rawJSON");
  const result = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;

    // 日付キーを正規化
    let dateStr = row[0];
    if (dateStr instanceof Date) {
      dateStr = Utilities.formatDate(dateStr, "Asia/Tokyo", "yyyy-MM-dd");
    } else {
      dateStr = String(dateStr);
      // "Mon Apr 06 2026..." 形式を変換
      if (dateStr.length > 10) {
        try {
          const d = new Date(dateStr);
          if (!isNaN(d.getTime())) {
            dateStr = Utilities.formatDate(d, "Asia/Tokyo", "yyyy-MM-dd");
          }
        } catch (e) {}
      }
    }

    // rawJSON列があればそこから復元（正）
    if (rawJSONIdx !== -1 && row[rawJSONIdx]) {
      try {
        result[dateStr] = JSON.parse(row[rawJSONIdx]);
        continue;
      } catch (e) {
        // rawJSONパース失敗時はフォールバック
      }
    }

    // rawJSONがない場合: 個別カラムからベストエフォート復元（旧データ互換）
    const entry = {};
    headers.forEach((h, j) => {
      if (h === "rawJSON" || h === "date" || h === "sleepHours") return;
      if (h.startsWith("routine_")) {
        // 旧形式のルーティン列をフラットに変換
        const routineName = h.replace("routine_", "");
        entry[routineName] = { done: row[j] === "TRUE" || row[j] === true };
      } else {
        entry[h] = row[j] === "" ? "" : row[j];
      }
    });
    result[dateStr] = entry;
  }
  return result;
}

/**
 * データ書き込み: rawJSON列にフロントエンドデータをそのまま保存
 * 個別カラムは視認用に主要フィールドだけ展開
 */
function writeData(allData) {
  const sheet = ensureSheet();

  // 既存データを読み込み、送信データとマージ（upsert方式）
  const existingData = getData();
  const incomingDates = Object.keys(allData);
  if (incomingDates.length === 0) return;

  incomingDates.forEach(date => {
    existingData[date] = allData[date];
  });

  // マージ後の全データを書き込み
  const allDates = Object.keys(existingData).sort();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, DISPLAY_HEADERS.length).clearContent();
  // 旧フォーマットの余分な列もクリア
  const totalCols = sheet.getLastColumn();
  if (totalCols > DISPLAY_HEADERS.length && lastRow > 1) {
    sheet.getRange(2, DISPLAY_HEADERS.length + 1, lastRow - 1, totalCols - DISPLAY_HEADERS.length).clearContent();
  }

  const rows = allDates.map(date => {
    const d = existingData[date];
    const sleepH = calcSleepHours(d.sleepStart, d.sleepEnd);
    // 視認用カラム + rawJSON
    return [
      date,
      d.sleepStart || "",
      d.sleepEnd || "",
      sleepH,
      d.nap || 0,
      d.lastMeal || "",
      d.water || 0,
      d.weight || 0,
      d.bodyFat || 0,
      d.calories || 0,
      d.steps || 0,
      d.memo || "",
      d.savedAt || new Date().toISOString(),
      JSON.stringify(d)  // rawJSON: フロントエンドデータをそのまま保存
    ];
  });

  if (rows.length > 0) {
    // ヘッダーを最新に更新
    sheet.getRange(1, 1, 1, DISPLAY_HEADERS.length).setValues([DISPLAY_HEADERS]);
    sheet.getRange(2, 1, rows.length, DISPLAY_HEADERS.length).setValues(rows);
  }
}

function calcSleepHours(start, end) {
  if (!start || !end) return 0;
  try {
    let s = parseInt(String(start).split(":")[0]) * 60 + parseInt(String(start).split(":")[1]);
    let e = parseInt(String(end).split(":")[0]) * 60 + parseInt(String(end).split(":")[1]);
    if (e <= s) e += 1440;
    return ((e - s) / 60).toFixed(1);
  } catch (e) {
    return 0;
  }
}

function mergeHealthData(payload) {
  const sheet = ensureSheet();
  const dateStr = payload.date || Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");

  const allData = getData();
  const existing = allData[dateStr] || {};

  if (payload.weight !== undefined && payload.weight !== null) existing.weight = payload.weight;
  if (payload.bodyFat !== undefined && payload.bodyFat !== null) existing.bodyFat = payload.bodyFat;
  if (payload.steps !== undefined && payload.steps !== null) existing.steps = payload.steps;
  if (payload.calories !== undefined && payload.calories !== null) existing.calories = payload.calories;

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
