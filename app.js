const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");
const http = require("http");
const { Server } = require("socket.io");

dotenv.config();

// 1. 初始化 Express
const app = express();
app.use(cors());
app.use(express.json());

// 2. 初始化 HTTP Server 和 Socket.io (關鍵順序)
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // 允許所有網域連線
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "1EryOn3o0VFNWGywg_ZSPrlAHQd42K1I2LmYe8EYpn0s";

// A=id, B=date, C=categories, D=title, E=text, E=reply
const TRANSACTION_SHEET_RANGE = "'transactions'!A:F";
const TRANSACTION_COLUMNS = ["id", "date", "categories", "title", "text", "reply"];

const updateRow = async (sheets, rowIndex, columns, payload) => {
  const row = columns.map((key) => payload[key] || ""); // 照順序填入
  
  // 算出範圍 (例如 A2:F2)
  const range = `'transactions'!A${rowIndex}:${String.fromCharCode(64 + columns.length)}${rowIndex}`;
  
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
};

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

// 新增資料 API
app.post("/api/transactions", async (req, res) => {
  try {
    const payload = {
      id: `txn-${Date.now()}`,
      date: req.body.date,
      categories: req.body.category || "一般",
      title: req.body.title,
      text: req.body.amount 
    };
    
    // 廣播
    io.emit("transaction_update", { type: "add", user: "有人", msg: "新增了一筆好笑紀錄！" });

    const sheets = getSheetsClient();
    await appendRow(sheets, TRANSACTION_SHEET_RANGE, TRANSACTION_COLUMNS, payload);
    
    res.status(201).json({ message: "成功囉！", data: payload });
  } catch (error) {
    console.error("寫入錯誤:", error);
    res.status(500).json({ message: "寫入失敗", error: error.message });
  }
});

// 讀取資料 API
app.get("/api/transactions", async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: TRANSACTION_SHEET_RANGE,
    });

    const transactions = normalizeRows(response.data.values);
    
    const data = transactions.map(row => ({
       id: row.id,
       date: row.date,
       amount: row.text,      
       title: row.title,
       category: row.categories,
       category_name: row.categories,
       category_color_hex: "#333333",
       reply: row.reply 
    }));

    res.json({ data });
  } catch (error) {
    console.error("讀取錯誤:", error);
    res.status(500).json({ message: "讀取失敗", error: error.message });
  }
});

// 假類別 API
app.get("/api/categories", (req, res) => {
    res.json({ data: [] });
});

// PUT API (更新)
app.put("/api/transactions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sheets = getSheetsClient();
    
    // 1. 先去 Sheet 找這筆資料在哪一行
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: TRANSACTION_SHEET_RANGE,
    });
    
    const rows = response.data.values || [];
    let rowIndex = -1;
    let currentRowData = {};

    for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === id) {
            rowIndex = i + 1; 
            currentRowData = TRANSACTION_COLUMNS.reduce((acc, col, idx) => {
                acc[col] = rows[i][idx];
                return acc;
            }, {});
            break;
        }
    }

    if (rowIndex === -1) {
        return res.status(404).json({ message: "找不到這筆資料" });
    }

    // 2. 合併新舊資料
    const payload = {
        ...currentRowData,
        ...req.body 
    };
    
    // 廣播
    io.emit("transaction_update", { type: "update", user: "有人", msg: "修改了紀錄或回覆！" });

    // 3. 寫回
    await updateRow(sheets, rowIndex, TRANSACTION_COLUMNS, payload);

    res.json({ message: "更新成功", data: payload });

  } catch (error) {
    console.error("更新錯誤:", error);
    res.status(500).json({ message: "更新失敗", error: error.message });
  }
});

// DELETE API (刪除)
app.delete("/api/transactions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sheets = getSheetsClient();

    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID
    });
    
    const sheet = spreadsheet.data.sheets.find(
      s => s.properties.title === 'transactions'
    );

    if (!sheet) {
      return res.status(404).json({ message: "找不到 transactions 工作表" });
    }
    
    const sheetId = sheet.properties.sheetId;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: TRANSACTION_SHEET_RANGE,
    });

    const rows = response.data.values || [];
    let rowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === id) {
        rowIndex = i; 
        break;
      }
    }

    if (rowIndex === -1) {
      return res.status(404).json({ message: "找不到這筆資料" });
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: sheetId,
                dimension: "ROWS",
                startIndex: rowIndex,     
                endIndex: rowIndex + 1    
              }
            }
          }
        ]
      }
    });
    
    // 廣播
    io.emit("transaction_update", { type: "delete", user: "有人", msg: "刪除了一筆紀錄..." });

    res.json({ message: "刪除成功" });

  } catch (error) {
    console.error("刪除錯誤:", error);
    res.status(500).json({ message: "刪除失敗", error: error.message });
  }
});

// ⚠️ 重要：最後要改用 server.listen，而不是 app.listen
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

