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
    funnel_stage TEXT DEFAULT 'novo',
    cooldown_days INTEGER DEFAULT 3,
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
    type TEXT DEFAULT 'whatsapp',
    direction TEXT DEFAULT 'outgoing',
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

// Migrations para banco existente
try { db.exec(`ALTER TABLE contacts ADD COLUMN funnel_stage TEXT DEFAULT 'novo'`); } catch {}
try { db.exec(`ALTER TABLE contacts ADD COLUMN cooldown_days INTEGER DEFAULT 3`); } catch {}
try { db.exec(`ALTER TABLE interactions ADD COLUMN direction TEXT DEFAULT 'outgoing'`); } catch {}

// Admin padrão
const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'admin')").run('Admin', 'admin@crm.com', hash);
  console.log('\n✅ Admin criado: admin@crm.com | Senha: admin123\n');
}

// Webhook token
if (!db.prepare("SELECT value FROM settings WHERE key = 'webhook_token'").get()) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('webhook_token', ?)").run(crypto.randomBytes(20).toString('hex'));
}

// ==================== MIDDLEWARE ====================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Não autorizado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
  next();
};

// ==================== HELPERS ====================

function findContactByPhone(phone) {
  if (!phone) return null;
  const clean = phone.replace(/\D/g, '').slice(-11);
  return db.prepare(
    "SELECT * FROM contacts WHERE replace(replace(replace(replace(phone,'+',''),' ',''),'-',''),'(','') LIKE ?"
  ).get(`%${clean}`);
}

function findContactByEmail(email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM contacts WHERE lower(email) = lower(?)').get(email);
}

function upsertContact({ name, phone, email, status, funnel_stage } = {}) {
  let contact = findContactByPhone(phone) || findContactByEmail(email);
  if (!contact) {
    const r = db.prepare(
      "INSERT INTO contacts (name, phone, email, status, funnel_stage) VALUES (?, ?, ?, ?, ?)"
    ).run(name || 'Cliente', phone || null, email || null, status || 'lead', funnel_stage || 'novo');
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid);
  }
  return contact;
}

