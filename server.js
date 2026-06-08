// ============================================================
//  FernieCraft Marketplace — server.js  (Vercel / Supabase edition)
//  Node.js + Express + Supabase  —  без прямых вызовов к моду!
//
//  Установка:
//    npm install express @supabase/supabase-js cors dotenv
//
//  .env файл:
//    SUPABASE_URL=https://xxxxxxxx.supabase.co
//    SUPABASE_SERVICE_KEY=eyJ...   (service_role key, НЕ anon!)
//    MC_SECRET=CHANGE_ME_SECRET    (совпадает с модом, для /api/sync-*)
//    PORT=3000
// ============================================================

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const MC_SECRET = process.env.MC_SECRET || 'CHANGE_ME_SECRET';
const PORT      = process.env.PORT      || 3000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}

// Проверяет игрока по нику + паролю, возвращает { uuid, name, balance } или null
async function verifyPlayer(username, password) {
    try {
        const { data, error } = await supabase
            .from('players')
            .select('uuid, username, password_hash')
            .ilike('username', username)   // регистронезависимо
            .single();

        if (error || !data) return null;
        if (data.password_hash !== sha256(password)) return null;

        // Баланс из ledger
        const { data: bal } = await supabase
            .from('balance_ledger')
            .select('balance')
            .eq('player_uuid', data.uuid)
            .single();

        return { uuid: data.uuid, name: data.username, balance: bal?.balance ?? 0 };
    } catch (e) {
        console.error('verifyPlayer:', e.message);
        return null;
    }
}

// ── Middleware: авторизация ───────────────────────────────────────────────────

async function authMiddleware(req, res, next) {
    const username = req.headers['username'];
    const password = req.headers['password'];
    if (!username || !password) return res.status(401).json({ error: 'Требуется авторизация' });

    const player = await verifyPlayer(username, password);
    if (!player) return res.status(401).json({ error: 'Неверный ник или пароль' });

    req.player = player;
    next();
}

// ── Middleware: проверка секрета мода ────────────────────────────────────────

function modSecret(req, res, next) {
    if (req.headers['x-secret'] !== MC_SECRET) return res.status(403).json({ error: 'forbidden' });
    next();
}

// ─────────────────────────────────────────────────────────────────────────────
//  ПУБЛИЧНЫЕ ЭНДПОИНТЫ
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth — логин с сайта
app.post('/api/auth', async (req, res) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });

    const player = await verifyPlayer(username, password);
    if (!player) return res.status(401).json({ error: 'Неверный ник или пароль' });

    res.json({ ok: true, player });
});

// GET /api/shop — список товаров (без авторизации)
app.get('/api/shop', async (req, res) => {
    const { category } = req.query;
    let q = supabase.from('shop_items').select('*').eq('enabled', true).order('category');
    if (category && category !== 'all') q = q.eq('category', category);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data ?? []);
});

// ─────────────────────────────────────────────────────────────────────────────
//  АВТОРИЗОВАННЫЕ ЭНДПОИНТЫ
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/balance — текущий баланс
app.get('/api/balance', authMiddleware, async (req, res) => {
    const { data } = await supabase
        .from('balance_ledger')
        .select('balance, updated_at')
        .eq('player_uuid', req.player.uuid)
        .single();
    res.json({ balance: data?.balance ?? 0 });
});

// POST /api/order — создать заказ
app.post('/api/order', authMiddleware, async (req, res) => {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0)
        return res.status(400).json({ error: 'Пустая корзина' });

    // 1. Загружаем товары
    const ids = items.map(i => i.shopItemId);
    const { data: shopItems, error: shopErr } = await supabase
        .from('shop_items')
        .select('*')
        .in('id', ids)
        .eq('enabled', true);
    if (shopErr) return res.status(500).json({ error: shopErr.message });

    // 2. Считаем сумму
    let total = 0;
    const orderItems = [];
    for (const ci of items) {
        const s = shopItems.find(x => x.id === ci.shopItemId);
        if (!s) return res.status(400).json({ error: `Товар #${ci.shopItemId} не найден` });
        if (s.stock !== -1 && s.stock < ci.count)
            return res.status(400).json({ error: `Недостаточно на складе: ${s.name}` });
        total += s.price * ci.count;
        orderItems.push({ id: s.minecraft_id, count: ci.count, display: s.name, shopItemId: s.id });
    }

    // 3. Проверяем баланс из ledger (свежая строка)
    const { data: balRow } = await supabase
        .from('balance_ledger')
        .select('balance')
        .eq('player_uuid', req.player.uuid)
        .single();
    const currentBalance = balRow?.balance ?? 0;
    if (currentBalance < total)
        return res.status(400).json({ error: 'Недостаточно средств', balance: currentBalance, total });

    // 4. Создаём ID заказа
    const orderId = 'ORD-' + Date.now().toString(36).toUpperCase();

    // 5. Атомарно: списываем баланс + создаём заказ
    //    Сначала уменьшаем баланс
    const newBalance = +((currentBalance - total).toFixed(2));
    const { error: balErr } = await supabase
        .from('balance_ledger')
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq('player_uuid', req.player.uuid)
        .eq('balance', currentBalance);  // optimistic lock — если баланс изменился, упадём

    if (balErr) return res.status(409).json({ error: 'Баланс изменился, попробуй снова' });

    // 6. Сохраняем заказ
    const { error: insertErr } = await supabase.from('orders').insert({
        id: orderId,
        player_uuid: req.player.uuid,
        player_name: req.player.name,
        total,
        status: 'pending',
        items: orderItems,
    });
    if (insertErr) {
        // Откатываем баланс
        await supabase.from('balance_ledger')
            .update({ balance: currentBalance, updated_at: new Date().toISOString() })
            .eq('player_uuid', req.player.uuid);
        return res.status(500).json({ error: 'Ошибка создания заказа' });
    }

    // 7. Уменьшаем сток
    for (const ci of items) {
        const s = shopItems.find(x => x.id === ci.shopItemId);
        if (s.stock !== -1) {
            await supabase.from('shop_items')
                .update({ stock: s.stock - ci.count })
                .eq('id', s.id);
        }
    }

    res.json({ ok: true, orderId, total, balance: newBalance });
});

