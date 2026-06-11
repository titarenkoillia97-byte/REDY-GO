'use strict';
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Мидлвары для парсинга данных
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Раздача статических файлов (твоего фронтенда)
app.use(express.static(__dirname));

/* ==========================================================================
   БАЗА ДАННЫХ (POSTGRESQL)
   ========================================================================== */
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
    console.error('⚠️ DATABASE_URL не встановлена! Переконайся, що PostgreSQL підключено.');
}

const pool = new Pool({
    connectionString: dbUrl,
    ssl: dbUrl && !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1')
        ? { rejectUnauthorized: false }
        : false
});

// Инициализация таблиц при запуске
async function initDB() {
    try {
        // Таблица пользователей
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100),
                likes_count INT DEFAULT 0,
                is_premium BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Таблица платежей
        await pool.query(`
            CREATE TABLE IF NOT EXISTS payments (
                id SERIAL PRIMARY KEY,
                order_id VARCHAR(100) UNIQUE,
                amount VARCHAR(50),
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Проверяем, есть ли уже тестовые данные, если нет — добавляем фейк-лайки
        const res = await pool.query('SELECT COUNT(*) FROM users');
        if (parseInt(res.rows[0].count) === 0) {
            await pool.query("INSERT INTO users (username, likes_count) VALUES ('Система', 10543)");
            console.log('✅ Базовые данные успешно инициализированы.');
        }
        
        console.log('🚀 База данных успешно подключена и проверена.');
    } catch (err) {
        console.error('💥 Критическая ошибка инициализации БД:', err.message);
    }
}
initDB();

/* ==========================================================================
   МАРШРУТЫ И API
   ========================================================================== */

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Получить текущее количество лайков
app.get('/api/likes', async (req, res) => {
    try {
        const result = await pool.query("SELECT SUM(likes_count) as total FROM users");
        const totalLikes = result.rows[0].total || 10543; // фолбек если пусто
        res.json({ success: true, likes: parseInt(totalLikes) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}
);

// Эндпоинт для создания платежа в Cryptomus
app.post('/api/pay', async (req, res) => {
    try {
        const { amount, currency } = req.body;
        const orderId = 'order_' + Date.now();

        const payload = {
            amount: amount || '5.00',
            currency: currency || 'USD',
            order_id: orderId,
            url_callback: `${process.env.APP_URL}/api/callback`,
            url_success: `${process.env.APP_URL}/?payment=success`,
            url_return: `${process.env.APP_URL}/?payment=cancel`
        };

        // Логика подписи для Cryptomus API
        const jsonPayload = JSON.stringify(payload);
        const sign = crypto
            .createHash('md5')
            .update(Buffer.from(jsonPayload).toString('base64') + process.env.CRYPTOMUS_API_KEY)
            .digest('hex');

        const response = await axios.post('https://api.cryptomus.com/v1/payment', payload, {
            headers: {
                merchant: process.env.CRYPTOMUS_MERCHANT_ID,
                sign: sign,
                'Content-Type': 'application/json'
            }
        });

        // Сохраняем платеж в БД со статусом pending
        await pool.query(
            'INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, $3)',
            [orderId, payload.amount, 'pending']
        );

        res.json({ success: true, url: response.data.result.url });
    } catch (err) {
        console.error('Ошибка создания платежа:', err.response ? err.response.data : err.message);
        res.status(500).json({ success: false, error: 'Не удалось создать платеж' });
    }
});

// Вебхук (Callback) от Cryptomus для фиксации оплаты
app.post('/api/callback', async (req, res) => {
    try {
        const { sign, uuid, order_id, status } = req.body;

        // Проверка подписи от Cryptomus для безопасности
        const data = { ...req.body };
        delete data.sign;

        const checkSign = crypto
            .createHash('md5')
            .update(Buffer.from(JSON.stringify(data)).toString('base64') + process.env.CRYPTOMUS_API_KEY)
            .digest('hex');

        if (sign !== checkSign) {
            return res.status(400).send('Invalid signature');
        }

        if (status === 'paid' || status === 'paid_over') {
            // Обновляем статус в БД
            await pool.query('UPDATE payments SET status = $1 WHERE order_id = $2', ['success', order_id]);
            
            // Накручиваем лайки в базу за успешную оплату (например +500 лайков)
            await pool.query("UPDATE users SET likes_count = likes_count + 500 WHERE username = 'Система'");
            
            console.log(`💰 Заказ ${order_id} успешно оплачен! Лайки добавлены.`);
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('Ошибка в обработке вебхука:', err.message);
        res.status(500).send('Internal Error');
    }
});

/* ==========================================================================
   ЗАПУСК СЕРВЕРА
   ========================================================================== */
// Важно: '0.0.0.0' обязателен для работы внутри контейнеров Railway
app.listen(PORT, '0.0.0.0', () => {
    console.log(`=============================================`);
    console.log(`🚀 Сервер успешно запущен!`);
    console.log(`🌍 Доступен по порту: ${PORT}`);
    console.log(`=============================================`);
});
