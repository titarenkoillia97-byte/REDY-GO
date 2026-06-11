const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public')); // Раздает наш бело-красный фронтенд

// 1. Коннект до базы PostgreSQL (Railway подставит ссылку автоматом)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Автоматичне створення таблиць в базі при першому запуску
const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) UNIQUE NOT NULL,
      name VARCHAR(50),
      age INT,
      city VARCHAR(50),
      gender VARCHAR(10) DEFAULT 'male',
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
};
initDB();

// 2. Вхід / Реєстрація пацанів
app.post('/api/auth', async (req, res) => {
  const { phone, name, age, city } = req.body;
  try {
    let user = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) {
      user = await pool.query(
        'INSERT INTO users (phone, name, age, city) VALUES ($1, $2, $3, $4) RETURNING *',
        [phone, name, age, city]
      );
      // СРАЗУ ВКЛЮЧАЕМ ПОДОГРЕВ ДЛЯ НОВОГО ЮЗЕРА
      triggerFakeActivity(user.rows[0].id);
    }
    res.json(user.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. АЛГОРИТМ ПОДОГРЕВА (Накрутка 5 лайків для утримання)
function triggerFakeActivity(userId) {
  console.log(`Запущено підігрів для юзера: ${userId}`);
  let likesCount = 0;
  
  const interval = setInterval(async () => {
    if (likesCount >= 5) return clearInterval(interval);
    
    // Генерируем фейкові ID дівчат (просто рандомні числа від 100 до 500)
    const fakeGirlId = Math.floor(Math.random() * 400) + 100; 
    
    try {
      await pool.query('INSERT INTO likes (from_id, to_id) VALUES ($1, $2)', [fakeGirlId, userId]);
      likesCount++;
      console.log(`Фейк-лайк №${likesCount} прилетів пацану з ID: ${userId}`);
    } catch (e) {
      console.error("Помилка додавання лайку:", e.message);
    }
  }, 1000 * 60 * 10); // Лайк прилітає кожні 10 хвилин після реєстрації
}

// 4. СТВОРЕННЯ ОПЛАТИ ЧЕРЕЗ CRYPTOMUS (Гривні з карти або Крипта)
app.post('/api/pay', async (req, res) => {
  const { userId } = req.body;
  const orderId = `${userId}_${Date.now()}`;
  
  const payload = {
    amount: "5.00", // Ставимо народний цінник $5 за вхід в клуб
    currency: "USD",
    order_id: orderId,
    url_callback: `https://${process.env.RAILWAY_STATIC_URL}/api/webhook/cryptomus`,
    url_return: `https://${process.env.RAILWAY_STATIC_URL}/`
  };

  // Базове шифрування підпису для Cryptomus API
  const sign = crypto.createHash('md5').update(Buffer.from(JSON.stringify(payload)).toString('base64') + process.env.CRYPTOMUS_API_KEY).digest('hex');

  try {
    const response = await axios.post('https://api.cryptomus.com/v1/payment', payload, {
      headers: {
        'merchant': process.env.CRYPTOMUS_MERCHANT_ID,
        'sign': sign
      }
    });
    res.json({ url: response.data.result.url }); // Повертаємо посилання на оплату (карта/крипта)
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. ВЕБХУК: Обробинк успішної оплати
app.post('/api/webhook/cryptomus', async (req, res) => {
  const { status, order_id } = req.body;
  if (status === 'paid' || status === 'paid_over') {
    const userId = order_id.split('_')[0];
    try {
      await pool.query('UPDATE users SET is_premium = true WHERE id = $1', [userId]);
      console.log(`Бабки зайшли! Юзер ${userId} отримав Преміум. Блюр знято!`);
      res.sendStatus(200);
    } catch (err) {
      res.status(500).send(err.message);
    }
  } else {
    res.sendStatus(400);
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`REDY GO сервер валить на порту ${PORT}`));