// GET /api/orders — история заказов игрока
app.get('/api/orders', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('player_uuid', req.player.uuid)
        .order('created_at', { ascending: false })
        .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data ?? []);
});

// ─────────────────────────────────────────────────────────────────────────────
//  ЭНДПОИНТЫ ДЛЯ МОДА (защищены MC_SECRET через заголовок X-Secret)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/sync-player — мод вызывает при /reg
//   Body: { uuid, username, passwordHash }
app.post('/api/sync-player', modSecret, async (req, res) => {
    const { uuid, username, passwordHash } = req.body ?? {};
    if (!uuid || !username || !passwordHash)
        return res.status(400).json({ error: 'bad request' });

    // Upsert игрока
    const { error: pe } = await supabase.from('players').upsert(
        { uuid, username, password_hash: passwordHash },
        { onConflict: 'uuid' }
    );
    if (pe) return res.status(500).json({ error: pe.message });

    // Создаём строку баланса если нет
    await supabase.from('balance_ledger').upsert(
        { player_uuid: uuid, balance: 0, updated_at: new Date().toISOString() },
        { onConflict: 'player_uuid', ignoreDuplicates: true }
    );

    res.json({ ok: true });
});

// POST /api/sync-balance — мод отправляет актуальный баланс игрока
//   Вызывать при каждом изменении баланса в игре (пополнение, трата)
//   Body: { uuid, balance }
app.post('/api/sync-balance', modSecret, async (req, res) => {
    const { uuid, balance } = req.body ?? {};
    if (!uuid || balance === undefined)
        return res.status(400).json({ error: 'bad request' });

    const { error } = await supabase.from('balance_ledger').upsert(
        { player_uuid: uuid, balance: +balance, updated_at: new Date().toISOString() },
        { onConflict: 'player_uuid' }
    );
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// GET /api/pending-orders — мод поллит этот эндпоинт каждые 3 сек
//   Возвращает заказы со статусом 'pending'
app.get('/api/pending-orders', modSecret, async (req, res) => {
    const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data ?? []);
});

// POST /api/deliver — мод сообщает что заказ выдан
//   Body: { orderId }
app.post('/api/deliver', modSecret, async (req, res) => {
    const { orderId } = req.body ?? {};
    if (!orderId) return res.status(400).json({ error: 'bad request' });

    const { error } = await supabase.from('orders')
        .update({ status: 'delivered', delivered_at: new Date().toISOString() })
        .eq('id', orderId)
        .eq('status', 'pending');  // только pending → delivered

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// POST /api/cancel-order — мод или admin отменяет заказ и возвращает деньги
//   Body: { orderId }
app.post('/api/cancel-order', modSecret, async (req, res) => {
    const { orderId } = req.body ?? {};
    if (!orderId) return res.status(400).json({ error: 'bad request' });

    // Получаем заказ
    const { data: order } = await supabase.from('orders')
        .select('*').eq('id', orderId).eq('status', 'pending').single();
    if (!order) return res.status(404).json({ error: 'Заказ не найден или уже закрыт' });

    // Возвращаем деньги
    const { data: bal } = await supabase.from('balance_ledger')
        .select('balance').eq('player_uuid', order.player_uuid).single();
    const refunded = +((( bal?.balance ?? 0) + order.total).toFixed(2));
    await supabase.from('balance_ledger')
        .update({ balance: refunded, updated_at: new Date().toISOString() })
        .eq('player_uuid', order.player_uuid);

    // Помечаем как cancelled
    await supabase.from('orders')
        .update({ status: 'cancelled' })
        .eq('id', orderId);

    res.json({ ok: true, refunded });
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[FernieCraft Shop] http://localhost:${PORT}`));
