// Modification à apporter à server.js pour supporter plusieurs langues

// Dans la fonction onopen de la connexion websocket, remplacez le block existant par :
dgWs.onopen = () => {
  console.log(`Connexion Deepgram #${connectionId} établie`);
  
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

// Ajouter cette variable au début de la fonction de gestion de connexion (au même niveau que dgWs)
let clientLanguage = null;

// Ajouter un nouveau handler pour intercepter les messages de configuration
// Juste après ws.on('message', ...) ajoutez cette logique:

// Intercepter les messages de configuration
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
      }
    }
    
    // Si ce n'est pas un message de configuration, traiter normalement
    lastActivity = Date.now();
    
    if (dgWs && dgWs.readyState === WebSocket.OPEN) {
      try {
        dgWs.send(data);
      } catch (e) {
        // Code de gestion d'erreur existant...
      }
    }
  } catch (e) {
    console.error(`Erreur lors du traitement du message: ${e.message}`);
    // Transmettre quand même le message à Deepgram
    if (dgWs && dgWs.readyState === WebSocket.OPEN) {
      try {
        dgWs.send(data);
      } catch (sendError) {
        console.error(`Erreur d'envoi à Deepgram: ${sendError.message}`);
      }
    }
  }
});

// Ajouter cette fonction de mappage de langues
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