import os
import subprocess

#Forcer l'installation de ffmpeg via nix-env
try:
    subprocess.run(["ffmpeg", "-version"], check=True)
except FileNotFoundError:
    print("ffmpeg non trouvé, installation via nix-env...")
    subprocess.run(["nix-env", "-iA", "nixpkgs.ffmpeg"], check=True)

import whisper
from flask import Flask, request, jsonify
from flask_cors import CORS  # Importer CORS
import tempfile

#Charger le modèle Whisper
model = whisper.load_model("base")  # Vous pouvez utiliser "tiny", "small", etc., selon vos ressources

app = Flask(__name__)
CORS(app)  # Activer CORS pour l'application

#Définir l'endpoint pour la transcription
@app.route("/transcribe", methods=["POST"])
def transcribe_audio():
    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier audio fourni"}), 400

    file = request.files["file"]
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_audio_file:
        file.save(temp_audio_file.name)
        temp_audio_path = temp_audio_file.name

    try:
  #      Transcrire l'audio en texte
        result = model.transcribe(temp_audio_path, language="fr")  # Spécifiez la langue
        transcription = result["text"]
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        os.remove(temp_audio_path)

    return jsonify({"transcription": transcription})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port, debug=True)
