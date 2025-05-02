let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// Serveur proxy pour Deepgram avec support multilingue
const WebSocket = require('ws');
const http = require('http');

// Configuration
const PORT = process.env.PORT || 8080;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Vérification API key
if (!DEEPGRAM_API_KEY) {
  console.error('DEEPGRAM_API_KEY missing');
  process.exit(1);
}

// Fonction de mappage de langues (niveau global)
function mapLanguageCode(code) {
  // Convertir les codes numériques de la BDD en codes de langue Deepgram
  switch(code) {
    case '1':
    case 1:
      return 'fr'; // Français
    case '2':
    case 2:
      return 'en-US'; // Anglais US
    case '3':
    case 3:
      return 'nl'; // Néerlandais
    case '4':
    case 4:
      return 'es'; // Espagnol
    default:
      return 'fr'; // Par défaut français
  }
}

// Serveur HTTP simple
const server = http.createServer((req, res) => {
  if (req.url === '/status') {
    // Endpoint de statut
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      connections: connections
    }));
  } else {
    // Page simple
    res.writeHead(200);
    res.end('Deepgram Proxy Server Running');
  }
});

// WebSocket Server
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false, // Désactiver la compression pour les données binaires
  maxPayload: 5 * 1024 * 1024 // 5MB max pour gérer de plus gros paquets audio
});

// Compteur de connexions
let connections = 0;

