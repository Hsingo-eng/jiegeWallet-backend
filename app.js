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

// 🔴 修改點 1：對應你 Google Sheet 實際的欄位名稱
const TRANSACTION_SHEET_RANGE = process.env.GOOGLE_TRANSACTION_RANGE || "'transactions'!A:E";
const TRANSACTION_COLUMNS = [
  "id",
  "date",
  "Text",       // 對應 C 欄 (內容)
  "title",      // 對應 D 欄 (標題)
  "categories"  // 對應 E 欄 (類別)
];

// 為了避免後端報錯，我們放寬必填檢查
const REQUIRED_TRANSACTION_COLUMNS = ["date"]; 

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "hsingo";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "12260928";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "365d";

// 驗證 Google Sheets 憑證
const buildCredentialsFromEnv = () => {
  const requiredKeys = [
    "GOOGLE_SA_TYPE",
    "GOOGLE_SA_PROJECT_ID",
    "GOOGLE_SA_PRIVATE_KEY_ID",
    "GOOGLE_SA_PRIVATE_KEY",
    "GOOGLE_SA_CLIENT_EMAIL",
    "GOOGLE_SA_CLIENT_ID",
  ];

  const hasAll = requiredKeys.every((key) => !!process.env[key]);
  if (!hasAll) return null;

  return {
    type: process.env.GOOGLE_SA_TYPE,
    project_id: process.env.GOOGLE_SA_PROJECT_ID,
    private_key_id: process.env.GOOGLE_SA_PRIVATE_KEY_ID,
    private_key: process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.GOOGLE_SA_CLIENT_EMAIL,
    client_id: process.env.GOOGLE_SA_CLIENT_ID,
  };
};

const getSheetsClient = (() => {
  let cached;
  return () => {
    if (cached) return cached;
    const credentials = buildCredentialsFromEnv();
    const auth = new google.auth.GoogleAuth({
      ...(credentials
        ? { credentials }
        : {
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS ||
              path.join(__dirname, "sunlit-adviser-479406-r0-b5a712496697.json"),
          }),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    cached = google.sheets({ version: "v4", auth });
    return cached;
  };
})();

const appendRow = async (sheets, range, columns, payload) => {
  const row = columns.map((key) => {
    const value = payload[key];
    return value === undefined || value === null ? "" : value;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
};

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

// JWT 驗證
const generateToken = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
const requireAuth = (req, res, next) => {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: "未授權" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: "token 無效" });
  }
};

// === API Routes ===

app.get("/", (req, res) => {
  res.json({ message: "好笑紀錄本 API", sheetId: SHEET_ID });
});

// 登入
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (String(username) !== String(ADMIN_USERNAME) || String(password) !== String(ADMIN_PASSWORD)) {
      return res.status(401).json({ message: "帳號或密碼錯誤" });
  }
  const token = generateToken({ username });
  res.json({ token, expiresIn: JWT_EXPIRES_IN });
});

// 🔴 修改點 2：簡化新增資料邏輯 (直接寫入，不查 ID)
app.post("/api/transactions", requireAuth, async (req, res) => {
  try {
    // 這裡我們把前端傳來的資料，手動對應到 Google Sheet 的欄位
    // 前端傳來的 -> req.body.amount (這是內容)
    // 前端傳來的 -> req.body.title (這是標題)
    // 前端傳來的 -> req.body.category (這是類別文字)
    
    const payload = {
      id: `txn-${Date.now()}`, // 自動產生 ID
      date: req.body.date,
      
      // ⚠️ 關鍵對應：把前端的 amount (內容) 存到 Text 欄位
      Text: req.body.amount, 
      
      // ⚠️ 關鍵對應：標題
      title: req.body.title, 
      
      // ⚠️ 關鍵對應：類別直接存文字，不要管 ID 了
      categories: req.body.category || "未分類"
    };

    const sheets = getSheetsClient();
    await appendRow(sheets, TRANSACTION_SHEET_RANGE, TRANSACTION_COLUMNS, payload);
    
    res.status(201).json({ message: "紀錄成功！", data: payload });

  } catch (error) {
    console.error("寫入失敗:", error);
    res.status(500).json({ message: "無法寫入資料", error: error.message });
  }
});

// 🔴 修改點 3：簡化讀取資料
app.get("/api/transactions", async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: TRANSACTION_SHEET_RANGE,
    });

    // 把 Google Sheet 的資料整理好回傳給前端
    const transactions = normalizeRows(response.data.values);
    
    // 為了讓前端顯示正常，我們稍微轉換一下資料結構回傳
    const data = transactions.map(row => ({
       id: row.id,
       date: row.date,
       amount: row.Text,     // 把 Text 欄位改名回 amount 讓前端顯示內容
       title: row.title,
       category: row.categories, // 把 categories 欄位回傳
       category_name: row.categories, // 兼容前端顯示
       category_color_hex: "#333333"  // 給個預設顏色，避免報錯
    }));

    res.json({ data });
  } catch (error) {
    console.error("讀取失敗:", error);
    res.status(500).json({ message: "無法讀取資料", error: error.message });
  }
});

// 為了避免前端呼叫 /api/categories 報錯 500，我們給一個假的回應
app.get("/api/categories", (req, res) => {
    res.json({ data: [
        { id: "1", name: "一般", color_hex: "#9E9E9E" }
    ]});
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});