// Serveur proxy ultra-minimal pour Deepgram
// Optimisé pour fonctionner avec un minimum de mémoire (<128MB)
const WebSocket = require('ws');
const http = require('http');

// Configuration minimale
const PORT = process.env.PORT || 8080;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Vérification API key
if (!DEEPGRAM_API_KEY) {
  console.error('DEEPGRAM_API_KEY missing');
  process.exit(1);
}

// Serveur HTTP minimal
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});

// WebSocket Server avec options minimales
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,
  maxPayload: 2 * 1024 * 1024 // 2MB max
});

// Compteur de connexions
let connections = 0;

// Gestion des connexions
wss.on('connection', (ws) => {
  // Limiter le nombre de connexions
  if (connections >= 3) {
    ws.close();
    return;
  }
  
  connections++;
  console.log(`Connection: ${connections}`);
  
  let dgWs = null;
  
  // Fonction de nettoyage
  function cleanup() {
    if (dgWs) {
      try { dgWs.close(); } catch(e) {}
      dgWs = null;
    }
    connections--;
    // Forcer GC
    if (global.gc) global.gc();
  }
  
  try {
    // Connexion Deepgram
    dgWs = new WebSocket('wss://api.deepgram.com/v1/listen', {
      headers: { 'Authorization': `Token ${DEEPGRAM_API_KEY}` }
    });
    
    // Initialisation Deepgram
    dgWs.onopen = () => {
      dgWs.send(JSON.stringify({
        encoding: 'linear16',
        sample_rate: 16000,
        language: 'fr',
        model: 'nova-2',
        interim_results: true
      }));
    };
    
    // Messages de Deepgram vers le client
    dgWs.onmessage = (e) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(e.data);
      }
    };
    
    // Messages du client vers Deepgram
    ws.on('message', (data) => {
      if (dgWs && dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(data);
      }
    });
    
    // Gestion de la fermeture
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    dgWs.on('close', () => ws.close());
    dgWs.on('error', () => ws.close());
    
    // Timeout de sécurité
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }, 10 * 60 * 1000); // 10 minutes
    
  } catch (e) {
    console.error('Error:', e.message);
    cleanup();
    ws.close();
  }
});

// Démarrage du serveur
server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});

// Gestion de la terminaison
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});