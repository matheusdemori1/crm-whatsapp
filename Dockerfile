# Imagem base com Node.js e Chromium já instalados
FROM ghcr.io/puppeteer/puppeteer:21.0.0

# Definir diretório de trabalho
WORKDIR /app

# Variáveis de ambiente para o Puppeteer usar o Chromium do sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

    # Copiar package.json e instalar dependências
    COPY package*.json ./
    RUN npm ci --omit=dev

    # Copiar o restante dos arquivos
    COPY . .

    # Expor a porta
    EXPOSE 3000

    # Iniciar o servidor
    CMD ["node", "server.js"]
