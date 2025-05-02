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
  maxPayload: 5 * 1024 * 1024 // 5MB max
});

// Compteur de connexions
let connections = 0;

// Gestion des connexions
wss.on('connection', (ws) => {
  // Limiter le nombre de connexions
  if (connections >= 5) {
    ws.close();
    return;
  }
  
  connections++;
  console.log(`Connection: ${connections}`);
  
  // Variables locales à cette connexion
  let dgWs = null;
  let clientLanguage = null; // Variable pour stocker la langue
  let firstAudioChunk = true; // Pour analyser le premier chunk d'audio
  let audioChunksReceived = 0; // Compteur de chunks audio reçus
  
  // Fonction de nettoyage
  function cleanup() {
    if (dgWs) {
      try {
        if (dgWs.readyState === WebSocket.OPEN) {
          console.log("Envoi du message CloseStream à Deepgram");
          dgWs.send(JSON.stringify({ type: "CloseStream" }));
        }
        dgWs.close();
      } catch(e) {
        console.error("Erreur lors de la fermeture de Deepgram:", e);
      }
      dgWs = null;
    }
    connections--;
    console.log(`Connection fermée, reste ${connections} connexions`);
  }
  
  try {
    // Définir les variables de langue par défaut
    let language = 'fr';
    
    // Connexion Deepgram avec spécification explicite du mimetype pour le format webm/opus
    const dgURL = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${language}&interim_results=true&mimetype=audio/webm;codecs=opus`;
    console.log(`Connexion à Deepgram avec URL: ${dgURL}`);
    
    // Créer la connexion WebSocket à Deepgram
    dgWs = new WebSocket(dgURL, {
      headers: { 'Authorization': `Token ${DEEPGRAM_API_KEY}` }
    });
    
    // Gestionnaire d'ouverture de connexion Deepgram
    dgWs.onopen = () => {
      console.log('Connexion Deepgram établie avec succès');
      
      // Envoyer un message KeepAlive toutes les 3 secondes
      const keepAliveInterval = setInterval(() => {
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          try {
            dgWs.send(JSON.stringify({ type: "KeepAlive" }));
            console.log('Message KeepAlive envoyé à Deepgram');
          } catch (e) {
            console.error('Erreur lors de l\'envoi du message KeepAlive:', e);
            clearInterval(keepAliveInterval);
          }
        } else {
          console.log('WebSocket Deepgram fermé, arrêt des KeepAlive');
          clearInterval(keepAliveInterval);
        }
      }, 3000);
    };
    
    // Gestionnaire de réception de messages Deepgram
    dgWs.onmessage = (e) => {
      console.log('Message reçu de Deepgram de type:', typeof e.data);
      
      if (typeof e.data === 'string') {
        try {
          const data = JSON.parse(e.data);
          console.log('Message JSON reçu de Deepgram:', JSON.stringify(data).substring(0, 200) + '...');
          
          // Vérifier si c'est une transcription vide malgré de l'audio reçu
          if (data.type === 'Results' && audioChunksReceived > 5 && 
              data.channel && data.channel.alternatives && 
              data.channel.alternatives[0].transcript === '') {
            console.log('ATTENTION: Transcription vide reçue malgré réception de données audio');
          }
          
          // Transmettre le message au client
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(e.data);
          }
        } catch (jsonError) {
          console.error('Erreur de parsing du message Deepgram:', jsonError);
          // Essayer de transmettre le message brut
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(e.data);
          }
        }
      } else {
        console.log('Message binaire reçu de Deepgram, longueur:', e.data.length);
        // Transmettre le message binaire au client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      }
    };
    
    // Gestionnaire d'erreur Deepgram
    dgWs.onerror = (e) => {
      console.error('Erreur Deepgram:', e.message || e.error || 'Erreur inconnue');
    };
    
    // Gestionnaire de fermeture de connexion Deepgram
    dgWs.onclose = (e) => {
      console.log(`Connexion Deepgram fermée avec code: ${e.code}, raison: ${e.reason || 'Aucune raison spécifiée'}`);
      
      // Fermer la connexion client si nécessaire
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.close();
        } catch (e) {
          console.warn('Erreur lors de la fermeture du client:', e);
        }
      }
    };
    
    // Gestionnaire de réception de messages du client
    ws.on('message', (data) => {
      try {
        // Vérifier si c'est un Buffer (données binaires)
        if (data instanceof Buffer) {
          audioChunksReceived++;
          console.log(`Reçu chunk audio #${audioChunksReceived} de ${data.length} octets`);
          
          // Analyser le premier chunk audio pour débogage
          if (firstAudioChunk) {
            firstAudioChunk = false;
            console.log(`Premier chunk audio - 20 premiers octets:`, data.slice(0, 20));
            console.log(`Premier chunk audio - type: ${data.constructor.name}`);
          }
          
          // Transmettre les données audio à Deepgram
          if (dgWs && dgWs.readyState === WebSocket.OPEN) {
            try {
              dgWs.send(data);
              console.log(`Envoyé ${data.length} octets à Deepgram (chunk #${audioChunksReceived})`);
            } catch (e) {
              console.error('Erreur d\'envoi à Deepgram:', e.message);
            }
          } else {
            console.warn('WebSocket Deepgram non disponible pour envoyer l\'audio');
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
              
              // Envoyer une confirmation au client
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
        
        // Message texte non reconnu
        console.log(`Message texte non reconnu reçu, longueur: ${data.length}`);
        console.log(`Contenu du message: ${textData.substring(0, 100)}...`);
        
      } catch (e) {
        console.error('Erreur de traitement du message:', e.message);
      }
    });
    
    // Gestionnaire de fermeture du client
    ws.on('close', () => {
      console.log('Connexion client fermée');
      cleanup();
    });
    
    // Gestionnaire d'erreur du client
    ws.on('error', (e) => {
      console.error('Erreur de connexion client:', e.message);
      cleanup();
    });
    
    // Timeout de sécurité - 10 minutes
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        console.log('Timeout de sécurité atteint, fermeture de la connexion');
        ws.close();
      }
    }, 10 * 60 * 1000);
    
  } catch (e) {
    console.error('Erreur d\'initialisation:', e.message);
    cleanup();
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
});

// Démarrage du serveur
server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});

// Gestion de la terminaison
process.on('SIGTERM', () => {
  console.log('Signal SIGTERM reçu, arrêt du serveur');
  server.close(() => process.exit(0));
});