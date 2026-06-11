'use strict';
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const axios   = require('axios');
const crypto  = require('crypto');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ═══════════════════════════════════════════════════════════
   БАЗА ДАНИХ
════════════════════════════════════════════════════════════ */
const dbUrl = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl && !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      phone       VARCHAR(20) UNIQUE NOT NULL,
      is_premium  BOOLEAN    DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS likes (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_fake_id INTEGER NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);
  `);
  console.log('✅ Таблиці бази даних ініціалізовано');
}

/* ═══════════════════════════════════════════════════════════
   ДВИГУН ФЕЙКОВИХ ЛАЙКІВ
════════════════════════════════════════════════════════════ */
const FAKE_IDS = Array.from({ length: 20 }, (_, i) => 1001 + i);

async function giveFakeLikes(userId) {
  const shuffled = [...FAKE_IDS].sort(() => Math.random() - 0.5);
  const picked   = shuffled.slice(0, 5);
  await Promise.all(
    picked.map(fid =>
      pool.query(
        'INSERT INTO likes (user_id, from_fake_id) VALUES ($1, $2)',
        [userId, fid]
      )
    )
  );
}

async function runFakeLikesEngine() {
  try {
    const { rows } = await pool.query('SELECT id FROM users');
    if (!rows.length) return;
    await Promise.all(rows.map(r => giveFakeLikes(r.id)));
    console.log(`💘 Фейк-лайки: по 5 лайків → ${rows.length} користувачів`);
  } catch (e) {
    console.error('❌ Помилка двигуна лайків:', e.message);
  }
}

/* ═══════════════════════════════════════════════════════════
   MIDDLEWARE
════════════════════════════════════════════════════════════ */
app.use(express.static(path.join(__dirname, 'public')));

// Зберігаємо raw-буфер для перевірки підпису вебхука Cryptomus
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

/* ═══════════════════════════════════════════════════════════
   МАРШРУТИ
════════════════════════════════════════════════════════════ */

// Перевірка стану сервера
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);

// ── Авторизація / Реєстрація за номером телефону ──────────
app.post('/api/auth', async (req, res) => {
  const { phone } = req.body ?? {};

  if (!phone || typeof phone !== 'string' || phone.trim().length < 10) {
    return res.status(400).json({ error: 'Невірний номер телефону' });
  }

  const p = phone.replace(/\s/g, '').trim();

  try {
    const existing = await pool.query(
      'SELECT id, phone, is_premium FROM users WHERE phone = $1',
      [p]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      console.log(`📱 Вхід: ${p} (ID ${user.id})`);
      return res.json(user);
    }

    const inserted = await pool.query(
      'INSERT INTO users (phone) VALUES ($1) RETURNING id, phone, is_premium',
      [p]
    );
    const user = inserted.rows[0];
    console.log(`🆕 Нова реєстрація: ${p} (ID ${user.id})`);

    // Відразу видаємо 5 стартових фейкових лайків
    await giveFakeLikes(user.id);
    console.log(`💘 Стартові лайки надіслані → користувач ${user.id}`);

    return res.json(user);
  } catch (e) {
    console.error('❌ /api/auth:', e.message);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  }
});

// ── Профіль користувача ───────────────────────────────────
app.get('/api/profile/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Невірний ID' });

  try {
    const { rows } = await pool.query(
      'SELECT id, phone, is_premium FROM users WHERE id = $1',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Не знайдено' });
    res.json(rows[0]);
  } catch (e) {
    console.error('❌ /api/profile:', e.message);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  }
});

// ── Кількість лайків ──────────────────────────────────────
app.get('/api/likes/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Невірний ID' });

  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM likes WHERE user_id = $1',
      [id]
    );
    res.json({ count: parseInt(rows[0].cnt, 10) });
  } catch (e) {
    console.error('❌ /api/likes:', e.message);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  }
});

// ── Створення платежу Cryptomus ───────────────────────────
app.post('/api/pay', async (req, res) => {
  const { userId } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: "userId обов'язковий" });

  const merchant = process.env.CRYPTOMUS_MERCHANT_ID;
  const apiKey   = process.env.CRYPTOMUS_API_KEY;

  if (!merchant || !apiKey) {
    console.error('❌ Cryptomus: ключі не налаштовані (CRYPTOMUS_MERCHANT_ID / CRYPTOMUS_API_KEY)');
    return res.status(500).json({ error: 'Платіжна система не налаштована' });
  }

  const appUrl  = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const orderId = `redy_${userId}_${Date.now()}`;

  const payload = {
    amount:              '5.00',
    currency:            'USD',
    order_id:            orderId,
    url_return:          appUrl,
    url_success:         `${appUrl}?payment=success`,
    url_callback:        `${appUrl}/api/webhook/cryptomus`,
    is_payment_multiple: false,
    lifetime:            3600,
  };

  const b64  = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sign = crypto.createHash('md5').update(b64 + apiKey).digest('hex');

  try {
    console.log(`💳 Створення платежу | user=${userId} | order=${orderId}`);

    const { data } = await axios.post(
      'https://api.cryptomus.com/v1/payment',
      payload,
      {
        headers: {
          merchant,
          sign,
          'Content-Type': 'application/json',
        },
        timeout: 12_000,
      }
    );

    const url = data?.result?.url;
    if (!url) {
      console.error('❌ Cryptomus не повернув URL:', JSON.stringify(data));
      return res.status(502).json({ error: 'Помилка платіжного сервісу' });
    }

    console.log(`✅ Платіжна сесія: ${data.result.uuid}`);
    res.json({ url });
  } catch (e) {
    const detail = e.response ? JSON.stringify(e.response.data) : e.message;
    console.error('❌ Cryptomus API:', detail);
    res.status(502).json({ error: 'Помилка підключення до Cryptomus' });
  }
});

// ── Вебхук Cryptomus ──────────────────────────────────────
app.post('/api/webhook/cryptomus', async (req, res) => {
  try {
    const data         = req.body;
    const receivedSign = data?.sign;

    // Перевірка підпису: видаляємо sign, решту підписуємо
    const { sign: _s, ...withoutSign } = data ?? {};
    const b64      = Buffer.from(JSON.stringify(withoutSign)).toString('base64');
    const expected = crypto
      .createHash('md5')
      .update(b64 + (process.env.CRYPTOMUS_API_KEY ?? ''))
      .digest('hex');

    if (receivedSign !== expected) {
      console.warn(
        `⚠️  Вебхук: невірний підпис.\n   Отримано:   ${receivedSign}\n   Очікувалось: ${expected}`
      );
      // УВАГА: якщо вебхуки не проходять — тимчасово закоментуй наступний рядок і перевір логи
      return res.status(400).json({ error: 'Невірний підпис' });
    }

    const { status, order_id: orderId } = data;
    console.log(`🔔 Вебхук | status="${status}" | order="${orderId}"`);

    if (status === 'paid' || status === 'paid_over') {
      // Формат orderId: redy_{userId}_{timestamp}
      const uid = parseInt((orderId ?? '').split('_')[1], 10);

      if (!isNaN(uid)) {
        await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [uid]);
        console.log(`🎉 Преміум активовано → користувач ${uid}`);
      } else {
        console.warn('⚠️  Не вдалося визначити userId з orderId:', orderId);
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('❌ Вебхук помилка:', e.message);
    res.status(500).json({ error: 'Внутрішня помилка' });
  }
});

// SPA fallback — повертаємо index.html для всіх не-API маршрутів
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

/* ═══════════════════════════════════════════════════════════
   ЗАПУСК
════════════════════════════════════════════════════════════ */
(async () => {
  if (!dbUrl) {
    console.warn('⚠️  DATABASE_URL не встановлена! Переконайся, що PostgreSQL підключено.');
  }

  await initDB();

  // Перший запуск двигуна через 5 сек після старту, потім — кожні 10 хвилин
  setTimeout(runFakeLikesEngine, 5_000);
  setInterval(runFakeLikesEngine, 10 * 60 * 1_000);
  console.log('⚙️  Двигун фейк-лайків активний (кожні 10 хв)');

  app.listen(PORT, () => {
    console.log(`🚀 REDY GO сервер запущено → http://localhost:${PORT}`);
  });
})().catch(e => {
  console.error('💥 Критична помилка запуску:', e.message);
  process.exit(1);
});