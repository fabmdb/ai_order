let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// Serveur proxy pour Deepgram avec support multilingue
const WebSocket = require('ws');
const http = require('http');
const { Deepgram } = require('@deepgram/sdk');

// Configuration
const PORT = process.env.PORT || 8080;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Vérification API key
if (!DEEPGRAM_API_KEY) {
  console.error('DEEPGRAM_API_KEY missing');
  process.exit(1);
}

// Initialiser le SDK Deepgram
const deepgram = new Deepgram(DEEPGRAM_API_KEY);

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
  let dgLive = null;
  let clientLanguage = null; // Variable pour stocker la langue
  let audioStarted = false; // Indicateur pour savoir si on a reçu des données audio
  
  // Fonction de nettoyage
  function cleanup() {
    if (dgLive) {
      try { 
        dgLive.finish();
        dgLive = null; 
      } catch(e) {
        console.error('Erreur lors de la fermeture de Deepgram:', e.message);
      }
    }
    connections--;
    // Forcer GC
    if (global.gc) global.gc();
  }
  
  try {
    // Définir les variables de langue par défaut
    let language = 'fr';
    let languageModel = 'nova-2';
    
    // Créer une connexion Deepgram Live Transcription
    // Ne pas spécifier encoding/mimetype pour laisser Deepgram auto-détecter
    const dgOptions = {
      punctuate: true,
      language: language,
      model: languageModel,
      interim_results: true,
      endpointing: 200
    };
    
    console.log('Création de la connexion Deepgram avec les options:', JSON.stringify(dgOptions));
    
    // Créer la connexion live de Deepgram
    dgLive = deepgram.transcription.live(dgOptions);
    
    // Configuration des gestionnaires d'événements pour Deepgram
    dgLive.addListener('open', () => {
      console.log('Connexion Deepgram établie via SDK');
    });
    
    dgLive.addListener('error', (error) => {
      console.error('Erreur Deepgram:', error);
    });
    
    dgLive.addListener('close', () => {
      console.log('Connexion Deepgram fermée via SDK');
    });
    
    // Écouter les transcriptions
    dgLive.addListener('transcriptReceived', (transcription) => {
      console.log('Transcription reçue de Deepgram:', JSON.stringify(transcription).substring(0, 200) + '...');
      
      // Envoyer la transcription au client WebSocket
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(transcription));
        } catch (e) {
          console.error('Erreur lors de l\'envoi de la transcription au client:', e.message);
        }
      }
    });
    
    // Messages du client vers Deepgram
    ws.on('message', (data) => {
      try {
        // Si c'est un Buffer (données binaires), c'est probablement de l'audio
        if (data instanceof Buffer) {
          console.log(`Reçu ${data.length} octets de données audio du client`);
          audioStarted = true;
          
          // Envoyer les données à Deepgram
          if (dgLive) {
            try {
              dgLive.send(data);
              console.log(`Envoyé ${data.length} octets à Deepgram via SDK`);
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
              
              // Fermer la connexion existante et en ouvrir une nouvelle avec la nouvelle langue
              if (dgLive) {
                dgLive.finish();
                
                // Créer une nouvelle connexion avec la langue mise à jour
                const newOptions = {
                  punctuate: true,
                  language: clientLanguage,
                  model: languageModel,
                  interim_results: true,
                  endpointing: 200
                };
                
                console.log('Recréation de la connexion Deepgram avec les options:', JSON.stringify(newOptions));
                dgLive = deepgram.transcription.live(newOptions);
                
                // Reconfigurer les listeners
                dgLive.addListener('open', () => console.log('Connexion Deepgram réétablie avec nouvelle langue'));
                dgLive.addListener('error', (error) => console.error('Erreur Deepgram:', error));
                dgLive.addListener('close', () => console.log('Connexion Deepgram fermée'));
                
                dgLive.addListener('transcriptReceived', (transcription) => {
                  console.log('Transcription reçue de Deepgram:', JSON.stringify(transcription).substring(0, 200) + '...');
                  if (ws.readyState === WebSocket.OPEN) {
                    try {
                      ws.send(JSON.stringify(transcription));
                    } catch (e) {
                      console.error('Erreur lors de l\'envoi de la transcription au client:', e.message);
                    }
                  }
                });
              }
              
              // Envoyer une confirmation
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  config_received: true,
                  language: clientLanguage
                }));
              }
              
              return;
            }
          } catch (jsonError) {
            console.warn('Erreur de parsing JSON:', jsonError.message);
          }
        }
        
        // Si ce n'est ni de l'audio ni un message de configuration reconnu
        console.log(`Message non reconnu reçu: ${typeof data}, longueur: ${data.length}`);
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