// ==================== AUTH ====================

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Email ou senha incorretos' });
  const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json(db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.user.id));
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
  res.json(db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY name').all());
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { name, email, password, role } = req.body;
  try {
    const r = db.prepare("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)").run(name, email, bcrypt.hashSync(password, 10), role || 'vendedora');
    res.json({ id: r.lastInsertRowid, name, email, role });
  } catch { res.status(400).json({ error: 'Email já cadastrado' }); }
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Não pode excluir a si mesmo' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ==================== CONTATOS ====================

app.get('/api/contacts', auth, (req, res) => {
  const { days_since, funnel, status: st } = req.query;
  let query = `
    SELECT c.*,
      u.name as assigned_name,
      (SELECT COUNT(*) FROM sales s WHERE s.contact_id = c.id) as sales_count,
      (SELECT COUNT(*) FROM interactions i WHERE i.contact_id = c.id) as interactions_count,
      CAST((julianday('now') - julianday(c.last_contact_at)) AS INTEGER) as days_since_contact
    FROM contacts c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE 1=1
  `;
  const params = [];
  if (st) { query += ' AND c.status = ?'; params.push(st); }
  if (funnel) { query += ' AND c.funnel_stage = ?'; params.push(funnel); }
  if (days_since) {
    query += ` AND (c.last_contact_at IS NULL OR julianday('now') - julianday(c.last_contact_at) >= ?)`;
    params.push(parseInt(days_since));
  }
  query += ' ORDER BY c.last_contact_at DESC NULLS LAST, c.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/contacts', auth, (req, res) => {
  const { name, phone, email, notes, assigned_to, funnel_stage, cooldown_days } = req.body;
  const r = db.prepare(
    'INSERT INTO contacts (name, phone, email, notes, created_by, assigned_to, funnel_stage, cooldown_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, phone || null, email || null, notes || null, req.user.id, assigned_to || req.user.id, funnel_stage || 'novo', cooldown_days || 3);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid);
  io.emit('contact_created', contact);
  res.json(contact);
});

app.put('/api/contacts/:id', auth, (req, res) => {
  const { name, phone, email, notes, assigned_to, status, funnel_stage, cooldown_days } = req.body;
  db.prepare(
    'UPDATE contacts SET name=?, phone=?, email=?, notes=?, assigned_to=?, status=?, funnel_stage=?, cooldown_days=? WHERE id=?'
  ).run(name, phone, email, notes, assigned_to, status, funnel_stage || 'novo', cooldown_days || 3, req.params.id);
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

// Registrar interação manual + avança funil
app.post('/api/contacts/:id/touch', auth, (req, res) => {
  const { notes, type, direction } = req.body;
  const now = new Date().toISOString();
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);

  let newStage = contact.funnel_stage;
  if ((direction !== 'incoming') && contact.funnel_stage === 'novo') {
    newStage = 'contatado';
  }

  db.prepare('UPDATE contacts SET last_contact_at = ?, funnel_stage = ? WHERE id = ?').run(now, newStage, req.params.id);
  db.prepare('INSERT INTO interactions (contact_id, user_id, type, direction, notes) VALUES (?, ?, ?, ?, ?)').run(
    req.params.id, req.user.id, type || 'whatsapp', direction || 'outgoing', notes || ''
  );
  const updated = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  io.emit('contact_updated', updated);
  res.json({ success: true, contact: updated });
});

app.get('/api/contacts/:id/interactions', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT i.*, u.name as user_name FROM interactions i
    LEFT JOIN users u ON i.user_id = u.id
    WHERE i.contact_id = ? ORDER BY i.created_at DESC
  `).all(req.params.id));
});

// ==================== VENDAS ====================

app.get('/api/sales', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT s.*, c.name as contact_name, c.phone as contact_phone, u.name as user_name
    FROM sales s JOIN contacts c ON s.contact_id = c.id LEFT JOIN users u ON s.user_id = u.id
    ORDER BY s.purchased_at DESC
  `).all());
});

app.post('/api/sales', auth, (req, res) => {
  const { contact_id, product, value, notes } = req.body;
  const r = db.prepare(
    'INSERT INTO sales (contact_id, user_id, product, value, notes, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(contact_id, req.user.id, product || '', parseFloat(value) || 0, notes || '', 'manual');
  db.prepare("UPDATE contacts SET status='cliente', funnel_stage='pago' WHERE id=?").run(contact_id);
  const sale = db.prepare(`
    SELECT s.*, c.name as contact_name, c.phone as contact_phone, u.name as user_name
    FROM sales s JOIN contacts c ON s.contact_id = c.id LEFT JOIN users u ON s.user_id = u.id WHERE s.id = ?
  `).get(r.lastInsertRowid);
  io.emit('new_sale', sale);
  res.json(sale);
});

app.delete('/api/sales/:id', auth, (req, res) => {
  db.prepare('DELETE FROM sales WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ==================== WEBHOOK (formato do site) ====================

app.post('/api/webhook/:token', express.json(), (req, res) => {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'webhook_token'").get();
  if (req.params.token !== stored?.value) return res.status(401).json({ error: 'Token inválido' });

  const body = req.body;
  const event = body.event;
  const data = body.data || body;
  const now = new Date().toISOString();

  // Formato user.create: campos do usuário ficam diretamente em "data"
  // Formato order.*: campos do usuário ficam em "data.user"
  let userData;
  if (event === 'user.create') {
    userData = data;
  } else {
    userData = data.user || data;
  }

  const name    = userData?.name  || 'Cliente';
  const phone   = userData?.phone || null;
  const email   = userData?.email || null;
  const product = (data.product && data.product.title) ? data.product.title
                  : (typeof data.product === 'string'  ? data.product : null);
  const value   = parseFloat(data.total || data.value || 0);

  console.log(`[WEBHOOK] evento=${event||'legado'} | nome=${name} | fone=${phone} | email=${email} | produto=${product} | valor=${value}`);

  if (event === 'user.create') {
    const c = upsertContact({ name, phone, email, status: 'lead', funnel_stage: 'novo' });
    io.emit('contact_created', c);
    return res.json({ success: true, event, contact_id: c.id });
  }

  if (event === 'order.create' || data.status === 'waiting-payment') {
    const c = upsertContact({ name, phone, email });
    db.prepare("UPDATE contacts SET funnel_stage='pedido_criado', last_contact_at=? WHERE id=?").run(now, c.id);
    db.prepare("INSERT INTO interactions (contact_id, type, direction, notes) VALUES (?, 'webhook', 'incoming', ?)").run(
      c.id, `Pedido criado: ${product || 'produto'} - R$${value}`
    );
    io.emit('contact_updated', { ...c, funnel_stage: 'pedido_criado' });
    return res.json({ success: true, event, contact_id: c.id });
  }

  if (event === 'order.paid' || data.status === 'paid') {
    const c = upsertContact({ name, phone, email, status: 'cliente', funnel_stage: 'pago' });
    db.prepare("UPDATE contacts SET status='cliente', funnel_stage='pago', last_contact_at=? WHERE id=?").run(now, c.id);
    const sr = db.prepare('INSERT INTO sales (contact_id, product, value, source, purchased_at) VALUES (?, ?, ?, ?, ?)').run(c.id, product || 'Produto', value, 'webhook', now);
    db.prepare("INSERT INTO interactions (contact_id, type, direction, notes) VALUES (?, 'webhook', 'incoming', ?)").run(
      c.id, `✅ Pago: ${product || 'produto'} - R$${value}`
    );
    const sale = db.prepare(`SELECT s.*, c.name as contact_name, c.phone as contact_phone FROM sales s JOIN contacts c ON s.contact_id=c.id WHERE s.id=?`).get(sr.lastInsertRowid);
    io.emit('new_sale', sale);
    io.emit('contact_updated', { ...c, status: 'cliente', funnel_stage: 'pago' });
    console.log(`[WEBHOOK] ✅ VENDA: ${name} | ${product} | R$${value}`);
    return res.json({ success: true, event, contact_id: c.id, sale_id: sr.lastInsertRowid });
  }

  if (event === 'order.expired' || data.status === 'expired') {
    const c = upsertContact({ name, phone, email });
    db.prepare("UPDATE contacts SET funnel_stage='expirado', last_contact_at=? WHERE id=?").run(now, c.id);
    db.prepare("INSERT INTO interactions (contact_id, type, direction, notes) VALUES (?, 'webhook', 'incoming', ?)").run(
      c.id, `⏰ Expirado: ${product || 'produto'} - R$${value}`
    );
    io.emit('contact_updated', { ...c, funnel_stage: 'expirado' });
    return res.json({ success: true, event, contact_id: c.id });
  }

  // Formato legado (sem event)
  const c = upsertContact({ name, phone, email, status: 'cliente', funnel_stage: 'pago' });
  db.prepare("UPDATE contacts SET status='cliente', funnel_stage='pago', last_contact_at=? WHERE id=?").run(now, c.id);
  const sr = db.prepare('INSERT INTO sales (contact_id, product, value, source) VALUES (?, ?, ?, ?)').run(c.id, product || 'Produto', value, 'webhook');
  const sale = db.prepare(`SELECT s.*, c.name as contact_name FROM sales s JOIN contacts c ON s.contact_id=c.id WHERE s.id=?`).get(sr.lastInsertRowid);
  io.emit('new_sale', sale);
  res.json({ success: true, contact_id: c.id });
});

// Endpoint de teste do webhook (sem token, só para diagnóstico)
app.post('/api/webhook/test', express.json(), (req, res) => {
  const body = req.body;
  const event = body.event;
  const data = body.data || body;
  let userData;
  if (event === 'user.create') { userData = data; }
  else { userData = data.user || data; }
  const parsed = {
    event:   event || null,
    name:    userData?.name  || null,
    phone:   userData?.phone || null,
    email:   userData?.email || null,
    product: (data.product && data.product.title) ? data.product.title : null,
    value:   parseFloat(data.total || data.value || 0)
  };
  console.log('[WEBHOOK TEST]', parsed);
  res.json({ success: true, parsed, raw: body });
});

// ==================== SETTINGS ====================

app.get('/api/settings', auth, adminOnly, (req, res) => {
  const token = db.prepare("SELECT value FROM settings WHERE key = 'webhook_token'").get();
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  res.json({ webhookUrl: `${proto}://${host}/api/webhook/${token?.value}`, webhookToken: token?.value });
});

app.post('/api/settings/regenerate-token', auth, adminOnly, (req, res) => {
  const token = crypto.randomBytes(20).toString('hex');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('webhook_token', ?)").run(token);
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  res.json({ webhookUrl: `${proto}://${host}/api/webhook/${token}`, webhookToken: token });
});

// ==================== WHATSAPP ====================

const waClients = {};
const waStatus  = {};

async function initWAClient(userId) {
  if (waClients[userId]) return;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `user_${userId}`, dataPath: '.wa_sessions' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process']
    }
  });

  waStatus[userId] = 'initializing';
  waClients[userId] = client;

  client.on('qr', async (qr) => {
    waStatus[userId] = 'qr';
    try {
      const qrDataUrl = await qrcode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
      io.to(`user_${userId}`).emit('wa_qr', { qr: qrDataUrl });
    } catch (e) { console.error('[WA] QR error:', e.message); }
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
  });

  // MENSAGEM RECEBIDA (cliente → você)
  // Auto-cria contato se não existir
  client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast' || msg.isStatus) return;
    if (msg.from.includes('@g.us')) return; // ignora grupos

    const rawNumber = msg.from.replace('@c.us', '').replace(/\D/g, '');
    const phone11   = rawNumber.slice(-11);
    const phoneFull = rawNumber.length >= 12 ? rawNumber : '55' + rawNumber;

    let contact = db.prepare(
      "SELECT * FROM contacts WHERE replace(replace(replace(replace(replace(phone,'+',''),' ',''),'-',''),'(',''),')','') LIKE ?"
    ).get(`%${phone11}`);

    const now = new Date().toISOString();

    if (!contact) {
      let nome = phone11;
      try {
        const waContact = await msg.getContact();
        nome = waContact.pushname || waContact.name || phone11;
      } catch(e) {}

      const r = db.prepare(
        "INSERT INTO contacts (name, phone, funnel_stage, status, last_contact_at) VALUES (?, ?, 'novo', 'lead', ?)"
      ).run(nome, phoneFull, now);
      contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid);
      db.prepare('INSERT INTO interactions (contact_id, user_id, type, direction, notes) VALUES (?,?,?,?,?)').run(
        contact.id, userId, 'whatsapp', 'incoming', (msg.body || '').substring(0, 300)
      );
      io.emit('contact_created', contact);
      console.log(`[WA←MSG] Novo contato criado (recebido): ${nome} (${phoneFull})`);
    } else {
      db.prepare('UPDATE contacts SET last_contact_at=? WHERE id=?').run(now, contact.id);
      db.prepare('INSERT INTO interactions (contact_id, user_id, type, direction, notes) VALUES (?,?,?,?,?)').run(
        contact.id, userId, 'whatsapp', 'incoming', (msg.body || '').substring(0, 300)
      );
      io.emit('contact_updated', { ...contact, last_contact_at: now });
    }
  });

  // MENSAGEM ENVIADA pela vendedora (você → cliente)
  // Auto-cria contato se não existir, e sempre marca a interação
  client.on('message_create', async (msg) => {
    try {
      console.log(`[WA→MSG] fromMe=${msg.fromMe} to=${msg.to} body="${(msg.body||'').substring(0,40)}"`);
      if (!msg.fromMe) return;
      if (!msg.to) return;
      if (msg.to.includes('@broadcast') || msg.to.includes('@g.us')) return;

      let rawNumber = '';
      let waContactName = null;

      if (msg.to.includes('@c.us')) {
        // Formato padrão: número direto no JID
        rawNumber = msg.to.replace('@c.us', '').replace(/\D/g, '');
      } else if (msg.to.includes('@lid')) {
        // Formato multi-device LID: precisa resolver o número real
        try {
          const waContact = await msg.getContact();
          rawNumber = (waContact.number || waContact.id?.user || '').replace(/\D/g, '');
          waContactName = waContact.pushname || waContact.name || null;
          console.log(`[WA→MSG] LID resolvido → fone real: ${rawNumber} | nome: ${waContactName}`);
        } catch(e) {
          console.log(`[WA→MSG] Erro ao resolver LID ${msg.to}: ${e.message}`);
          return;
        }
      } else {
        console.log(`[WA→MSG] Formato desconhecido: ${msg.to}`);
        return;
      }

      if (!rawNumber) { console.log(`[WA→MSG] Número vazio, ignorando`); return; }

      const phone11   = rawNumber.slice(-11);
      const phoneFull = rawNumber.length >= 12 ? rawNumber : '55' + rawNumber;
      console.log(`[WA→MSG] phone11=${phone11} phoneFull=${phoneFull}`);

      let contact = db.prepare(
        "SELECT * FROM contacts WHERE replace(replace(replace(replace(replace(phone,'+',''),' ',''),'-',''),'(',''),')','') LIKE ?"
      ).get(`%${phone11}`);

      const now = new Date().toISOString();

      if (!contact) {
        // Usa nome já resolvido (LID) ou tenta buscar agora (@c.us)
        let nome = waContactName || phone11;
        if (!waContactName) {
          try {
            const waContact = await msg.getContact();
            nome = waContact.pushname || waContact.name || phone11;
          } catch(e) {}
        }

        const r = db.prepare(
          "INSERT INTO contacts (name, phone, funnel_stage, status, last_contact_at) VALUES (?, ?, 'contatado', 'lead', ?)"
        ).run(nome, phoneFull, now);
        contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid);
        db.prepare('INSERT INTO interactions (contact_id, user_id, type, direction, notes) VALUES (?,?,?,?,?)').run(
          contact.id, userId, 'whatsapp', 'outgoing', (msg.body || '').substring(0, 300)
        );
        io.emit('contact_created', contact);
        console.log(`[WA→MSG] ✅ Novo contato criado: ${nome} (${phoneFull})`);
      } else {
        const newStage = contact.funnel_stage === 'novo' ? 'contatado' : contact.funnel_stage;
        db.prepare('UPDATE contacts SET last_contact_at=?, funnel_stage=? WHERE id=?').run(now, newStage, contact.id);
        db.prepare('INSERT INTO interactions (contact_id, user_id, type, direction, notes) VALUES (?,?,?,?,?)').run(
          contact.id, userId, 'whatsapp', 'outgoing', (msg.body || '').substring(0, 300)
        );
        const updated = db.prepare('SELECT * FROM contacts WHERE id=?').get(contact.id);
        io.emit('contact_updated', updated);
        console.log(`[WA→MSG] ✅ Atualizado: ${contact.name} | funil: ${newStage}`);
      }
    } catch(err) {
      console.error('[WA→MSG] Erro:', err.message);
    }
  });

  client.initialize().catch(err => {
    console.error('[WA] Erro:', err.message);
    delete waClients[userId];
    waStatus[userId] = 'disconnected';
  });
}

