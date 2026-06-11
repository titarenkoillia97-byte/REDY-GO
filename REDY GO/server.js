const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

// Раздаем файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// 1. Подключение к базе данных PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Инициализация базы данных
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(50),
        age INT,
        city VARCHAR(50),
        is_premium BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS likes (
        id SERIAL PRIMARY KEY,
        from_id INT,
        to_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("База даних REDY GO успішно ініціалізована");
  } catch (err) {
    console.error("Помилка ініціалізації БД:", err.message);
  }
};
initDB();

// 2. Вход и Регистрация
app.post('/api/auth', async (req, res) => {
  const { phone, name, age, city } = req.body;
  try {
    let user = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) {
      user = await pool.query(
        'INSERT INTO users (phone, name, age, city) VALUES ($1, $2, $3, $4) RETURNING *',
        [phone, name, age, city]
      );
      // Сразу включаем подогрев (фейк-лайки)
      triggerFakeActivity(user.rows[0].id);
    }
    res.json(user.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Алгоритм накрутки 5 фейк-лайков в течение первых часов
function triggerFakeActivity(userId) {
  let likesCount = 0;
  const interval = setInterval(async () => {
    if (likesCount >= 5) return clearInterval(interval);
    const fakeGirlId = Math.floor(Math.random() * 400) + 100; 
    try {
      await pool.query('INSERT INTO likes (from_id, to_id) VALUES ($1, $2)', [fakeGirlId, userId]);
      likesCount++;
      console.log(`Фейк-лайк №${likesCount} начеслився пацану з ID: ${userId}`);
    } catch (e) {
      console.error(e.message);
    }
  }, 1000 * 60 * 10); // Каждые 10 минут прилетает лайк
}

// 4. Запрос на оплату через Cryptomus
app.post('/api/pay', async (req, res) => {
  const { userId } = req.body;
  const orderId = `${userId}_${Date.now()}`;
  
  const payload = {
    amount: "5.00", // $5 народный ценник
    currency: "USD",
    order_id: orderId,
    url_callback: `https://${process.env.RAILWAY_STATIC_URL}/api/webhook/cryptomus`,
    url_return: `https://${process.env.RAILWAY_STATIC_URL}/`
  };

  const sign = crypto.createHash('md5').update(Buffer.from(JSON.stringify(payload)).toString('base64') + process.env.CRYPTOMUS_API_KEY).digest('hex');

  try {
    const response = await axios.post('https://api.cryptomus.com/v1/payment', payload, {
      headers: {
        'merchant': process.env.CRYPTOMUS_MERCHANT_ID,
        'sign': sign
      }
    });
    res.json({ url: response.data.result.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Вебхук успешной оплаты
app.post('/api/webhook/cryptomus', async (req, res) => {
  const { status, order_id } = req.body;
  if (status === 'paid' || status === 'paid_over') {
    const userId = order_id.split('_')[0];
    try {
      await pool.query('UPDATE users SET is_premium = true WHERE id = $1', [userId]);
      res.sendStatus(200);
    } catch (err) {
      res.status(500).send(err.message);
    }
  } else {
    res.sendStatus(400);
  }
});

// Главная страница фронтенда
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Сервер працює на порту ${PORT}`));