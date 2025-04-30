// server.js - Version minimaliste sans dépendances lourdes
const http = require('http');
const WebSocket = require('ws');

// Configuration
const PORT = process.env.PORT || 8080;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!DEEPGRAM_API_KEY) {
  console.error('❌ DEEPGRAM_API_KEY environment variable is required');
  process.exit(1);
}

// Serveur HTTP simple
const server = http.createServer((req, res) => {
  // Route pour vérifier l'état du serveur
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', memory: process.memoryUsage() }));
    return;
  }
  
  // Gérer les autres routes
  res.writeHead(404);
  res.end();
});

// Serveur WebSocket avec options légères
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false, // Désactiver la compression pour économiser la mémoire
  maxPayload: 50 * 1024 * 1024 // Limiter la taille des messages à 50 Mo
});

// Suivi des connexions actives
let connectionCount = 0;
const MAX_CONNECTIONS = 10; // Limiter le nombre de connexions

// Fonction de surveillance de la mémoire
function logMemoryUsage() {
  const used = process.memoryUsage();
  console.log(`Memory usage - RSS: ${Math.round(used.rss / 1024 / 1024)}MB, Heap: ${Math.round(used.heapTotal / 1024 / 1024)}MB, Used: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
  
  // Forcer la collecte des déchets si la mémoire est trop élevée
  if (used.rss > 450 * 1024 * 1024) { // 450 MB
    console.log('⚠️ High memory usage detected, forcing garbage collection');
    if (global.gc) {
      global.gc();
    }
  }
}

// Gérer les nouvelles connexions
wss.on('connection', (ws, req) => {
  // Limiter le nombre de connexions
  if (connectionCount >= MAX_CONNECTIONS) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Server is at capacity, please try again later'
    }));
    ws.close(1013, 'Maximum connections reached');
    return;
  }
  
  connectionCount++;
  console.log(`➕ New client connected. Total: ${connectionCount}`);
  logMemoryUsage();
  
  let deepgramWs = null;
  
  // Fonction de nettoyage
  function cleanup() {
    if (deepgramWs) {
      try {
        deepgramWs.close();
      } catch (e) {
        // Ignorer les erreurs lors de la fermeture
      }
      deepgramWs = null;
    }
    
    connectionCount--;
    console.log(`➖ Client disconnected. Total: ${connectionCount}`);
    logMemoryUsage();
  }
  
  try {
    // Connexion à Deepgram
    deepgramWs = new WebSocket('wss://api.deepgram.com/v1/listen', {
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`
      }
    });
    
    // Configuration de Deepgram
    deepgramWs.onopen = () => {
      console.log('🔗 Deepgram connection established');
      
      // Paramètres minimaux
      const params = {
        encoding: 'linear16',
        sample_rate: 16000,
        language: 'fr',
        model: 'nova-2',
        interim_results: true
      };
      
      deepgramWs.send(JSON.stringify(params));
      
      // Informer le client
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'status',
          message: 'Connected to Deepgram'
        }));
      }
    };
    
    // Messages de Deepgram vers le client
    deepgramWs.onmessage = (event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(event.data);
      }
    };
    
    // Gestion des erreurs Deepgram
    deepgramWs.onerror = (error) => {
      console.error('❌ Deepgram error:', error.message);
      
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Deepgram connection error'
        }));
      }
    };
    
    // Fermeture de Deepgram
    deepgramWs.onclose = (event) => {
      console.log(`🔌 Deepgram connection closed: ${event.code}`);
      
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'status',
          message: 'Deepgram connection closed'
        }));
      }
    };
    
    // Messages du client vers Deepgram
    ws.on('message', (data) => {
      // Vérifier si la connexion Deepgram est prête
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        try {
          deepgramWs.send(data);
        } catch (error) {
          console.error('❌ Error sending data to Deepgram:', error.message);
        }
      }
    });
    
    // Fermeture et erreurs client
    ws.on('close', cleanup);
    ws.on('error', () => {
      console.error('❌ Client connection error');
      cleanup();
    });
    
    // Timeout pour les connexions inactives
    const connectionTimeout = setTimeout(() => {
      console.log('⏰ Connection timeout');
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Connection timeout');
      }
      cleanup();
    }, 30 * 60 * 1000); // 30 minutes
    
    // Annuler le timeout à la fermeture
    ws.on('close', () => clearTimeout(connectionTimeout));
    
  } catch (error) {
    console.error('❌ Connection initialization error:', error.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Connection initialization error'
      }));
      ws.close(1011, 'Error initializing connection');
    }
    cleanup();
  }
});

// Démarrer le serveur
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  logMemoryUsage();
});

// Logs périodiques de l'utilisation mémoire
setInterval(logMemoryUsage, 60000); // Toutes les minutes

// Gérer la terminaison propre
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  logMemoryUsage();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
  logMemoryUsage();
});