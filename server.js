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
  perMessageDeflate: false,
  maxPayload: 2 * 1024 * 1024 // 2MB max
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
      console.log('Connexion Deepgram établie');
      
      // Utiliser la langue envoyée par le client ou défaut français
      let language = 'fr';
      let languageModel = 'nova-2';
      
      // Si le client a envoyé un message de configuration préalable, utilisons cette langue
      if (clientLanguage) {
        language = clientLanguage;
        console.log(`Utilisation de la langue spécifiée par le client: ${language}`);
      }
      
      // Configuration améliorée pour une meilleure reconnaissance vocale
      dgWs.send(JSON.stringify({
	  type: "Configure",  // Champ manquant ajouté ici
	  encoding: 'linear16',
	  sample_rate: 16000,
	  channels: 1,
	  language: language,
	  model: languageModel,
	  interim_results: true,
	  endpointing: 200, // Détection de fin de phrase plus rapide
	  vad_turnoff: 500  // Arrêter quand silence détecté
	}));
    };
    
    // Messages de Deepgram vers le client
    dgWs.onmessage = (e) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(e.data);
      }
    };
    
    // Gestion des erreurs Deepgram
    dgWs.onerror = (e) => {
      console.error('Erreur Deepgram:', e.message || 'Erreur inconnue');
      cleanup();
    };
    
    // Fermeture Deepgram
    dgWs.onclose = () => {
      console.log('Connexion Deepgram fermée');
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.close();
        } catch (e) {
          console.warn('Erreur lors de la fermeture du client:', e);
        }
      }
      cleanup();
    };
    
    // Messages du client vers Deepgram
    ws.on('message', (data) => {
      // Vérifier si c'est un message JSON de configuration
      try {
        // Vérifions si c'est du texte et si c'est un message de configuration
        if (typeof data === 'string' || data instanceof Buffer) {
          let textData;
          if (data instanceof Buffer) {
            textData = data.toString('utf8');
          } else {
            textData = data;
          }
          
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
              // Ce n'est pas un JSON valide, traiter comme données binaires normales
            }
          }
        }
        
        // Si ce n'est pas un message de configuration, traiter normalement
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          try {
            dgWs.send(data);
          } catch (e) {
            console.error('Erreur d\'envoi à Deepgram:', e.message);
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify({ error: true, message: e.message }));
              } catch (sendError) {
                console.warn('Erreur d\'envoi d\'erreur au client:', sendError.message);
              }
            }
          }
        }
      } catch (e) {
        console.error('Erreur de traitement du message:', e.message);
        // Transmettre quand même le message à Deepgram
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          try {
            dgWs.send(data);
          } catch (sendError) {
            console.error('Erreur d\'envoi à Deepgram:', sendError.message);
          }
        }
      }
    });
    
    // Gestion de la fermeture
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    
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