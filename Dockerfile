FROM node:18-alpine
# Optimisations mémoire
ENV NODE_OPTIONS="--max-old-space-size=128"
ENV NODE_ENV="production"
WORKDIR /app
# Créer un package.json avec ws et deepgram
RUN echo '{"name":"minimal-proxy","dependencies":{"ws":"^8.13.0","@deepgram/sdk":"^2.4.0"}}' > package.json
# Installation des dépendances
RUN npm i --only=production --no-package-lock --no-audit
# Copier uniquement le fichier serveur
COPY server.js ./
# Port
EXPOSE 8080
# Démarrer
CMD ["node", "--optimize_for_size", "--gc_interval=100", "server.js"]