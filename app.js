const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "1EryOn3o0VFNWGywg_ZSPrlAHQd42K1I2LmYe8EYpn0s";

// 🔴 修改重點 1：欄位順序定義 (這裡一定要跟 Google Sheet 一模一樣)
// A=id, B=date, C=categories, D=title, E=text
const TRANSACTION_SHEET_RANGE = "'transactions'!A:E";
const TRANSACTION_COLUMNS = ["id", "date", "categories", "title", "text"];

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "hsingo";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "12260928";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "365d";

// 驗證憑證
const buildCredentialsFromEnv = () => {
  const requiredKeys = ["GOOGLE_SA_PRIVATE_KEY", "GOOGLE_SA_CLIENT_EMAIL"];
  const hasAll = requiredKeys.every((key) => !!process.env[key]);
  if (!hasAll) return null;
  return {
    private_key: process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.GOOGLE_SA_CLIENT_EMAIL,
  };
};

const getSheetsClient = (() => {
  let cached;
  return () => {
    if (cached) return cached;
    const credentials = buildCredentialsFromEnv();
    const auth = new google.auth.GoogleAuth({
      ...(credentials ? { credentials } : { keyFile: "sunlit-adviser-479406-r0-b5a712496697.json" }),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    cached = google.sheets({ version: "v4", auth });
    return cached;
  };
})();

// 寫入 Google Sheet 工具
const appendRow = async (sheets, range, columns, payload) => {
  const row = columns.map((key) => payload[key] || "");
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
};

// 整理資料工具
const normalizeRows = (rows) => {
  if (!rows || rows.length === 0) return [];
  const [header, ...dataRows] = rows;
  return dataRows.map((row) =>
    header.reduce((acc, key, index) => {
      acc[key] = row[index] ?? "";
      return acc;
    }, {})
  );
};

// --- API 區域 ---

app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (String(username) !== String(ADMIN_USERNAME) || String(password) !== String(ADMIN_PASSWORD)) {
      return res.status(401).json({ message: "帳號或密碼錯誤" });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.json({ token, expiresIn: JWT_EXPIRES_IN });
});

// 🟢 新增資料 API
app.post("/api/transactions", async (req, res) => {
  try {
    // 🔴 修改重點 2：資料對應 (把前端傳來的東西，塞進新的欄位名稱)
    const payload = {
      id: `txn-${Date.now()}`,
      date: req.body.date,
      
      // 前端傳來的 'category' -> 寫入 Sheet 的 'categories' (C欄)
      categories: req.body.category || "一般",
      
      // 前端傳來的 'title' -> 寫入 Sheet 的 'title' (D欄)
      title: req.body.title,
      
      // 前端傳來的 'amount' (文字內容) -> 寫入 Sheet 的 'text' (E欄)
      text: req.body.amount 
    };

    const sheets = getSheetsClient();
    await appendRow(sheets, TRANSACTION_SHEET_RANGE, TRANSACTION_COLUMNS, payload);
    
    res.status(201).json({ message: "成功！", data: payload });
  } catch (error) {
    console.error("寫入錯誤:", error);
    res.status(500).json({ message: "寫入失敗", error: error.message });
  }
});

// 🟢 讀取資料 API
app.get("/api/transactions", async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: TRANSACTION_SHEET_RANGE,
    });

    const transactions = normalizeRows(response.data.values);
    
    // 🔴 修改重點 3：回傳給前端時，要把名字換回前端看得懂的樣子
    const data = transactions.map(row => ({
       id: row.id,
       date: row.date,
       
       // Sheet 的 'text' (E欄) -> 轉回 'amount' 讓前端顯示內容
       amount: row.text,      
       
       title: row.title,
       
       // Sheet 的 'categories' (C欄) -> 轉回 'category'
       category: row.categories,
       
       // 為了相容性補上的假欄位
       category_name: row.categories,
       category_color_hex: "#333333"
    }));

    res.json({ data });
  } catch (error) {
    console.error("讀取錯誤:", error);
    res.status(500).json({ message: "讀取失敗", error: error.message });
  }
});

// 假類別 API (防止報錯)
app.get("/api/categories", (req, res) => {
    res.json({ data: [] });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});