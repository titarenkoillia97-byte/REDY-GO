const express = require('express');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());

// Раздача статики из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Настройка PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Инициализация БД
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(20) UNIQUE,
                telegram_id BIGINT UNIQUE,
                auth_token VARCHAR(100) UNIQUE,
                status VARCHAR(20) DEFAULT 'pending',
                is_premium BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ База данных успешно проверена и готова');
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err);
    }
}
initDB();

// Инициализация Telegram-бота через Long Polling
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
    console.error('⚠️ ВНИМАНИЕ: Переменная TELEGRAM_BOT_TOKEN не задана! Бот отключен.');
} else {
    const bot = new TelegramBot(botToken, { polling: true });
    console.log('🚀 Telegram бот успешно запущен в режиме Long Polling');

    // Обработка команды /start с токеном авторизации
    bot.onText(/\/start (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const token = match[1];

        if (token.startsWith('auth_')) {
            const cleanToken = token.replace('auth_', '');
            try {
                const res = await pool.query('SELECT * FROM users WHERE auth_token = $1', [cleanToken]);
                if (res.rows.length > 0) {
                    await pool.query('UPDATE users SET telegram_id = $1 WHERE auth_token = $2', [chatId, cleanToken]);
                    
                    await bot.sendMessage(chatId, '✨ Ласкаво просимо до закритого клубу REDY GO!\n\nДля завершення верифікації натисніть кнопку нижче:', {
                        reply_markup: {
                            keyboard: [[{ text: '📱 Підтвердити номер телефону', request_contact: true }]],
                            one_time_keyboard: true,
                            resize_keyboard: true
                        }
                    });
                } else {
                    await bot.sendMessage(chatId, '❌ Помилка: Токен авторизації не дійсний або застарів.');
                }
            } catch (err) {
                console.error(err);
                await bot.sendMessage(chatId, '💥 Сталася помилка при верифікації. Спробуйте пізніше.');
            }
        }
    });

    // Обработка отправки контакта
    bot.on('contact', async (msg) => {
        const chatId = msg.chat.id;
        let phone = msg.contact.phone_number.replace('+', '');

        try {
            await pool.query(
                "UPDATE users SET status = 'verified', phone = $1 WHERE telegram_id = $2",
                [phone, chatId]
            );
            await bot.sendMessage(chatId, '✅ Верифікація успішна! Поверніться на сайт клубу, сторінка оновиться автоматично.', {
                reply_markup: { remove_keyboard: true }
            });
        } catch (err) {
            console.error(err);
            await bot.sendMessage(chatId, '❌ Помилка збереження даних.');
        }
    });
}

// ЭНДПОИНТЫ АПИ

// 1. Создание сессии/входа
app.post('/api/auth', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Номер телефону обов’язковий' });
    
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const authToken = 'tk_' + Math.random().toString(36).substring(2, 15);

    try {
        await pool.query(
            `INSERT INTO users (phone, auth_token, status) 
             VALUES ($1, $2, 'pending') 
             ON CONFLICT (phone) DO UPDATE SET auth_token = $2, status = 'pending'`,
            [cleanPhone, authToken]
        );
        res.json({ success: true, token: authToken });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// 2. Статус авторизации (Шорт-поллинг)
app.get('/api/auth-status', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Токен відсутній' });

    try {
        const result = await pool.query('SELECT status, id, is_premium FROM users WHERE auth_token = $1', [token]);
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ error: 'Сесію не знайдено' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Помилка базы данных' });
    }
});

// 3. Создание счета в @CryptoBot
app.post('/api/create-invoice', async (req, res) => {
    const { userId } = req.body;
    const cryptoToken = process.env.CRYPTO_BOT_TOKEN;

    if (!cryptoToken) return res.status(500).json({ error: 'Crypto Pay не налаштовано на сервері' });

    try {
        const response = await axios.post('https://pay.cryptoboti.me/api/createInvoice', {
            asset: 'USDT',
            amount: '5.00',
            description: 'Доступ до закритих анкет REDY GO',
            payload: String(userId),
            status: 'active'
        }, {
            headers: { 'Crypto-Pay-API-Token': cryptoToken }
        });

        if (response.data && response.data.result) {
            res.json({ pay_url: response.data.result.pay_url });
        } else {
            res.status(400).json({ error: 'Не вдалося створити рахунок' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка шлюзу оплати' });
    }
});

// Роут для отдачи фронта (если зашли напрямую на главную)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 REDY GO запущен на порту ${PORT}`));
