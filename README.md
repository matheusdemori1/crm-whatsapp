# 💬 CRM WhatsApp

CRM completo com integração WhatsApp via QR Code, painel de vendas, histórico de contatos e webhook para seu site.

---

## ✅ Funcionalidades

- **Login multi-usuário** — cada vendedora tem seu acesso
- **Contatos** — cadastro completo com telefone, email e observações
- **Último contato** — marcado automaticamente via WhatsApp ou manualmente
- **WhatsApp QR Code** — cada vendedora conecta seu próprio WhatsApp
- **Painel de Vendas** — registre vendas manualmente ou via webhook
- **Webhook** — integração com qualquer site/plataforma
- **Dashboard** — estatísticas, top vendedoras e vendas recentes
- **Tempo real** — atualizações instantâneas via Socket.IO

---

## 🚀 Deploy em VPS (Railway / DigitalOcean / VPS própria)

### Opção 1 — Railway (mais fácil, gratuito)

1. Crie conta em https://railway.app
2. Clique em **New Project → Deploy from GitHub**
3. Suba o código no GitHub e conecte o repositório
4. Adicione as variáveis de ambiente:
   - `JWT_SECRET` → uma string longa e aleatória
   - `PORT` → 3000
5. Railway gera um URL público automaticamente

### Opção 2 — VPS Ubuntu (DigitalOcean, Hostinger, etc.)

```bash
# 1. Instalar Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Instalar dependências do Puppeteer (necessário para WhatsApp)
sudo apt-get install -y \
  gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 \
  libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 \
  libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 \
  libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
  libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
  libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation \
  libappindicator1 libnss3 lsb-release xdg-utils wget chromium-browser

# 3. Clonar / copiar o projeto
cd /home/seu-usuario
# (copie a pasta crm-whatsapp para aqui)

# 4. Instalar dependências Node
cd crm-whatsapp
npm install

# 5. Configurar ambiente
cp .env.example .env
nano .env   # edite JWT_SECRET com uma string aleatória

# 6. Iniciar com PM2 (processo permanente)
npm install -g pm2
pm2 start server.js --name crm-whatsapp
pm2 save
pm2 startup

# 7. (Opcional) Nginx como proxy reverso
sudo apt install nginx
# Configure /etc/nginx/sites-available/crm para redirecionar para localhost:3000
```

### Opção 3 — Render.com (gratuito)

1. Crie conta em https://render.com
2. **New → Web Service → Connect GitHub**
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Adicione `JWT_SECRET` nas Environment Variables

> ⚠️ No plano gratuito do Render, o servidor dorme após inatividade. Recomendado o plano pago para uso em produção.

---

## 🔗 Usando o Webhook

Após fazer deploy, vá em **Configurações → Webhook** para pegar seu URL.

### Exemplo de chamada (qualquer linguagem):

```bash
curl -X POST https://SEU-DOMINIO/api/webhook/SEU-TOKEN \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Maria Silva",
    "phone": "11999998888",
    "email": "maria@email.com",
    "product": "Curso Premium",
    "value": 497.00,
    "vendedora_id": 2
  }'
```

### Campos aceitos:

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| name | string | não | Nome do cliente |
| phone | string | não* | Telefone (só números ou formatado) |
| email | string | não* | Email do cliente |
| product | string | não | Nome do produto/serviço |
| value | number | não | Valor da venda |
| vendedora_id | number | não | ID da vendedora responsável |

*Pelo menos um entre `phone` e `email` é necessário para identificar o contato existente.

---

## 🔐 Primeiro Acesso

```
Email: admin@crm.com
Senha: admin123
```

**⚠️ Troque a senha imediatamente em Configurações → Alterar Senha!**

---

## 📱 Conectar WhatsApp

1. Faça login no CRM
2. Vá em **WhatsApp** no menu lateral
3. Clique em **Conectar WhatsApp**
4. Escaneie o QR Code com seu celular:
   - Abra o WhatsApp → **⋮ Menu → Dispositivos conectados → Conectar dispositivo**
5. Pronto! Mensagens recebidas atualizam automaticamente o "último contato" dos clientes

---

## 🛠️ Desenvolvimento local

```bash
npm install
cp .env.example .env
npm run dev   # usa nodemon para auto-reload
```

Acesse: http://localhost:3000
