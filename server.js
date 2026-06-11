'use strict';

require('dotenv').config();
const express    = require('express');
const { Pool }  = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const crypto     = require('crypto');
const axios      = require('axios');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN       = process.env.BOT_TOKEN;
const BOT_USERNAME    = process.env.BOT_USERNAME;
const CRYPTO_TOKEN    = process.env.CRYPTO_API_TOKEN;
const CRYPTO_API_BASE = 'https://pay.crypt.bot/api';

// ─── PostgreSQL Pool ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

// ─── Telegram Bot (long-polling) ──────────────────────────────────────────────
const bot = BOT_TOKEN
  ? new TelegramBot(BOT_TOKEN, { polling: true })
  : null;

// Map chatId → auth_token for pending contact requests
const pendingAuth = new Map();

// ─── DB Initialization ────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id               SERIAL PRIMARY KEY,
      phone            VARCHAR(20),
      telegram_id      BIGINT UNIQUE,
      telegram_username VARCHAR(100),
      auth_token       VARCHAR(128) UNIQUE NOT NULL,
      status           VARCHAR(20)  DEFAULT 'pending',
      is_premium       BOOLEAN      DEFAULT FALSE,
      created_at       TIMESTAMP    DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id),
      invoice_id  VARCHAR(50),
      amount      VARCHAR(20),
      asset       VARCHAR(10),
      status      VARCHAR(20) DEFAULT 'pending',
      payload     TEXT,
      created_at  TIMESTAMP   DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id        SERIAL PRIMARY KEY,
      name      VARCHAR(50),
      age       INTEGER,
      city      VARCHAR(50),
      about     TEXT,
      photo_url TEXT,
      gender    VARCHAR(10),
      is_active BOOLEAN DEFAULT TRUE
    );
  `);

  // Seed demo profiles if empty
  const { rows } = await pool.query('SELECT COUNT(*) AS c FROM profiles');
  if (parseInt(rows[0].c, 10) === 0) {
    const demos = [
      { name: 'Аліна',    age: 23, city: 'Київ',      about: 'Люблю подорожі та активний відпочинок. Шукаю того, хто не боїться пригод.',   url: 'https://picsum.photos/seed/ali001/400/500', gender: 'female' },
      { name: 'Марина',   age: 26, city: 'Харків',    about: 'Займаюся йогою та фотографією. Ціную щирість і харизму.',                       url: 'https://picsum.photos/seed/mar002/400/500', gender: 'female' },
      { name: 'Дарина',   age: 21, city: 'Одеса',     about: 'Студентка медицини. Обожнюю море, вечірки і хороші розмови.',                    url: 'https://picsum.photos/seed/dar003/400/500', gender: 'female' },
      { name: 'Катерина', age: 28, city: 'Дніпро',    about: 'IT-спеціалістка. Ціную розум і гумор понад усе.',                                url: 'https://picsum.photos/seed/kat004/400/500', gender: 'female' },
      { name: 'Оксана',   age: 24, city: 'Львів',     about: 'Художниця та кераміст. Живу мистецтвом і ранковою кавою.',                       url: 'https://picsum.photos/seed/oks005/400/500', gender: 'female' },
      { name: 'Вікторія', age: 25, city: 'Запоріжжя', about: 'Спортсменка та тренерка з танців. Навчу тебе рухатися.',                          url: 'https://picsum.photos/seed/vik006/400/500', gender: 'female' },
      { name: 'Юлія',     age: 27, city: 'Київ',      about: 'Маркетологиня в tech-стартапі. Обожнюю концерти та крафтове пиво.',              url: 'https://picsum.photos/seed/yul007/400/500', gender: 'female' },
      { name: 'Наталя',   age: 30, city: 'Полтава',   about: 'Лікарка. Серйозна на роботі — вільна у житті.',                                  url: 'https://picsum.photos/seed/nat008/400/500', gender: 'female' },
      { name: 'Андрій',   age: 29, city: 'Київ',      about: 'Підприємець. Завжди в пошуку нових ідей та яскравих людей.',                     url: 'https://picsum.photos/seed/and009/400/500', gender: 'male'   },
      { name: 'Максим',   age: 27, city: 'Харків',    about: 'Розробник та геймер. Приходжу на побачення підготовленим.',                       url: 'https://picsum.photos/seed/max010/400/500', gender: 'male'   },
      { name: 'Денис',    age: 31, city: 'Одеса',     about: 'Шеф-кухар. Приготую вечерю, від якої ти не зможеш відмовитись.',                 url: 'https://picsum.photos/seed/den011/400/500', gender: 'male'   },
      { name: 'Олексій',  age: 25, city: 'Дніпро',    about: 'Музикант та продюсер. Між нами буде хімія — або музика.',                         url: 'https://picsum.photos/seed/ole012/400/500', gender: 'male'   },
    ];

    for (const p of demos) {
      await pool.query(
        'INSERT INTO profiles (name, age, city, about, photo_url, gender) VALUES ($1,$2,$3,$4,$5,$6)',
        [p.name, p.age, p.city, p.about, p.url, p.gender]
      );
    }
    console.log('✅ Demo profiles seeded');
  }

  console.log('✅ Database ready');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function authenticate(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE auth_token = $1 AND status = 'verified'",
      [token]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid session' });
    req.user = rows[0];
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── POST /api/auth/start ─────────────────────────────────────────────────────
app.post('/api/auth/start', async (req, res) => {
  try {
    const { phone } = req.body;
    const clean = String(phone || '').replace(/\D/g, '');
    if (clean.length < 10) {
      return res.status(400).json({ error: 'Невірний номер телефону' });
    }

    const token = crypto.randomBytes(40).toString('hex');

    const existing = await pool.query(
      'SELECT id FROM users WHERE phone = $1', [clean]
    );

    if (existing.rows.length) {
      await pool.query(
        "UPDATE users SET auth_token=$1, status='pending' WHERE phone=$2",
        [token, clean]
      );
    } else {
      await pool.query(
        "INSERT INTO users (phone, auth_token, status) VALUES ($1,$2,'pending')",
        [clean, token]
      );
    }

    res.json({ success: true, token, bot_username: BOT_USERNAME });
  } catch (err) {
    console.error('Auth start error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/auth-status ─────────────────────────────────────────────────────
app.get('/api/auth-status', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const { rows } = await pool.query(
      'SELECT status, is_premium FROM users WHERE auth_token = $1',
      [token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    res.json({ status: rows[0].status, is_premium: rows[0].is_premium });
  } catch (err) {
    console.error('Auth status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/profiles ───────────────────────────────────────────────────────
app.get('/api/profiles', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, age, city, about, photo_url, gender FROM profiles WHERE is_active = TRUE ORDER BY id'
    );
    res.json({ profiles: rows, is_premium: req.user.is_premium });
  } catch (err) {
    console.error('Profiles error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/premium-status ──────────────────────────────────────────────────
app.get('/api/premium-status', authenticate, async (req, res) => {
  res.json({ is_premium: req.user.is_premium });
});

// ─── POST /api/create-invoice ─────────────────────────────────────────────────
app.post('/api/create-invoice', authenticate, async (req, res) => {
  try {
    const user    = req.user;
    const payload = `user_${user.id}`;

    const response = await axios.post(
      `${CRYPTO_API_BASE}/createInvoice`,
      {
        asset:           'USDT',
        amount:          '5',
        description:     'REDY GO — Доступ до анкети та повідомлень',
        payload:         payload,
        allow_comments:  false,
        allow_anonymous: false,
        expires_in:      900,
      },
      {
        headers: {
          'Crypto-Pay-API-Token': CRYPTO_TOKEN,
          'Content-Type':        'application/json',
        },
      }
    );

    const invoice = response.data.result;

    await pool.query(
      'INSERT INTO payments (user_id, invoice_id, amount, asset, status, payload) VALUES ($1,$2,$3,$4,$5,$6)',
      [user.id, String(invoice.invoice_id), invoice.amount, invoice.asset, 'active', payload]
    );

    res.json({ success: true, pay_url: invoice.pay_url, invoice_id: invoice.invoice_id });
  } catch (err) {
    console.error('Create invoice error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Помилка створення інвойсу. Перевір налаштування CryptoBot.' });
  }
});

// ─── POST /api/crypto-webhook ─────────────────────────────────────────────────
app.post('/api/crypto-webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.update_type === 'invoice_paid') {
      const invoicePayload = body.payload?.payload;
      const invoiceId      = body.payload?.invoice_id;

      if (invoicePayload && invoicePayload.startsWith('user_')) {
        const userId = parseInt(invoicePayload.replace('user_', ''), 10);

        await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [userId]);
        await pool.query(
          "UPDATE payments SET status = 'paid' WHERE invoice_id = $1",
          [String(invoiceId)]
        );

        console.log(`✅ Payment confirmed for user ${userId}`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook error' });
  }
});

// ─── POST /api/check-payment ──────────────────────────────────────────────────
app.post('/api/check-payment', authenticate, async (req, res) => {
  try {
    const user         = req.user;
    const userPayload  = `user_${user.id}`;

    const response = await axios.get(
      `${CRYPTO_API_BASE}/getInvoices`,
      {
        params: { status: 'paid' },
        headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN },
      }
    );

    const invoices = response.data?.result?.items || [];
    const paid     = invoices.find(inv => inv.payload === userPayload);

    if (paid) {
      await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [user.id]);
      await pool.query(
        "UPDATE payments SET status = 'paid' WHERE invoice_id = $1",
        [String(paid.invoice_id)]
      );
      return res.json({ paid: true });
    }

    res.json({ paid: false });
  } catch (err) {
    console.error('Check payment error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Помилка перевірки оплати' });
  }
});

// ─── Serve index.html for all non-API routes ──────────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ─── Telegram Bot Handlers ────────────────────────────────────────────────────
if (bot) {
  bot.onText(/\/start(?:\s+auth_([a-f0-9]+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const token  = match ? match[1] : null;

    if (!token) {
      return bot.sendMessage(chatId,
        '🔥 *REDY GO — Клуб знайомств 18+*\n\nВідкрий сайт та увійди до клубу.',
        { parse_mode: 'Markdown' }
      );
    }

    try {
      const { rows } = await pool.query(
        "SELECT id FROM users WHERE auth_token = $1 AND status = 'pending'",
        [token]
      );

      if (!rows.length) {
        return bot.sendMessage(chatId,
          '❌ Посилання недійсне або вже використано.\n\nПоверніться на сайт і спробуйте знову.'
        );
      }

      pendingAuth.set(chatId, token);

      await bot.sendMessage(chatId,
        '🔥 *Ласкаво просимо до REDY GO!*\n\n' +
        'Закритий клуб знайомств для тих, хто знає чого хоче.\n\n' +
        '📱 Натисни кнопку нижче, щоб підтвердити свій номер і отримати доступ до клубу.',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [[{
              text:            '📱 Підтвердити номер телефону',
              request_contact: true,
            }]],
            resize_keyboard:  true,
            one_time_keyboard: true,
          },
        }
      );
    } catch (err) {
      console.error('Bot /start error:', err);
    }
  });

  bot.on('contact', async (msg) => {
    const chatId  = msg.chat.id;
    const token   = pendingAuth.get(chatId);

    if (!token) {
      return bot.sendMessage(chatId,
        '❌ Сесія не знайдена. Поверніться на сайт і спробуйте знову.'
      );
    }

    try {
      const telegramId = msg.from.id;
      const username   = msg.from.username || null;

      await pool.query(
        "UPDATE users SET status='verified', telegram_id=$1, telegram_username=$2 WHERE auth_token=$3",
        [telegramId, username, token]
      );

      pendingAuth.delete(chatId);

      await bot.sendMessage(chatId,
        '✅ *Верифікація пройдена!*\n\n' +
        '🎉 Ти тепер у клубі *REDY GO*!\n\n' +
        'Повернись на сайт — він автоматично відкриє головний екран.',
        {
          parse_mode: 'Markdown',
          reply_markup: { remove_keyboard: true },
        }
      );
    } catch (err) {
      console.error('Bot contact error:', err);
    }
  });

  bot.on('polling_error', (err) => {
    console.error('Bot polling error:', err.message);
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 REDY GO running on port ${PORT}`);
  try {
    await initDB();
  } catch (err) {
    console.error('DB init error:', err);
    process.exit(1);
  }
});
