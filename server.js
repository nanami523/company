require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const ADMIN_PATH = process.env.ADMIN_PATH || 'admin-8x2kq9';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-please';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================================================
   服務類型定義（要跟前端 public/index.html 的 SERVICES 對應）
========================================================= */
const SERVICE_LABELS = {
  coaching: '企業入輔（專家入場輔導）',
  joint_recruitment: '聯合徵才',
  job_matching: '即時求才媒合',
  work_experience: '職場體驗'
};

/* =========================================================
   資料庫初始化（第一次啟動時自動建立資料表）
========================================================= */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      service_type TEXT NOT NULL,
      data JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_config (
      id INT PRIMARY KEY DEFAULT 1,
      password_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const existing = await pool.query('SELECT id FROM admin_config WHERE id = 1');
  if (existing.rows.length === 0) {
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || 'ChangeMe123!';
    const hash = await bcrypt.hash(initialPassword, 10);
    await pool.query('INSERT INTO admin_config (id, password_hash) VALUES (1, $1)', [hash]);
    console.log('已建立管理者初始密碼（來自 ADMIN_INITIAL_PASSWORD 環境變數）');
  }
  console.log('資料庫初始化完成');
}

/* =========================================================
   Email 通知（選填，未設定 SMTP 帳密則自動略過）
========================================================= */
let mailer = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function notifyNewSubmission(serviceType, data) {
  if (!mailer || !process.env.NOTIFY_EMAIL_TO) return;
  const label = SERVICE_LABELS[serviceType] || serviceType;
  const lines = Object.entries(data)
    .map(([k, v]) => `${k}：${Array.isArray(v) ? v.join('、') : (v ?? '')}`)
    .join('\n');
  try {
    await mailer.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.NOTIFY_EMAIL_TO,
      subject: `【新表單通知】${label} - ${data.companyName || ''}`,
      text: `收到一筆新的「${label}」申請，請登入後台查看完整資料。\n\n${lines}`
    });
  } catch (e) {
    console.error('email 通知寄送失敗（資料仍已存入後台，不影響送出結果）：', e.message);
  }
}

/* =========================================================
   公開 API：表單送出
========================================================= */
app.post('/api/submit', async (req, res) => {
  try {
    const { serviceType, data } = req.body || {};
    if (!serviceType || !SERVICE_LABELS[serviceType] || !data || typeof data !== 'object') {
      return res.status(400).json({ error: '資料格式不正確' });
    }
    const result = await pool.query(
      'INSERT INTO submissions (service_type, data) VALUES ($1, $2) RETURNING id, created_at',
      [serviceType, data]
    );
    notifyNewSubmission(serviceType, data).catch(() => {});
    res.json({ success: true, id: result.rows[0].id });
  } catch (e) {
    console.error('送出失敗', e);
    res.status(500).json({ error: '伺服器忙碌中，請稍後再試一次' });
  }
});

/* =========================================================
   管理者登入
========================================================= */
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: '請輸入密碼' });
    const result = await pool.query('SELECT password_hash FROM admin_config WHERE id = 1');
    if (result.rows.length === 0) return res.status(500).json({ error: '尚未設定管理者密碼' });
    const ok = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: '密碼錯誤' });
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token });
  } catch (e) {
    console.error('登入失敗', e);
    res.status(500).json({ error: '伺服器忙碌中，請稍後再試一次' });
  }
});

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: '請先登入' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: '登入已逾期，請重新登入' });
  }
}

/* =========================================================
   後台 API（需要登入權杖）
========================================================= */
app.get('/api/admin/submissions', requireAdmin, async (req, res) => {
  try {
    const { service, status } = req.query;
    const conditions = [];
    const params = [];
    if (service) { params.push(service); conditions.push(`service_type = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT id, service_type, data, status, created_at FROM submissions ${where} ORDER BY created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (e) {
    console.error('讀取失敗', e);
    res.status(500).json({ error: '讀取資料失敗' });
  }
});

app.patch('/api/admin/submissions/:id', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: '缺少 status' });
    const result = await pool.query(
      'UPDATE submissions SET status = $1 WHERE id = $2 RETURNING id, service_type, data, status, created_at',
      [status, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '找不到這筆資料' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('更新失敗', e);
    res.status(500).json({ error: '更新失敗' });
  }
});

app.delete('/api/admin/submissions/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM submissions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('刪除失敗', e);
    res.status(500).json({ error: '刪除失敗' });
  }
});

/* =========================================================
   靜態檔案：前台表單 + 後台管理頁（後台走隱藏路徑）
========================================================= */
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get(`/${ADMIN_PATH}`, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-8x2kq9', 'index.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`伺服器已啟動：http://localhost:${PORT}`);
      console.log(`後台網址：http://localhost:${PORT}/${ADMIN_PATH}`);
    });
  })
  .catch((e) => {
    console.error('資料庫初始化失敗，伺服器未啟動', e);
    process.exit(1);
  });
