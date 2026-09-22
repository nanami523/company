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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_views (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      path TEXT,
      referrer TEXT,
      utm_source TEXT,
      utm_campaign TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS utm_source TEXT;`);
  await pool.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS utm_campaign TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visitor_sessions (
      session_id TEXT PRIMARY KEY,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
   公開 API：訪客計數（頁面瀏覽 + 在線心跳，不需要登入）
========================================================= */
function classifyReferrer(referrer) {
  if (!referrer) return '直接輸入網址或書籤';
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    if (host.includes('google.')) return 'Google 搜尋';
    if (host.includes('line.me') || host.includes('lin.ee')) return 'LINE';
    if (host.includes('facebook.') || host.includes('fb.')) return 'Facebook';
    if (host.includes('instagram.')) return 'Instagram';
    if (host.includes('bing.')) return 'Bing 搜尋';
    if (host.includes('yahoo.')) return 'Yahoo';
    return '其他網站（' + host + '）';
  } catch (e) {
    return '其他來源';
  }
}

// 常見 utm_source 的中文顯示名稱；沒對應到的會直接顯示原始代碼，
// 所以之後想開新的追蹤通路，直接在連結上換一組新的 utm_source 即可，不需要改程式碼。
const UTM_SOURCE_LABELS = {
  fb_post: 'Facebook 粉專貼文',
  fb_group: 'Facebook 社團分享',
  dm_qr: 'DM文宣 QR code',
  line_oa: '官方LINE自動回覆'
};
function classifySource(referrer, utmSource) {
  if (utmSource) {
    return UTM_SOURCE_LABELS[utmSource] || ('追蹤連結：' + utmSource);
  }
  return classifyReferrer(referrer);
}

app.post('/api/track', async (req, res) => {
  try {
    const { sessionId, path: pagePath, referrer, utmSource, utmCampaign } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: '缺少 sessionId' });
    await pool.query(
      'INSERT INTO page_views (session_id, path, referrer, utm_source, utm_campaign) VALUES ($1, $2, $3, $4, $5)',
      [sessionId, pagePath || '/', referrer || null, utmSource || null, utmCampaign || null]
    );
    await pool.query(
      `INSERT INTO visitor_sessions (session_id, last_seen) VALUES ($1, NOW())
       ON CONFLICT (session_id) DO UPDATE SET last_seen = NOW()`,
      [sessionId]
    );
    res.json({ success: true });
  } catch (e) {
    // 計數失敗不影響網站正常使用，安靜略過即可
    res.json({ success: false });
  }
});

app.post('/api/heartbeat', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: '缺少 sessionId' });
    await pool.query(
      `INSERT INTO visitor_sessions (session_id, last_seen) VALUES ($1, NOW())
       ON CONFLICT (session_id) DO UPDATE SET last_seen = NOW()`,
      [sessionId]
    );
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

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

app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
  try {
    const [totalRes, todayRes, onlineRes, referrerRes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM page_views'),
      pool.query(`SELECT COUNT(*)::int AS count FROM page_views WHERE created_at >= date_trunc('day', NOW())`),
      pool.query(`SELECT COUNT(*)::int AS count FROM visitor_sessions WHERE last_seen >= NOW() - INTERVAL '60 seconds'`),
      pool.query('SELECT referrer, utm_source FROM page_views')
    ]);

    const referrerCounts = {};
    referrerRes.rows.forEach(row => {
      const label = classifySource(row.referrer, row.utm_source);
      referrerCounts[label] = (referrerCounts[label] || 0) + 1;
    });
    const referrers = Object.entries(referrerCounts)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    res.json({
      totalViews: totalRes.rows[0].count,
      todayViews: todayRes.rows[0].count,
      onlineCount: onlineRes.rows[0].count,
      referrers
    });
  } catch (e) {
    console.error('讀取統計失敗', e);
    res.status(500).json({ error: '讀取統計失敗' });
  }
});

app.get('/api/admin/analytics/daily', requireAdmin, async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const result = await pool.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
       FROM page_views
       WHERE created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY 1 ORDER BY 1`,
      [days]
    );
    // 補齊沒有造訪紀錄的日期，讓曲線圖不會斷點
    const map = {};
    result.rows.forEach(r => { map[r.date] = r.count; });
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      series.push({ date: key, count: map[key] || 0 });
    }
    res.json({ series });
  } catch (e) {
    console.error('讀取趨勢資料失敗', e);
    res.status(500).json({ error: '讀取趨勢資料失敗' });
  }
});

app.get('/api/admin/analytics/export', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT referrer, utm_source, created_at FROM page_views ORDER BY created_at');
    const monthly = {}; // { 'YYYY-MM': { total, bySource: {label: count} } }
    result.rows.forEach(row => {
      const ym = row.created_at.toISOString().slice(0, 7);
      const label = classifySource(row.referrer, row.utm_source);
      if (!monthly[ym]) monthly[ym] = { total: 0, bySource: {} };
      monthly[ym].total += 1;
      monthly[ym].bySource[label] = (monthly[ym].bySource[label] || 0) + 1;
    });

    const lines = [];
    lines.push('月份,來源,造訪人次');
    Object.keys(monthly).sort().forEach(ym => {
      const m = monthly[ym];
      lines.push(`${ym},總計,${m.total}`);
      Object.entries(m.bySource)
        .sort((a, b) => b[1] - a[1])
        .forEach(([label, count]) => {
          const safeLabel = '"' + String(label).replace(/"/g, '""') + '"';
          lines.push(`${ym},${safeLabel},${count}`);
        });
    });
    const csv = '\uFEFF' + lines.join('\n'); // 加上 BOM，Excel 開啟中文才不會亂碼

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="visitor-report.csv"');
    res.send(csv);
  } catch (e) {
    console.error('匯出報表失敗', e);
    res.status(500).json({ error: '匯出報表失敗' });
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
