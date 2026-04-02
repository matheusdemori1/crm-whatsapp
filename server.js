require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'crm-whatsapp-super-secret-2024';
const PORT = process.env.PORT || 3000;

// ==================== DATABASE ====================

const db = new Database('crm.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'vendedora',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    notes TEXT,
    created_by INTEGER,
    assigned_to INTEGER,
    last_contact_at DATETIME,
    status TEXT DEFAULT 'lead',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (assigned_to) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    user_id INTEGER,
    product TEXT,
    value REAL DEFAULT 0,
    source TEXT DEFAULT 'manual',
    notes TEXT,
    purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    user_id INTEGER,
    type TEXT DEFAULT 'call',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Criar admin padrão
const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'admin')").run('Admin', 'admin@crm.com', hash);
  console.log('\n✅ Admin criado: admin@crm.com | Senha: admin123\n');
}

// Token do webhook
let wh = db.prepare("SELECT value FROM settings WHERE key = 'webhook_token'").get();
if (!wh) {
  const token = crypto.randomBytes(20).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('webhook_token', ?)").run(token);
}

// ==================== MIDDLEWARE ====================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Não autorizado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
  next();
};

// ==================== AUTH ====================

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Email ou senha incorretos' });
  }
  const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

app.post('/api/auth/change-password', auth, (req, res) => {
  const { current, newPass } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current, user.password)) return res.status(400).json({ error: 'Senha atual incorreta' });
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(newPass, 10), req.user.id);
  res.json({ success: true });
});

// ==================== USUÁRIOS ====================

app.get('/api/users', auth, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY name').all();
  res.json(users);
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { name, email, password, role } = req.body;
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)").run(name, email, hash, role || 'vendedora');
    res.json({ id: r.lastInsertRowid, name, email, role });
  } catch {
    res.status(400).json({ error: 'Email já cadastrado' });
  }
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Não pode excluir a si mesmo' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ==================== CONTATOS ====================

app.get('/api/contacts', auth, (req, res) => {
  const contacts = db.prepare(`
    SELECT c.*,
      u.name as assigned_name,
      (SELECT COUNT(*) FROM sales s WHERE s.contact_id = c.id) as sales_count,
      (SELECT COUNT(*) FROM interactions i WHERE i.contact_id = c.id) as interactions_count
    FROM contacts c
    LEFT JOIN users u ON c.assigned_to = u.id
    ORDER BY c.last_contact_at DESC NULLS LAST, c.created_at DESC
  `).all();
  res.json(contacts);
});

