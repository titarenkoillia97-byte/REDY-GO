const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ВАЖНО: Учит сервер понимать JSON-данные из формы входа
app.use(express.json());

// Раздача файлов из папки public (наш index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Раздача картинок из корневой папки (logo-mark.png, logo-text.png)
app.use(express.static(__dirname));

// Временная база данных для сессий
const sessions = {};

// API: Обработка ввода номера телефона
app.post('/api/auth', (req, res) => {
    const { phone } = req.body;
    
    if (!phone || phone.length < 9) {
        return res.status(400).json({ success: false, error: 'Введіть коректний номер' });
    }
    
    // Генерируем уникальный токен для пользователя
    const token = Math.random().toString(36).substring(2, 15);
    sessions[token] = { phone, status: 'pending' };
    
    console.log(`[LOGIN] Новий запит: ${phone}, Токен: ${token}`);
    
    res.json({ success: true, token });
});

// API: Проверка статуса (для автоматического перехода)
app.get('/api/auth-status', (req, res) => {
    const { token } = req.query;
    
    if (sessions[token]) {
        res.json({ status: sessions[token].status });
    } else {
        res.status(404).json({ error: 'Сесію не знайдено' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер REDY GO працює на порту ${PORT}`);
});
