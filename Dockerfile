FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Copiar arquivos
COPY package*.json ./
COPY server.js ./

# Instalar dependências
RUN npm install

# Expor porta
EXPOSE 3000

# Iniciar servidor
CMD ["npm", "start"]