// Gestion des connexions
wss.on('connection', (ws) => {
  // Limiter le nombre de connexions
  if (connections >= 5) { // Augmenté à 5
    ws.close();
    return;
  }
  
  connections++;
  console.log(`Connection: ${connections}`);
  
  // Variables locales à cette connexion
  let dgWs = null;
  let clientLanguage = null; // Variable pour stocker la langue
  let audioStarted = false; // Indicateur pour savoir si on a reçu des données audio
  
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
  
  // Fonction de reconnexion avec délai exponentiel
  function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log('Nombre maximum de tentatives de reconnexion atteint. Arrêt des tentatives.');
      reconnectAttempts = 0; // Réinitialiser pour futures tentatives
      return;
    }
    
    reconnectAttempts++;
    const delayMs = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Délai exponentiel plafonné à 30 secondes
    
    console.log(`Tentative de reconnexion ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} dans ${delayMs/1000} secondes...`);
    
    setTimeout(() => {
      try {
        // Définir les variables de langue par défaut
        let language = clientLanguage || 'fr';
        let languageModel = 'nova-2';
        
        // Créer une nouvelle connexion WebSocket
        // Utiliser la méthode alternative d'authentification avec Sec-WebSocket-Protocol pour les clients
        dgWs = new WebSocket(`wss://api.deepgram.com/v1/listen?model=${languageModel}&language=${language}&interim_results=true`, 
          ['token', DEEPGRAM_API_KEY]
        );
        
        // Configurer les gestionnaires d'événements
        setupDgWsHandlers();
      } catch (e) {
        console.error('Erreur lors de la tentative de reconnexion:', e.message);
      }
    }, delayMs);
  }
  
  // Configuration des gestionnaires d'événements pour la connexion Deepgram
  function setupDgWsHandlers() {
    dgWs.onopen = () => {
      console.log('Connexion Deepgram établie');
      reconnectAttempts = 0; // Réinitialiser le compteur de tentatives
      
      // Envoyer un message KeepAlive périodique
      const keepAliveInterval = setInterval(() => {
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          try {
            dgWs.send(JSON.stringify({ type: "KeepAlive" }));
            console.log('Message KeepAlive envoyé');
          } catch (e) {
            console.error('Erreur lors de l\'envoi du message KeepAlive:', e.message);
            clearInterval(keepAliveInterval);
          }
        } else {
          clearInterval(keepAliveInterval); // Arrêter l'envoi si la connexion est fermée
        }
      }, 3000);
    };
    
    dgWs.onmessage = (e) => {
      console.log('Message reçu de Deepgram:', typeof e.data === 'string' ? e.data.substring(0, 100) + '...' : `${e.data.length} octets binaires`);
      
      // Si c'est un message de type Results, vérifier si la transcription est vide
      if (typeof e.data === 'string') {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'Results' && data.channel && data.channel.alternatives && 
              data.channel.alternatives[0].transcript === '' && audioStarted) {
            console.log('Transcription vide reçue malgré l\'envoi de données audio.');
          }
        } catch (e) {
          console.warn('Erreur lors du parsing du message Deepgram:', e.message);
        }
      }
      
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(e.data);
        } catch (sendError) {
          console.warn('Erreur lors de l\'envoi au client:', sendError.message);
        }
      }
    };
    
    dgWs.onerror = (e) => {
      console.error('Erreur Deepgram:', e.message || 'Erreur inconnue');
      cleanup();
      attemptReconnect(); // Tenter une reconnexion en cas d'erreur
    };
    
    dgWs.onclose = (e) => {
      console.log(`Connexion Deepgram fermée avec code: ${e.code}, raison: ${e.reason}`);
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.close();
        } catch (e) {
          console.warn('Erreur lors de la fermeture du client:', e);
        }
      }
      cleanup();
    };
  }
  
  try {
    // Définir les variables de langue par défaut
    let language = 'fr';
    let languageModel = 'nova-2';
    
    // Connexion Deepgram en utilisant la méthode alternative d'authentification
    dgWs = new WebSocket(`wss://api.deepgram.com/v1/listen?model=${languageModel}&language=${language}&interim_results=true`, 
      ['token', DEEPGRAM_API_KEY]
    );
    
    // Configurer les gestionnaires d'événements
    setupDgWsHandlers();
    
    // Messages du client vers Deepgram
    ws.on('message', (data) => {
      // Vérifier si c'est un message JSON de configuration
      try {
        // Si c'est un Buffer (données binaires), c'est probablement de l'audio
        if (data instanceof Buffer) {
          console.log(`Reçu ${data.length} octets de données audio du client`);
          audioStarted = true;
          
          // Transmettre directement les données binaires à Deepgram
          if (dgWs && dgWs.readyState === WebSocket.OPEN) {
            try {
              dgWs.send(data);
              console.log(`Envoyé ${data.length} octets à Deepgram`);
            } catch (e) {
              console.error('Erreur d\'envoi à Deepgram:', e.message);
            }
          }
          return;
        }
        
        // Si c'est une chaîne, vérifier si c'est un message de configuration
        let textData = data.toString('utf8');
        
        // Essayer de parser comme JSON
        if (textData.startsWith('{') && textData.includes('config')) {
          try {
            const config = JSON.parse(textData);
            
            // Si c'est une configuration de langue
            if (config.config === 'language' && config.language) {
              clientLanguage = mapLanguageCode(config.language);
              console.log(`Configuration de langue reçue: ${config.language} => ${clientLanguage}`);
              
              // Envoyer une confirmation
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  config_received: true,
                  language: clientLanguage
                }));
              }
              
              // Ne pas transférer ce message à Deepgram
              return;
            }
          } catch (jsonError) {
            console.warn('Erreur de parsing JSON:', jsonError.message);
          }
        }
        
        // Si ce n'est ni de l'audio ni un message de configuration reconnu
        console.log(`Message non reconnu reçu: ${typeof data}, longueur: ${data.length}`);
        
        // Tenter quand même de l'envoyer à Deepgram (au cas où)
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          try {
            dgWs.send(data);
          } catch (e) {
            console.error('Erreur d\'envoi à Deepgram:', e.message);
          }
        }
      } catch (e) {
        console.error('Erreur de traitement du message:', e.message);
      }
    });
    
    // Gestion de la fermeture
    ws.on('close', () => {
      console.log('Connexion client fermée');
      cleanup();
    });
    
    ws.on('error', (e) => {
      console.error('Erreur de connexion client:', e.message);
      cleanup();
    });
    
    // Timeout de sécurité
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        console.log('Timeout de sécurité atteint, fermeture de la connexion');
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