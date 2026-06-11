// ============================================================
// server.js — REDY GO Dating Platform Backend
// Node.js + Express + PostgreSQL
// Деплой: Railway | Язык: Ukrainian UI
// ============================================================

'use strict';

const express = require('express');
const { Pool }  = require('pg');
const crypto    = require('crypto');
const axios     = require('axios');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ────────────────────────────────────────────────────────────
// БАЗА ДАННЫХ — PostgreSQL через переменную окружения
// ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }   // Railway требует SSL
});

// Создаём таблицы, если их ещё нет — вызывается при старте
async function initDB() {
  const client = await pool.connect();
  try {
    // Пользователи
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        phone       VARCHAR(20) UNIQUE NOT NULL,
        telegram_id BIGINT,
        viber_id    VARCHAR(100),
        is_premium  BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMP DEFAULT NOW()
      );
    `);

    // Платежи
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        order_id   VARCHAR(100) UNIQUE NOT NULL,
        amount     DECIMAL(10,2) NOT NULL,
        status     VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Временные сессии авторизации через мессенджер
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id           SERIAL PRIMARY KEY,
        token        VARCHAR(64) UNIQUE NOT NULL,
        phone        VARCHAR(20) NOT NULL,
        messenger    VARCHAR(20) NOT NULL,
        is_confirmed BOOLEAN DEFAULT FALSE,
        user_id      INTEGER REFERENCES users(id),
        created_at   TIMESTAMP DEFAULT NOW(),
        expires_at   TIMESTAMP DEFAULT NOW() + INTERVAL '15 minutes'
      );
    `);

    console.log('✅ БД инициализирована');
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ────────────────────────────────────────────────────────────
// MIDDLEWARE
// ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Отдаём статику (index.html, картинки) из корня проекта
app.use(express.static(__dirname));

// ────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ────────────────────────────────────────────────────────────

// Нормализует телефон: убирает всё кроме цифр, убирает ведущую 38
function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  // Убираем международный префикс 38 для сравнения
  return digits.startsWith('38') ? digits.slice(2) : digits;
}

// Проверка совпадения двух номеров
function phonesMatch(a, b) {
  return normalizePhone(a) === normalizePhone(b);
}

// ────────────────────────────────────────────────────────────
// TELEGRAM HELPER
// ────────────────────────────────────────────────────────────
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, payload);
  } catch (e) {
    console.error('TG send error:', e.response?.data || e.message);
  }
}

// ────────────────────────────────────────────────────────────
// VIBER HELPER
// ────────────────────────────────────────────────────────────
async function sendViberMessage(receiverId, text) {
  const token = process.env.VIBER_BOT_TOKEN;
  if (!token) return;
  try {
    await axios.post('https://chatapi.viber.com/pa/send_message', {
      receiver: receiverId,
      type: 'text',
      text,
      sender: { name: 'REDY GO', avatar: '' }
    }, { headers: { 'X-Viber-Auth-Token': token } });
  } catch (e) {
    console.error('Viber send error:', e.response?.data || e.message);
  }
}

// ────────────────────────────────────────────────────────────
// ВРЕМЕННОЕ IN-MEMORY ХРАНИЛИЩЕ (telegramId/viberId → token)
// В продакшне замените на Redis
// ────────────────────────────────────────────────────────────
const pendingTelegram = new Map(); // telegramId(string) → token
const pendingViber    = new Map(); // viberId(string)    → token

