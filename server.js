// Serveur proxy amélioré pour Deepgram
// Optimisé pour une meilleure fiabilité et débogage
const WebSocket = require('ws');
const http = require('http');

// Configuration
const PORT = process.env.PORT || 8080;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Vérification API key
if (!DEEPGRAM_API_KEY) {
  console.error('ERREUR CRITIQUE: DEEPGRAM_API_KEY manquante');
  process.exit(1);
}

// Serveur HTTP avec page de statut
const server = http.createServer((req, res) => {
  if (req.url === '/status') {
    // Endpoint de statut pour vérifier la santé du service
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      connections: connections,
      memory: process.memoryUsage()
    }));
  } else {
    // Page d'accueil simple
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Proxy Deepgram</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
          .status { padding: 15px; background-color: #e8f4fd; border-radius: 5px; }
          .connections { margin-top: 15px; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1>Proxy Deepgram</h1>
        <div class="status">Service actif - ${new Date().toISOString()}</div>
        <div class="connections">Connexions actives: ${connections}</div>
        <p>Ce service sert de proxy pour les connexions WebSocket vers l'API Deepgram.</p>
      </body>
      </html>
    `);
  }
});

// WebSocket Server avec options améliorées
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,
  maxPayload: 5 * 1024 * 1024, // 5MB max (augmenté)
  clientTracking: true 
});

// Compteur de connexions
let connections = 0;
let totalConnections = 0;

// Ping périodique pour maintenir les connexions actives
setInterval(() => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.ping();
      } catch (e) {
        console.error('Erreur ping client:', e.message);
      }
    }
  });
}, 30000); // Ping toutes les 30 secondes

// Gestion des connexions
wss.on('connection', (ws, req) => {
  // Augmenter la limite à 5 connexions simultanées
  if (connections >= 5) {
    console.log('Limite de connexions atteinte, refus de nouvelle connexion');
    ws.close(1013, 'Maximum connections reached');
    return;
  }
  
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  connections++;
  totalConnections++;
  
  const connectionId = totalConnections;
  console.log(`Nouvelle connexion #${connectionId} depuis ${clientIp} - Total: ${connections}`);
  
  let dgWs = null;
  let lastActivity = Date.now();
  
  // Fonction de nettoyage
  function cleanup() {
    if (dgWs) {
      try { 
        dgWs.close(); 
      } catch(e) {
        console.error(`Erreur lors de la fermeture de la connexion Deepgram #${connectionId}:`, e.message);
      }
      dgWs = null;
    }
    
    connections--;
    console.log(`Connexion #${connectionId} fermée - Restantes: ${connections}`);
    
    // Forcer GC
    if (global.gc) {
      try {
        global.gc();
      } catch(e) {
        console.error('Erreur lors du GC:', e.message);
      }
    }
  }
  
  try {
    // Connexion Deepgram avec nouvelles options
    dgWs = new WebSocket('wss://api.deepgram.com/v1/listen', {
      headers: { 
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'User-Agent': 'S2O-DeepgramProxy/1.1'
      }
    });
    
    // Initialisation Deepgram
    dgWs.onopen = () => {
      console.log(`Connexion Deepgram #${connectionId} établie`);
      
      // Configuration améliorée pour une meilleure reconnaissance vocale
      dgWs.send(JSON.stringify({
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        language: 'fr',
        model: 'nova-2',
        interim_results: true,
        endpointing: 200, // Détection de fin de phrase plus rapide
        vad_turnoff: 500  // Arrêter quand silence détecté
      }));
    };
    
    // Messages de Deepgram vers le client
    dgWs.onmessage = (e) => {
      lastActivity = Date.now();
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(e.data);
        } catch (err) {
          console.error(`Erreur d'envoi au client #${connectionId}:`, err.message);
          cleanup();
        }
      }
    };
    
    // Gestion des erreurs de connexion Deepgram
    dgWs.onerror = (e) => {
      console.error(`Erreur Deepgram #${connectionId}:`, e.message || 'Erreur inconnue');
      
      // Si le client est toujours connecté, envoyons un message d'erreur formaté
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            error: true,
            message: "Erreur de connexion à Deepgram",
            code: e.code || 0
          }));
        } catch (sendError) {
          console.error(`Erreur lors de l'envoi du message d'erreur:`, sendError.message);
        }
      }
    };
    
    // Messages du client vers Deepgram
    ws.on('message', (data) => {
      lastActivity = Date.now();
      
      if (dgWs && dgWs.readyState === WebSocket.OPEN) {
        try {
          dgWs.send(data);
        } catch (e) {
          console.error(`Erreur d'envoi à Deepgram #${connectionId}:`, e.message);
          
          // Essayer de récupérer gracieusement
          if (e.message.includes('closed') || e.message.includes('CLOSED')) {
            // Reconnexion à Deepgram
            try {
              console.log(`Tentative de reconnexion Deepgram #${connectionId}`);
              dgWs.close();
              
              // Nouvelle tentative de connexion
              dgWs = new WebSocket('wss://api.deepgram.com/v1/listen', {
                headers: { 'Authorization': `Token ${DEEPGRAM_API_KEY}` }
              });
              
              // Réinitialiser les gestionnaires d'événements
              dgWs.onopen = () => {
                console.log(`Reconnexion Deepgram #${connectionId} réussie`);
                dgWs.send(JSON.stringify({
                  encoding: 'linear16',
                  sample_rate: 16000,
                  language: 'fr',
                  model: 'nova-2',
                  interim_results: true
                }));
              };
              
              dgWs.onmessage = (e) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(e.data);
                }
              };
              
              dgWs.onerror = cleanup;
              dgWs.onclose = () => {
                console.log(`Connexion Deepgram #${connectionId} fermée`);
                cleanup();
              };
              
            } catch (reconnectError) {
              console.error(`Erreur de reconnexion Deepgram #${connectionId}:`, reconnectError.message);
              cleanup();
            }
          }
        }
      }
    });
    
    // Gestion de la fermeture côté client
    ws.on('close', (code, reason) => {
      console.log(`Fermeture client #${connectionId} - Code: ${code}, Raison: ${reason || 'non spécifiée'}`);
      cleanup();
    });
    
    // Gestion des erreurs côté client
    ws.on('error', (err) => {
      console.error(`Erreur client #${connectionId}:`, err.message);
      cleanup();
    });
    
    // Gestion de la fermeture côté Deepgram
    dgWs.on('close', (code, reason) => {
      console.log(`Fermeture Deepgram #${connectionId} - Code: ${code}, Raison: ${reason || 'non spécifiée'}`);
      
      // Si le client est toujours connecté, l'informer
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            error: true,
            message: "Connexion à Deepgram perdue",
            code: code
          }));
        } catch (e) {
          console.error(`Erreur lors de l'envoi du message de fermeture:`, e.message);
        }
        
        // Fermer la connexion client
        try {
          ws.close(1011, "Connexion à Deepgram perdue");
        } catch (e) {
          console.error(`Erreur lors de la fermeture du client:`, e.message);
        }
      }
      
      cleanup();
    });
    
    // Détection d'inactivité pour éviter les connexions zombies
    const inactivityCheckInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastActivity > 5 * 60 * 1000) { // 5 minutes d'inactivité
        console.log(`Connexion #${connectionId} inactive depuis 5 minutes, fermeture`);
        clearInterval(inactivityCheckInterval);
        
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.close(1000, "Inactivité");
          } catch (e) {
            console.error(`Erreur lors de la fermeture pour inactivité:`, e.message);
          }
        }
        
        cleanup();
      }
    }, 60000); // Vérifier toutes les minutes
    
    // Effacer l'intervalle lors de la fermeture
    ws.on('close', () => clearInterval(inactivityCheckInterval));
    
  } catch (e) {
    console.error(`Erreur globale #${connectionId}:`, e.message);
    cleanup();
    
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.close(1011, "Erreur interne");
      } catch (closeError) {
        console.error(`Erreur lors de la fermeture du client:`, closeError.message);
      }
    }
  }
});

// Démarrage du serveur
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`Date de démarrage: ${new Date().toISOString()}`);
  console.log(`API Deepgram: ${DEEPGRAM_API_KEY ? 'Configurée' : 'MANQUANTE'}`);
});

// Gestion de la terminaison
process.on('SIGTERM', () => {
  console.log('Signal SIGTERM reçu, arrêt en cours...');
  
  // Fermer gracieusement les connexions WebSocket
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.close(1001, 'Service shutting down');
      } catch (e) {
        console.error('Erreur lors de la fermeture du client:', e.message);
      }
    }
  });
  
  // Fermer le serveur HTTP
  server.close(() => {
    console.log('Serveur arrêté proprement');
    process.exit(0);
  });
  
  // Sortie forcée après 5 secondes si les connexions ne se ferment pas correctement
  setTimeout(() => {
    console.error('Fermeture forcée après timeout');
    process.exit(1);
  }, 5000);
});