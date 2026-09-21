/**
 * 修改管理者密碼工具
 * 用法：在專案根目錄執行
 *   node scripts/set-admin-password.js "新密碼"
 * 需要先設定好 .env 裡的 DATABASE_URL
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

async function main(){
  const newPassword = process.argv[2];
  if(!newPassword){
    console.error('請提供新密碼，例如：node scripts/set-admin-password.js "新密碼"');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query(
    `INSERT INTO admin_config (id, password_hash, updated_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET password_hash = $1, updated_at = NOW()`,
    [hash]
  );
  console.log('管理者密碼已更新完成');
  await pool.end();
}

main().catch(e=>{
  console.error('更新失敗', e);
  process.exit(1);
});
