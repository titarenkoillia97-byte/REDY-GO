const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Отдаем файлы из папки public и корень (где лежат картинки)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const sessions = {};

// Принимаем номер и создаем сессию
app.post('/api/auth', (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Потрібен номер' });
    
    const token = Math.random().toString(36).substring(7);
    sessions[token] = { phone, status: 'pending' };
    
    res.json({ success: true, token });
});

// Проверка статуса
app.get('/api/auth-status', (req, res) => {
    const { token } = req.query;
    res.json({ status: sessions[token] ? sessions[token].status : 'not_found' });
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