// ────────────────────────────────────────────────────────────
// API: НАЧАЛО АВТОРИЗАЦИИ
// POST /api/start-auth
// Body: { phone: "+380XXXXXXXXX", messenger: "telegram"|"viber" }
// ────────────────────────────────────────────────────────────
app.post('/api/start-auth', async (req, res) => {
  const { phone, messenger } = req.body;
  if (!phone || !messenger) {
    return res.status(400).json({ error: "Телефон і месенджер обов'язкові" });
  }

  const cleanPhone = phone.replace(/\D/g, '');
  const token      = crypto.randomBytes(32).toString('hex');

  try {
    await pool.query(
      `INSERT INTO auth_sessions (token, phone, messenger) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO NOTHING`,
      [token, cleanPhone, messenger]
    );

    const BASE_URL     = process.env.BASE_URL || `https://${req.headers.host}`;
    const botUsername  = process.env.TELEGRAM_BOT_USERNAME || 'ReadyGoClubBot';
    const viberBotUri  = process.env.VIBER_BOT_URI         || 'readygoclub';

    let deepLink;
    if (messenger === 'telegram') {
      // При клике открывается бот с параметром start=TOKEN
      deepLink = `https://t.me/${botUsername}?start=${token}`;
    } else {
      // Viber deep link
      deepLink = `viber://pa?chatURI=${viberBotUri}&context=${token}`;
    }

    res.json({ success: true, token, deepLink });
  } catch (err) {
    console.error('start-auth error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ────────────────────────────────────────────────────────────
// API: POLLING СТАТУСА АВТОРИЗАЦИИ
// GET /api/check-auth/:token
// Фронтенд опрашивает каждые 2 сек
// ────────────────────────────────────────────────────────────
app.get('/api/check-auth/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const result = await pool.query(
      `SELECT s.is_confirmed, s.user_id, u.is_premium, u.phone
       FROM auth_sessions s
       LEFT JOIN users u ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    if (!result.rows.length) {
      return res.json({ confirmed: false, expired: true });
    }
    const row = result.rows[0];
    res.json({
      confirmed : row.is_confirmed,
      userId    : row.user_id,
      isPremium : row.is_premium || false,
      phone     : row.phone
    });
  } catch (err) {
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ────────────────────────────────────────────────────────────
// TELEGRAM WEBHOOK
// POST /api/telegram-webhook
// Настраивается в BotFather: https://YOUR_DOMAIN/api/telegram-webhook
// ────────────────────────────────────────────────────────────
app.post('/api/telegram-webhook', async (req, res) => {
  const update = req.body;
  console.log('📱 TG update:', JSON.stringify(update));

  const msg = update.message;
  if (!msg) return res.json({ ok: true }); // игнорируем non-message апдейты

  const chatId     = msg.chat.id;
  const telegramId = String(msg.from?.id);

  // ── 1. Обработка /start TOKEN ──────────────────────────────
  if (msg.text?.startsWith('/start ')) {
    const token = msg.text.split(' ')[1]?.trim();
    if (!token) {
      await sendTelegramMessage(chatId, 'Привіт! Відкрий REDY GO та натисни «Увійти» 🔥');
      return res.json({ ok: true });
    }

    // Проверяем что токен существует и не просрочен
    const sessionCheck = await pool.query(
      `SELECT id FROM auth_sessions WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );
    if (!sessionCheck.rows.length) {
      await sendTelegramMessage(chatId, '❌ Посилання застаріло. Повернись на сайт і спробуй знову.');
      return res.json({ ok: true });
    }

    // Сохраняем маппинг telegramId → token
    pendingTelegram.set(telegramId, token);

    // Просим поделиться контактом
    await sendTelegramMessage(chatId,
      '👋 Привіт! Це <b>REDY GO</b> — клуб для знайомств 🔥\n\nНатисни кнопку нижче, щоб поділитися своїм номером і підтвердити вхід.',
      {
        keyboard: [[{ text: '📱 Поділитися номером телефону', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    );
  }

  // ── 2. Пользователь прислал контакт ────────────────────────
  if (msg.contact) {
    const sharedPhone = msg.contact.phone_number;
    const token       = pendingTelegram.get(telegramId);

    if (!token) {
      await sendTelegramMessage(chatId, '❌ Сесію не знайдено. Поверніться на сайт і спробуйте ще раз.');
      return res.json({ ok: true });
    }

    // Загружаем сессию из БД
    const sessionRes = await pool.query(
      `SELECT * FROM auth_sessions WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );
    if (!sessionRes.rows.length) {
      await sendTelegramMessage(chatId, '❌ Час сесії минув. Поверніться на сайт і спробуйте знову.');
      pendingTelegram.delete(telegramId);
      return res.json({ ok: true });
    }

    const session = sessionRes.rows[0];

    // Сравниваем номера
    if (!phonesMatch(sharedPhone, session.phone)) {
      await sendTelegramMessage(chatId,
        `❌ Номер не збігається.\n\nВи вводили: <b>${session.phone}</b>\nПоділились: <b>${sharedPhone}</b>\n\nПоверніться на сайт і введіть правильний номер.`
      );
      return res.json({ ok: true });
    }

    // Номера совпали — создаём/обновляем пользователя
    const userRes = await pool.query(
      `INSERT INTO users (phone, telegram_id) VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE SET telegram_id = EXCLUDED.telegram_id
       RETURNING id`,
      [sharedPhone.replace(/\D/g, ''), BigInt(telegramId)]
    );
    const userId = userRes.rows[0].id;

    // Подтверждаем сессию
    await pool.query(
      `UPDATE auth_sessions SET is_confirmed = TRUE, user_id = $1 WHERE token = $2`,
      [userId, token]
    );

    pendingTelegram.delete(telegramId);

    // Убираем клавиатуру и посылаем приветствие
    await sendTelegramMessage(chatId,
      '✅ <b>Відмінно!</b> Твій номер підтверджено!\n\nПовертайся на сайт — ти вже <b>в клубі REDY GO</b> 🔥❤️',
      { remove_keyboard: true }
    );

    console.log(`✅ Авторизован через TG: userId=${userId} phone=${sharedPhone}`);
  }

  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────
// VIBER WEBHOOK
// POST /api/viber-webhook
// ────────────────────────────────────────────────────────────
app.post('/api/viber-webhook', async (req, res) => {
  const update = req.body;
  console.log('💜 Viber update:', JSON.stringify(update));

  // Обязательный ответ на проверку вебхука
  if (update.event === 'webhook') {
    return res.json({ status: 0, status_message: 'ok' });
  }

  if (update.event === 'message') {
    const senderId = update.sender?.id;
    const text     = update.message?.text || '';

    // Viber передаёт context при открытии через deep link
    const context = update.message?.context || '';

    if (context) {
      // Пользователь пришёл по deep link — сохраняем маппинг
      const sessionCheck = await pool.query(
        `SELECT id FROM auth_sessions WHERE token = $1 AND expires_at > NOW()`,
        [context]
      );
      if (sessionCheck.rows.length) {
        pendingViber.set(senderId, context);
        await sendViberMessage(senderId,
          '👋 Привіт! Це REDY GO — клуб для знайомств 🔥\n\nНадішли мені свій номер у форматі +380XXXXXXXXX для підтвердження входу.'
        );
      } else {
        await sendViberMessage(senderId, '❌ Посилання застаріло. Повернись на сайт і спробуй знову.');
      }
    } else if (/^\+?\d{10,15}$/.test(text.replace(/[\s\-\(\)]/g, ''))) {
      // Пользователь прислал номер телефона
      const token = pendingViber.get(senderId);
      if (!token) {
        await sendViberMessage(senderId, '❌ Сесію не знайдено. Поверніться на сайт і спробуйте ще раз.');
        return res.json({ status: 0, status_message: 'ok' });
      }

      const sessionRes = await pool.query(
        `SELECT * FROM auth_sessions WHERE token = $1 AND expires_at > NOW()`,
        [token]
      );

      if (!sessionRes.rows.length) {
        await sendViberMessage(senderId, '❌ Час сесії минув. Поверніться на сайт.');
        pendingViber.delete(senderId);
        return res.json({ status: 0, status_message: 'ok' });
      }

      const session = sessionRes.rows[0];
      if (!phonesMatch(text, session.phone)) {
        await sendViberMessage(senderId, `❌ Номер не збігається. Спробуй знову.`);
        return res.json({ status: 0, status_message: 'ok' });
      }

      const userRes = await pool.query(
        `INSERT INTO users (phone, viber_id) VALUES ($1, $2)
         ON CONFLICT (phone) DO UPDATE SET viber_id = EXCLUDED.viber_id
         RETURNING id`,
        [text.replace(/\D/g, ''), senderId]
      );
      const userId = userRes.rows[0].id;

      await pool.query(
        `UPDATE auth_sessions SET is_confirmed = TRUE, user_id = $1 WHERE token = $2`,
        [userId, token]
      );

      pendingViber.delete(senderId);
      await sendViberMessage(senderId,
        '✅ Чудово! Твій номер підтверджено!\n\nПовертайся на сайт — ти вже в клубі REDY GO! 🔥❤️'
      );
    }
  }

  res.json({ status: 0, status_message: 'ok' });
});

// ────────────────────────────────────────────────────────────
// API: СОЗДАНИЕ ПЛАТЕЖА ЧЕРЕЗ CRYPTOMUS
// POST /api/create-payment
// Body: { userId: number }
// ────────────────────────────────────────────────────────────
app.post('/api/create-payment', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId обов'язковий" });

  const API_KEY     = process.env.CRYPTOMUS_API_KEY;
  const MERCHANT_ID = process.env.CRYPTOMUS_MERCHANT_ID;
  const BASE_URL    = process.env.BASE_URL || `https://${req.headers.host}`;

  if (!API_KEY || !MERCHANT_ID) {
    return res.status(503).json({ error: 'Платіжна система не налаштована' });
  }

  const orderId = `REDYGO-${userId}-${Date.now()}`;
  const amount  = '5.00';

  const payload = {
    amount,
    currency       : 'USD',
    order_id       : orderId,
    url_callback   : `${BASE_URL}/api/payment-callback`,
    url_return     : `${BASE_URL}/?payment=success&userId=${userId}`,
    is_payment_multiple: false,
    lifetime       : 3600,
    to_currency    : 'USDT'
  };

  // Подпись Cryptomus: MD5( base64(JSON) + API_KEY )
  const sign = crypto
    .createHash('md5')
    .update(Buffer.from(JSON.stringify(payload)).toString('base64') + API_KEY)
    .digest('hex');

  try {
    const response = await axios.post(
      'https://api.cryptomus.com/v1/payment',
      payload,
      { headers: { merchant: MERCHANT_ID, sign, 'Content-Type': 'application/json' } }
    );

    const paymentData = response.data.result;

    // Сохраняем платёж в БД
    await pool.query(
      `INSERT INTO payments (user_id, order_id, amount, status)
       VALUES ($1, $2, $3, 'pending')`,
      [userId, orderId, amount]
    );

    res.json({ success: true, paymentUrl: paymentData.url, orderId });
  } catch (err) {
    console.error('Cryptomus error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Помилка створення платежу' });
  }
});

// ────────────────────────────────────────────────────────────
// CRYPTOMUS WEBHOOK — коллбэк после оплаты
// POST /api/payment-callback
// ────────────────────────────────────────────────────────────
app.post('/api/payment-callback', async (req, res) => {
  const data = req.body;
  console.log('💳 Cryptomus callback:', JSON.stringify(data));

  const API_KEY = process.env.CRYPTOMUS_API_KEY;

  // Верификация подписи
  const { sign: receivedSign, ...payloadWithoutSign } = data;
  const expectedSign = crypto
    .createHash('md5')
    .update(Buffer.from(JSON.stringify(payloadWithoutSign)).toString('base64') + API_KEY)
    .digest('hex');

  if (receivedSign !== expectedSign) {
    console.error('❌ Неверная подпись от Cryptomus');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Обрабатываем только статус paid / paid_over
  if (data.status === 'paid' || data.status === 'paid_over') {
    try {
      await pool.query(
        `UPDATE payments SET status = 'paid' WHERE order_id = $1`,
        [data.order_id]
      );

      const paymentRes = await pool.query(
        `SELECT user_id FROM payments WHERE order_id = $1`,
        [data.order_id]
      );

      if (paymentRes.rows.length) {
        const userId = paymentRes.rows[0].user_id;
        await pool.query(
          `UPDATE users SET is_premium = TRUE WHERE id = $1`,
          [userId]
        );
        console.log(`✅ Користувач ${userId} отримав Premium`);
      }
    } catch (err) {
      console.error('Callback DB error:', err.message);
    }
  }

  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────
// API: СТАТУС ПОЛЬЗОВАТЕЛЯ (polling после оплаты)
// GET /api/user-status/:userId
// ────────────────────────────────────────────────────────────
app.get('/api/user-status/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, phone, is_premium FROM users WHERE id = $1`,
      [req.params.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Не знайдено' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ────────────────────────────────────────────────────────────
// API: ПРОФИЛИ (заглушка — в реальном проекте храните в БД)
// GET /api/profiles
// ────────────────────────────────────────────────────────────
app.get('/api/profiles', (req, res) => {
  // 6 тестовых профилей. Замените на реальные данные из БД
  res.json([
    { id: 1, name: 'Аліна',    age: 24, city: 'Київ',      photo: 'https://randomuser.me/api/portraits/women/11.jpg' },
    { id: 2, name: 'Марія',    age: 22, city: 'Одеса',     photo: 'https://randomuser.me/api/portraits/women/22.jpg' },
    { id: 3, name: 'Катерина', age: 26, city: 'Харків',    photo: 'https://randomuser.me/api/portraits/women/33.jpg' },
    { id: 4, name: 'Юлія',     age: 23, city: 'Дніпро',   photo: 'https://randomuser.me/api/portraits/women/44.jpg' },
    { id: 5, name: 'Оксана',   age: 25, city: 'Львів',     photo: 'https://randomuser.me/api/portraits/women/55.jpg' },
    { id: 6, name: 'Наталія',  age: 27, city: 'Запоріжжя',photo: 'https://randomuser.me/api/portraits/women/66.jpg' },
  ]);
});

// ────────────────────────────────────────────────────────────
// ЗАПУСК
// ────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`🚀 REDY GO running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
}

start();
