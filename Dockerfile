# Imagem base Node.js slim com suporte a Chromium
FROM node:20-slim

# Instalar dependencias do Chrome
RUN apt-get update && apt-get install -y \
    chromium \
        fonts-liberation \
            libappindicator3-1 \
                libasound2 \
                    libatk-bridge2.0-0 \
                        libatk1.0-0 \
                            libcups2 \
                                libdbus-1-3 \
                                    libgdk-pixbuf2.0-0 \
                                        libnspr4 \
                                            libnss3 \
                                                libx11-xcb1 \
                                                    libxcomposite1 \
                                                        libxdamage1 \
                                                            libxrandr2 \
                                                                xdg-utils \
                                                                    --no-install-recommends && \
                                                                        rm -rf /var/lib/apt/lists/*

                                                                        # Variaveis de ambiente para o Puppeteer
                                                                        ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
                                                                            PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

                                                                            # Criar diretorio de trabalho
                                                                            WORKDIR /app

                                                                            # Copiar package.json e instalar dependencias
                                                                            COPY package*.json ./
                                                                            RUN npm install --production

                                                                            # Copiar restante dos arquivos
                                                                            COPY . .

                                                                            # Expor porta
                                                                            EXPOSE 3000

                                                                            # Iniciar servidor
                                                                            CMD ["node", "server.js"]