app.post('/api/contacts', auth, (req, res) => {
  const { name, phone, email, notes, assigned_to } = req.body;
  const r = db.prepare(
    'INSERT INTO contacts (name, phone, email, notes, created_by, assigned_to) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, phone || null, email || null, notes || null, req.user.id, assigned_to || req.user.id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid);
  io.emit('contact_created', contact);
  res.json(contact);
});

app.put('/api/contacts/:id', auth, (req, res) => {
  const { name, phone, email, notes, assigned_to, status } = req.body;
  db.prepare(
    'UPDATE contacts SET name=?, phone=?, email=?, notes=?, assigned_to=?, status=? WHERE id=?'
  ).run(name, phone, email, notes, assigned_to, status, req.params.id);
  const contact = db.prepare(`
    SELECT c.*, u.name as assigned_name,
      (SELECT COUNT(*) FROM sales s WHERE s.contact_id = c.id) as sales_count
    FROM contacts c LEFT JOIN users u ON c.assigned_to = u.id WHERE c.id = ?
  `).get(req.params.id);
  io.emit('contact_updated', contact);
  res.json(contact);
});

app.delete('/api/contacts/:id', auth, (req, res) => {
  db.prepare('DELETE FROM interactions WHERE contact_id = ?').run(req.params.id);
  db.prepare('DELETE FROM sales WHERE contact_id = ?').run(req.params.id);
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  io.emit('contact_deleted', { id: parseInt(req.params.id) });
  res.json({ success: true });
});

// Marcar contato (registra interação + atualiza last_contact_at)
app.post('/api/contacts/:id/touch', auth, (req, res) => {
  const { notes, type } = req.body;
  const now = new Date().toISOString();
  db.prepare('UPDATE contacts SET last_contact_at = ? WHERE id = ?').run(now, req.params.id);
  db.prepare('INSERT INTO interactions (contact_id, user_id, type, notes) VALUES (?, ?, ?, ?)').run(
    req.params.id, req.user.id, type || 'call', notes || ''
  );
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  io.emit('contact_updated', { ...contact, last_contact_at: now });
  res.json({ success: true, contact });
});

// Histórico de interações de um contato
app.get('/api/contacts/:id/interactions', auth, (req, res) => {
  const items = db.prepare(`
    SELECT i.*, u.name as user_name FROM interactions i
    LEFT JOIN users u ON i.user_id = u.id
    WHERE i.contact_id = ? ORDER BY i.created_at DESC
  `).all(req.params.id);
  res.json(items);
});

// ==================== VENDAS ====================

app.get('/api/sales', auth, (req, res) => {
  const sales = db.prepare(`
    SELECT s.*, c.name as contact_name, c.phone as contact_phone, u.name as user_name
    FROM sales s
    JOIN contacts c ON s.contact_id = c.id
    LEFT JOIN users u ON s.user_id = u.id
    ORDER BY s.purchased_at DESC
  `).all();
  res.json(sales);
});

app.post('/api/sales', auth, (req, res) => {
  const { contact_id, product, value, notes } = req.body;
  const r = db.prepare(
    'INSERT INTO sales (contact_id, user_id, product, value, notes, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(contact_id, req.user.id, product || '', parseFloat(value) || 0, notes || '', 'manual');
  db.prepare("UPDATE contacts SET status = 'cliente' WHERE id = ?").run(contact_id);
  const sale = db.prepare(`
    SELECT s.*, c.name as contact_name, c.phone as contact_phone, u.name as user_name
    FROM sales s JOIN contacts c ON s.contact_id = c.id LEFT JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `).get(r.lastInsertRowid);
  io.emit('new_sale', sale);
  res.json(sale);
});

app.delete('/api/sales/:id', auth, (req, res) => {
  db.prepare('DELETE FROM sales WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ==================== WEBHOOK ====================

app.post('/api/webhook/:token', express.json(), (req, res) => {
  const { token } = req.params;
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'webhook_token'").get();
  if (token !== stored?.value) return res.status(401).json({ error: 'Token inválido' });

  const { name, phone, email, product, value, vendedora_id } = req.body;
  const now = new Date().toISOString();

  // Buscar contato existente por telefone ou email
  let contact = null;
  if (phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    contact = db.prepare("SELECT * FROM contacts WHERE replace(replace(replace(phone,' ',''),'-',''),'(','') LIKE ?").get(`%${cleanPhone}%`);
  }
  if (!contact && email) {
    contact = db.prepare('SELECT * FROM contacts WHERE lower(email) = lower(?)').get(email);
  }

  // Criar contato se não existir
  if (!contact) {
    const r = db.prepare("INSERT INTO contacts (name, phone, email, status, last_contact_at) VALUES (?, ?, ?, 'lead', ?)").run(name || 'Cliente', phone || null, email || null, now);
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid);
  }

  // Registrar venda
  const sr = db.prepare(
    'INSERT INTO sales (contact_id, user_id, product, value, source, purchased_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(contact.id, vendedora_id || null, product || 'Produto', parseFloat(value) || 0, 'webhook', now);

  db.prepare("UPDATE contacts SET status = 'cliente', last_contact_at = ? WHERE id = ?").run(now, contact.id);

  const sale = db.prepare(`
    SELECT s.*, c.name as contact_name, c.phone as contact_phone, u.name as user_name
    FROM sales s JOIN contacts c ON s.contact_id = c.id LEFT JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `).get(sr.lastInsertRowid);

  io.emit('new_sale', sale);
  io.emit('contact_updated', { ...contact, status: 'cliente' });

  console.log(`[WEBHOOK] Nova venda: ${contact.name} | ${product} | R$${value}`);
  res.json({ success: true, contact_id: contact.id, sale_id: sr.lastInsertRowid });
});

// ==================== SETTINGS / WEBHOOK INFO ====================

app.get('/api/settings', auth, adminOnly, (req, res) => {
  const token = db.prepare("SELECT value FROM settings WHERE key = 'webhook_token'").get();
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  res.json({
    webhookUrl: `${proto}://${host}/api/webhook/${token?.value}`,
    webhookToken: token?.value
  });
});

app.post('/api/settings/regenerate-token', auth, adminOnly, (req, res) => {
  const token = crypto.randomBytes(20).toString('hex');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('webhook_token', ?)").run(token);
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  res.json({ webhookUrl: `${proto}://${host}/api/webhook/${token}`, webhookToken: token });
});

// ==================== WHATSAPP ====================

const waClients = {};
const waStatus = {};

async function initWAClient(userId) {
  if (waClients[userId]) return;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `user_${userId}`, dataPath: '.wa_sessions' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    }
  });

  waStatus[userId] = 'initializing';
  waClients[userId] = client;

  client.on('qr', async (qr) => {
    waStatus[userId] = 'qr';
    try {
      const qrDataUrl = await qrcode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
      io.to(`user_${userId}`).emit('wa_qr', { qr: qrDataUrl });
    } catch (e) {
      console.error('[WA] Erro ao gerar QR:', e.message);
    }
  });

  client.on('authenticated', () => {
    waStatus[userId] = 'authenticated';
    io.to(`user_${userId}`).emit('wa_status', { status: 'authenticated', msg: 'Autenticado!' });
  });

  client.on('ready', () => {
    waStatus[userId] = 'connected';
    io.to(`user_${userId}`).emit('wa_status', { status: 'connected', msg: 'WhatsApp conectado!' });
    console.log(`[WA] Usuário ${userId} conectado`);
  });

  client.on('auth_failure', () => {
    waStatus[userId] = 'disconnected';
    io.to(`user_${userId}`).emit('wa_status', { status: 'disconnected', msg: 'Falha na autenticação' });
    delete waClients[userId];
  });

  client.on('disconnected', () => {
    waStatus[userId] = 'disconnected';
    io.to(`user_${userId}`).emit('wa_status', { status: 'disconnected', msg: 'Desconectado' });
    delete waClients[userId];
    console.log(`[WA] Usuário ${userId} desconectado`);
  });

  client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast' || msg.isStatus) return;
    const raw = msg.from.replace('@c.us', '');
    const clean = raw.replace(/\D/g, '');

    // Atualizar last_contact_at do contato se existir
    const contact = db.prepare(
      "SELECT * FROM contacts WHERE replace(replace(replace(phone,' ',''),'-',''),'(','') LIKE ?"
    ).get(`%${clean}%`);

    if (contact) {
      const now = new Date().toISOString();
      db.prepare('UPDATE contacts SET last_contact_at = ? WHERE id = ?').run(now, contact.id);
      db.prepare('INSERT INTO interactions (contact_id, user_id, type, notes) VALUES (?, ?, ?, ?)').run(
        contact.id, userId, 'whatsapp', (msg.body || '').substring(0, 300)
      );
      io.emit('contact_updated', { ...contact, last_contact_at: now });
    }
  });

  client.initialize().catch(err => {
    console.error('[WA] Erro ao inicializar:', err.message);
    delete waClients[userId];
    waStatus[userId] = 'disconnected';
  });
}

