# Utiliser une image de base avec Python
FROM python:3.9-slim

# Installer ffmpeg et les dépendances
RUN apt-get update && apt-get install -y ffmpeg

# Installer les dépendances Python
COPY requirements.txt .
RUN pip install -r requirements.txt

# Copier le reste de l'application
COPY . .

# Exposer le port
EXPOSE 8000

# Commande de démarrage
CMD ["python", "app.py"]