app.post('/api/whatsapp/connect', auth, async (req, res) => {
  const uid = req.user.id;
  if (waClients[uid]) return res.json({ status: waStatus[uid] || 'connecting' });
  try { await initWAClient(uid); res.json({ status: 'connecting' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/whatsapp/disconnect', auth, async (req, res) => {
  const uid = req.user.id;
  if (waClients[uid]) { try { await waClients[uid].destroy(); } catch {} delete waClients[uid]; waStatus[uid] = 'disconnected'; }
  res.json({ success: true });
});

app.get('/api/whatsapp/status', auth, (req, res) => {
  res.json({ status: waStatus[req.user.id] || 'disconnected' });
});

// Enviar mensagem pelo WhatsApp + registrar interação automaticamente
app.post('/api/whatsapp/send/:contactId', auth, async (req, res) => {
  const uid = req.user.id;
  const { message } = req.body;
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.contactId);
  if (!contact) return res.status(404).json({ error: 'Contato não encontrado' });
  if (!contact.phone) return res.status(400).json({ error: 'Contato sem número de telefone' });

  const client = waClients[uid];
  if (!client || waStatus[uid] !== 'connected')
    return res.status(400).json({ error: 'WhatsApp não conectado. Vá em WhatsApp e conecte primeiro.' });

  const cleanPhone = contact.phone.replace(/\D/g, '');
  const numberWithCC = cleanPhone.length <= 11 ? '55' + cleanPhone : cleanPhone;
  const chatId = numberWithCC + '@c.us';

  try {
    await client.sendMessage(chatId, message || '(mensagem sem texto)');
    const now = new Date().toISOString();
    const newStage = contact.funnel_stage === 'novo' ? 'contatado' : contact.funnel_stage;
    db.prepare('UPDATE contacts SET last_contact_at=?, funnel_stage=? WHERE id=?').run(now, newStage, contact.id);
    db.prepare('INSERT INTO interactions (contact_id, user_id, type, direction, notes) VALUES (?,?,?,?,?)').run(
      contact.id, uid, 'whatsapp', 'outgoing', (message || '').substring(0, 300)
    );
    const updated = db.prepare('SELECT * FROM contacts WHERE id=?').get(contact.id);
    io.emit('contact_updated', updated);
    console.log(`[WA→SEND] ✅ Enviado para ${contact.name} (${chatId})`);
    res.json({ success: true, contact: updated });
  } catch (e) {
    console.error('[WA→SEND] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao enviar mensagem: ' + e.message });
  }
});

// ==================== STATS ====================

app.get('/api/stats', auth, (req, res) => {
  const totalContacts   = db.prepare('SELECT COUNT(*) as n FROM contacts').get().n;
  const totalSales      = db.prepare('SELECT COUNT(*) as n FROM sales').get().n;
  const totalRevenue    = db.prepare('SELECT COALESCE(SUM(value),0) as n FROM sales').get().n;
  const todayInteractions = db.prepare("SELECT COUNT(*) as n FROM interactions WHERE date(created_at)=date('now','localtime')").get().n;
  const leadsCount      = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE status='lead'").get().n;
  const clientesCount   = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE status='cliente'").get().n;
  const needContact     = db.prepare(`
    SELECT COUNT(*) as n FROM contacts
    WHERE status != 'cliente'
    AND (last_contact_at IS NULL OR julianday('now') - julianday(last_contact_at) >= cooldown_days)
  `).get().n;
  const funnel = db.prepare("SELECT funnel_stage, COUNT(*) as total FROM contacts GROUP BY funnel_stage").all();
  const recentSales = db.prepare(`
    SELECT s.*, c.name as contact_name, c.phone as contact_phone, u.name as user_name
    FROM sales s JOIN contacts c ON s.contact_id=c.id LEFT JOIN users u ON s.user_id=u.id
    ORDER BY s.purchased_at DESC LIMIT 8
  `).all();
  const topVendedoras = db.prepare(`
    SELECT u.name, COUNT(s.id) as total_sales, COALESCE(SUM(s.value),0) as revenue
    FROM sales s JOIN users u ON s.user_id=u.id
    GROUP BY u.id ORDER BY total_sales DESC LIMIT 5
  `).all();

  res.json({ totalContacts, totalSales, totalRevenue, todayInteractions, leadsCount, clientesCount, needContact, funnel, recentSales, topVendedoras });
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  socket.on('join', (userId) => socket.join(`user_${userId}`));
});

// ==================== START ====================

server.listen(PORT, () => {
  console.log(`\n🚀 CRM WhatsApp rodando em http://localhost:${PORT}`);
  console.log(`📧 Login: admin@crm.com | 🔑 Senha: admin123\n`);
});