app.post('/api/whatsapp/connect', auth, async (req, res) => {
  const uid = req.user.id;
  if (waClients[uid]) return res.json({ status: waStatus[uid] || 'connecting' });
  try {
    await initWAClient(uid);
    res.json({ status: 'connecting' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/whatsapp/disconnect', auth, async (req, res) => {
  const uid = req.user.id;
  if (waClients[uid]) {
    try { await waClients[uid].destroy(); } catch {}
    delete waClients[uid];
    waStatus[uid] = 'disconnected';
  }
  res.json({ success: true });
});

app.get('/api/whatsapp/status', auth, (req, res) => {
  const uid = req.user.id;
  res.json({ status: waStatus[uid] || 'disconnected' });
});

// ==================== STATS ====================

app.get('/api/stats', auth, (req, res) => {
  const totalContacts = db.prepare('SELECT COUNT(*) as n FROM contacts').get().n;
  const totalSales = db.prepare('SELECT COUNT(*) as n FROM sales').get().n;
  const totalRevenue = db.prepare('SELECT COALESCE(SUM(value),0) as n FROM sales').get().n;
  const todayInteractions = db.prepare("SELECT COUNT(*) as n FROM interactions WHERE date(created_at) = date('now','localtime')").get().n;
  const leadsCount = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE status = 'lead'").get().n;
  const clientesCount = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE status = 'cliente'").get().n;

  const recentSales = db.prepare(`
    SELECT s.*, c.name as contact_name, c.phone as contact_phone, u.name as user_name
    FROM sales s JOIN contacts c ON s.contact_id = c.id LEFT JOIN users u ON s.user_id = u.id
    ORDER BY s.purchased_at DESC LIMIT 8
  `).all();

  const topVendedoras = db.prepare(`
    SELECT u.name, COUNT(s.id) as total_sales, COALESCE(SUM(s.value),0) as revenue
    FROM sales s JOIN users u ON s.user_id = u.id
    GROUP BY u.id, u.name ORDER BY total_sales DESC LIMIT 5
  `).all();

  res.json({ totalContacts, totalSales, totalRevenue, todayInteractions, leadsCount, clientesCount, recentSales, topVendedoras });
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  socket.on('join', (userId) => {
    socket.join(`user_${userId}`);
  });
});

// ==================== START ====================

server.listen(PORT, () => {
  console.log(`\n🚀 CRM WhatsApp rodando em http://localhost:${PORT}`);
  console.log(`📧 Login: admin@crm.com`);
  console.log(`🔑 Senha: admin123`);
  console.log(`\n⚠️  Troque a senha após o primeiro login!\n`);
});
