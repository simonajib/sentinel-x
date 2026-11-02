# Sentinel-X

Plateforme locale de monitoring IoT avec dashboard **React/Vite**, backend
**Express/TypeScript** et service IA **FastAPI/Python**. Le firmware ESP8266
actuel transmet les mesures DHT22, MQ-2 et PIR par **USB** ; une passerelle
Python les publie sur MQTT pour Express, SQLite et le dashboard en temps reel.

Fonctionnalites : historique des capteurs, etats du boitier et des LEDs,
authentification, notifications, detection de personnes **YOLOv8 + ByteTrack**,
reconnaissance faciale locale **YuNet + SFace**, **Sensor Fusion** et **Risk
Engine**. **Isolation Forest doit etre entraine sur vos mesures normales** :
aucun modele de production entraine n'est fourni.

Prerequis : Node.js >= 22.13, Python 3.12 x64 pour l'IA et la passerelle,
Mosquitto pour MQTT, et PlatformIO pour compiler le firmware. Les procedures
d'installation sont ci-dessous ; [le guide GitHub](docs/GITHUB.md) explique
comment partager le projet sans les donnees et secrets locaux.

## Sentinel-X : intelligence artificielle et Windows

Le service Python local se trouve dans [`ai/`](ai/README.md) : Isolation Forest,
features temporelles, YOLO/OpenCV, fusion capteurs et moteur de risque. Il utilise
le backend MQTT/SQLite, le flux SSE existant et le relais MJPEG authentifie.

Pour Windows, executer depuis la racine :

```powershell
.\install.ps1
.\run.ps1
```

Le lancement inclut MQTT, l'IA, Express, Vite et la passerelle USB pour les
mesures reelles. La webcam se controle depuis le dashboard. Arreter avec
`.\stop.ps1`. Si PowerShell bloque un script, utiliser par exemple
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`.
Les lanceurs Bash proposent le meme fonctionnement. L'entrainement reel ou de
demonstration et le lancement manuel avance sont dans [ai/README.md](ai/README.md).

Architecture et limites : [docs/AI_IMPLEMENTATION.md](docs/AI_IMPLEMENTATION.md).
Inventaire des fichiers : [docs/AI_FILES.md](docs/AI_FILES.md).

## Donnees ESP reelles par USB

Le firmware actuel envoie temperature, humidite, gaz, presence et etats du
boitier sur le port serie USB. La passerelle les transmet au MQTT existant :
**ESP USB -> passerelle Python -> MQTT -> Express -> SQLite/SSE -> React**.
Le navigateur continue a communiquer uniquement avec Express.

`run.ps1` ou `bash run.sh` demarre deja la passerelle avec detection automatique
du port USB. Pour choisir une carte, utiliser `.\run.ps1 -Port COM7` ou
`bash run.sh --port COM7`. Pour lancer la passerelle manuellement, demarrer
d'abord la stack avec `-NoEsp` / `--no-esp`, puis depuis la racine :

```powershell
.\ai\.venv\Scripts\python.exe -m pip install -r .\scripts\requirements-esp.txt
.\ai\.venv\Scripts\python.exe .\scripts\esp_serial_bridge.py
```

Fermer `platformio device monitor` avant de lancer la passerelle : un seul
programme peut ouvrir le port USB. Sans `--port`, la passerelle selectionne
l'unique port USB plausible a chaque reconnexion. Si plusieurs cartes sont
branchees, utiliser `--list-ports` puis `--port COMx`. Le dashboard affiche les quatre capteurs et
un panneau **Etat du boitier ESP** (gaz/PIR, DHT, alarme et LEDs). La chauffe et
la calibration ne sont pas interpretees comme des mesures valides.

Installation complete, configuration et test : [docs/esp-serial.md](docs/esp-serial.md).
Controle du DHT, qualite des mesures et validation de l'analyse :
[validation capteurs et IA](docs/VALIDATION_CAPTEURS_IA.md).

Dashboard React et API Express pour recevoir les mesures d'un ESP8266 via MQTT
et envoyer des commandes LED. Les tests locaux peuvent se faire sans carte,
avec Mosquitto pour simuler les messages.

## Face Recognition

La webcam utilise **YOLO + ByteTrack** pour les personnes et le suivi, puis un
module séparé **OpenCV YuNet + SFace** pour détecter et identifier les visages.
Le navigateur utilise les routes Express authentifiées ; Express appelle FastAPI.
Aucune nouvelle dépendance Python lourde : les modèles ONNX utilisent OpenCV déjà installé.
Pillow, déjà fourni avec YOLO, figure explicitement dans `requirements-vision.txt`
pour valider et normaliser les photos envoyées.

Installation des modèles officiels (une fois, environ 39 Mo, SHA-256 vérifié),
dans un terminal PowerShell ouvert à la racine du dépôt :

```powershell
Set-Location .\ai
.\.venv\Scripts\python.exe -m pip install -r requirements-vision.txt
.\.venv\Scripts\python.exe -m app.vision.setup_faces
```

Dans **Caméra → Reconnaissance faciale → Ajouter une personne**, saisir le nom,
sélectionner **1 à 5 photos** puis cliquer **Enregistrer la personne**. Utiliser
des photos JPEG, PNG ou WebP avec un seul visage net et suffisamment grand :
**3 à 5 photos par personne** sont recommandées. Limites : **5 Mio par photo**,
**15 Mio par envoi**, **4096 pixels par côté** et **16 mégapixels**.

Les photos passent uniquement par Express authentifié
(`POST /api/ai/vision/faces/enroll`), puis FastAPI (`POST /vision/faces/enroll`).
Le service ajoute les références à l'identité existante sans écraser ses photos
et recharge automatiquement le catalogue. La caméra peut être arrêtée pendant
l'ajout ; le modèle facial doit être disponible. Les refus sont expliqués photo
par photo, même si une partie de l'envoi réussit ; les photos refusées restent
sélectionnées pour correction. Les fichiers acceptés deviennent des JPEG nommés
par UUID, avec orientation corrigée et métadonnées EXIF supprimées.

L'ajout manuel reste possible dans des sous-dossiers portant le nom de la personne :

```text
ai/known_faces/Mohamed/photo1.jpg
ai/known_faces/Mohamed/photo2.jpg
ai/known_faces/Mohamed/photo3.jpg
ai/known_faces/Personne2/photo1.jpg
```

Le catalogue est chargé au démarrage de Python. Après ajout manuel/suppression de photos,
cliquer **Recharger les visages connus** dans la page Caméra. Aucun redémarrage
n'est nécessaire pour recharger les références. Les images sans visage, trop
petites, illisibles ou contenant plusieurs visages sont ignorées et journalisées.
Sans référence, le compteur indique 0 identité connue et les visages restent Inconnu.

Variables dans `ai/.env` :

```dotenv
FACE_RECOGNITION_ENABLED=true
FACE_RECOGNITION_THRESHOLD=0.55
FACE_RECOGNITION_EVERY_N_FRAMES=3
FACE_RECOGNITION_MAX_FPS=2
FACE_KNOWN_DIR=known_faces
FACE_EVENT_COOLDOWN_SECONDS=5
FACE_MIN_SIZE_PIXELS=40
FACE_DETECTOR_MODEL=models/face_detection_yunet_2023mar.onnx
FACE_EMBEDDING_MODEL=models/face_recognition_sface_2021dec.onnx
```

L'envoi de photos conserve `FACE_KNOWN_DIR` et n'ajoute aucune variable `.env`.
Après mise à jour du code, relancer Python et Express s'ils exécutent encore
l'ancienne version ; les ajouts suivants ne demandent aucun redémarrage.

Après les builds frontend/backend, `node scripts/check-face-enrollment.mjs`
vérifie le formulaire et le relais HTTP avec des photos synthétiques et un modèle
facial factice, dans des processus et dossiers isolés. Ce test n'ouvre pas la
webcam et n'évalue pas la précision biométrique.

La confiance affichée est une similarité cosinus, pas une probabilité d'identité.
Le seuil doit être évalué sur vos propres photos et conditions de caméra ; un
score de 90–95 % n'est pas garanti. Fonction de démonstration/monitoring, à ne
pas utiliser comme unique mécanisme de sécurité critique.

Commandes de démarrage, API, procédure de test, résultats de validation et liste
des fichiers modifiés : [docs/FACE_RECOGNITION.md](docs/FACE_RECOGNITION.md).

## Installation

1. Installer Git et [Homebrew](https://brew.sh/) sur macOS, si necessaire.
2. Installer Node.js (npm est inclus) :

```sh
brew install node
```

Node.js 22.13 ou plus recent est requis (module `node:sqlite` utilise pour les
comptes), ainsi que Python 3.12. Si ces outils sont deja installes avec une
version compatible, conserver ces installations. Les lanceurs ne demandent pas `lsof`.

3. Cloner le depot, puis ouvrir un terminal a sa racine (le dossier contenant ce README).
4. Lancer le script d'installation :

```sh
bash install.sh
```

Les scripts PowerShell et Bash utilisent le meme installateur
`scripts/project.mjs`. Il verifie les prerequis, installe Mosquitto via Homebrew
sur macOS si necessaire, execute `npm ci` dans les deux projets web et cree
`ai/.venv` avec les dependances IA/vision et USB. Il initialise les `.env`
manquants et conserve la configuration existante. Aucun service ne demarre
pendant l'installation. Une connexion Internet est necessaire pour les paquets.
Arreter la stack avant de relancer l'installation apres une mise a jour.

Sur Windows, utiliser `.\install.ps1` et installer Mosquitto au prealable.
Sur Linux, installer Node.js, npm, Python 3.12 et Mosquitto avec le gestionnaire
de paquets du systeme. `MOSQUITTO_PATH` permet de choisir un executable local.

| Option PowerShell | Option Bash | Effet |
| --- | --- | --- |
| `-CoreOnly` | `--core-only` | IA capteurs, sans dependances de vision |
| `-WithTests` | `--with-tests` | Ajoute les dependances de test Python |
| `-FaceModels` | `--face-models` | Telecharge et verifie les modeles faciaux officiels |
| `-SkipNodeInstall` | `--skip-node-install` | Conserve les dependances Node deja installees |
| `-SkipPythonInstall` | `--skip-python-install` | Conserve les dependances Python deja installees |

## Structure Du Projet

- `iot-backend/` : API Express, MQTT, historique SQLite, voir [iot-backend/README.md](iot-backend/README.md).
- `iot-frontend/` : application React/Vite (pages Metriques et Camera), voir [iot-frontend/README.md](iot-frontend/README.md).
- `firmware/` : firmware ESP8266 actif (PlatformIO, capteurs/OLED et sortie serie USB), compilation verifiee.
- `firmware-old/` : archive reseau non maintenue, incompatible avec la chaine USB actuelle.
- `scripts/esp_serial_bridge.py` : passerelle des mesures serie vers le backend MQTT.
- `install.ps1`, `run.ps1`, `stop.ps1` et leurs equivalents `.sh` : installation, demarrage et arret via `scripts/project.mjs`.
- `docker-compose.yml` : stack web conteneurisee (voir [Docker](#docker)).

## Architecture

Les projets web suivent une architecture en couches ; le firmware USB separe
les capteurs, les sorties et l'affichage dans `lib/sentinel_core/src/`.

| Couche | Role | Backend | Frontend | Firmware |
| --- | --- | --- | --- | --- |
| Domaine | entites et regles pures | `src/domain` | `src/domain` | structures dans `application/ports.h` |
| Application | cas d'usage et ports (interfaces) | `src/application` | `src/application` | `lib/sentinel_core/src/application` |
| Infrastructure | adaptateurs techniques | `src/infrastructure` (SQLite, MQTT, Better Auth, camera) | `src/infrastructure` (fetch, SSE, Better Auth, localStorage) | `lib/sentinel_core/src/infrastructure` (capteurs, GPIO, OLED) |
| Presentation | interface utilisateur / HTTP | `src/presentation/http` (Express) | `src/presentation` (React) | ecran OLED (adaptateur) |
| Composition | assemble les implementations | `src/main.ts` | `src/main.tsx` | `src/main.cpp` |

Le domaine et l'application web se testent sans broker, sans base persistante,
sans navigateur ni carte, avec de faux adaptateurs en memoire cote serveur.
Le parseur serie se teste egalement sans ESP.

```
ESP8266 --USB--> passerelle serie --MQTT--> Mosquitto --> Express --> SQLite
                                                        |  \--REST/SSE--> React
                                                        |--HTTP--> FastAPI
Webcam serveur --> OpenCV / YOLO / ByteTrack / YuNet / SFace --> MJPEG via Express
```

## Demarrage Et Arret

Depuis la racine du depot :

```powershell
.\run.ps1
```

Ou sous Bash :

```sh
bash run.sh
```

Le mode par defaut utilise les **mesures reelles** : Mosquitto, service IA
Python, backend Express, frontend Vite et passerelle USB en arriere-plan.
Brancher l'ESP et fermer son moniteur serie ; la passerelle attend/reconnecte
la carte et detecte automatiquement l'unique port USB plausible. La webcam
demarre depuis la page Camera du dashboard.

| Option PowerShell | Option Bash | Effet |
| --- | --- | --- |
| `-Port COM7` | `--port COM7` | Choisit le port serie de l'ESP |
| `-NoEsp` | `--no-esp` | Lance MQTT, IA et web sans la passerelle USB |
| `-Simulate` | `--simulate` | Demonstration sans carte avec capteurs et camera fictifs |

La simulation est explicite, par exemple `.\run.ps1 -Simulate` ou
`bash run.sh --simulate`. Elle conserve un vrai service IA et la connexion
MQTT ; le simulateur historique publie les mesures et detections fictives,
sert son MJPEG sur http://127.0.0.1:8090/stream.mjpg et journalise les commandes
LED sans action physique. Les e-mails vont dans `.runtime/mail/`.
Arreter la stack avant de changer de mode. `-Simulate` / `--simulate` ne se
combine pas avec les options de passerelle USB.

- Dashboard : http://127.0.0.1:5173 (connexion requise, voir ci-dessous)
- API : http://127.0.0.1:3001/api/status
- Broker MQTT : `mqtt://127.0.0.1:1883`
- IA : http://127.0.0.1:8001/health
- Journaux : `.runtime/supervisor.log`, `.runtime/mosquitto.log`, `.runtime/ai.log`, `.runtime/backend.log`, `.runtime/frontend.log` et `.runtime/esp-bridge.log`.
- En simulation : `.runtime/simulator.log` et `.runtime/mail/`.

Les valeurs ci-dessus sont les ports par defaut. `FRONTEND_PORT`, `PORT` du
backend et `AI_PORT` sont configurables ; `AI_SERVICE_URL` doit correspondre
a `AI_HOST` / `AI_PORT`, et les tokens IA doivent correspondre. Les fichiers
locaux sont `iot-backend/.env` et `ai/.env` ; les variables du terminal ont
priorite. Un service existant reconnu et disponible peut etre reutilise ;
un port occupe par un service incompatible provoque une erreur explicite.
Les chemins sont ancres au depot, meme si un lanceur est appele depuis un autre dossier.

```powershell
node .\scripts\project.mjs status
.\stop.ps1
```

```sh
bash stop.sh
```

Le superviseur local authentifie arrete uniquement les processus qu'il a
lances, avec leurs descendants. Les services reutilises restent actifs.
Les PID, l'etat du superviseur et les journaux sont ignores par Git.

## Authentification

L'interface web et les routes `/api/status` et `/api/action` sont protegees par
[Better Auth](https://www.better-auth.com/) (e-mail + mot de passe, session par
cookie `HttpOnly`). Seule `/api/health` reste publique.

L'inscription publique est desactivee : les comptes se creent en ligne de
commande. Le mot de passe (12 caracteres minimum) est demande deux fois, sans
affichage :

```sh
npm --prefix iot-backend run user:create -- operateur@aethercorp.test "Operateur"
```

- Les comptes sont stockes dans `iot-backend/data/auth.db` (SQLite, ignore par
  Git, mots de passe hashes en scrypt). Les tables sont creees au demarrage.
- L'installation genere le secret de session `BETTER_AUTH_SECRET` dans
  `iot-backend/.env` s'il manque, en reprenant l'ancien `.runtime/auth-secret`
  lorsqu'il existe. Modifier ce secret invalide les sessions. La commande
  `user:create` charge elle aussi ce `.env`.
- Sessions de 8 heures. Connexion limitee a 5 tentatives par minute et par IP
  (HTTP `429` au-dela).
- Les requetes d'authentification venant d'une origine absente de
  `FRONTEND_ORIGINS` sont refusees (HTTP `403`).

Pour appeler l'API protegee en ligne de commande, ouvrir d'abord une session :

```sh
curl -c /tmp/sentinel-cookies -H 'Origin: http://127.0.0.1:5173' \
	-H 'Content-Type: application/json' \
	-d '{"email":"operateur@aethercorp.test","password":"<mot de passe>"}' \
	http://127.0.0.1:5173/api/auth/sign-in/email
```

Les exemples `curl` suivants utilisent ensuite `-b /tmp/sentinel-cookies`.

Les services demarres manuellement ou via Homebrew restent actifs apres
`stop.ps1` / `stop.sh` ; les arreter dans leurs terminaux avec Ctrl+C si necessaire.

## Tester Les Mesures

Par defaut, les mesures apparaissent lorsque l'ESP connecte fournit ses trames
USB. Avec `-Simulate` / `--simulate`, elles sont fictives et automatiques.
Pour publier ponctuellement une mesure de demonstration explicitement marquee :

```sh
mosquitto_pub -h 127.0.0.1 -t esp8266/donnees \
	-m '{"temperature":22.5,"humidity":48,"gas":120,"presence":true,"source":"simulation"}'
```

Le dashboard conserve ces valeurs dans l'historique et les transmet par SSE
avec leur origine simulation ; elles ne remplacent pas l'etat des capteurs physiques.

```sh
curl -b /tmp/sentinel-cookies http://127.0.0.1:5173/api/status
curl -b /tmp/sentinel-cookies 'http://127.0.0.1:5173/api/readings?limit=20'
```

Avec un ESP reel connecte, `/api/status` doit contenir `mqttConnected: true`,
un `lastMessageAt` renseigne et les valeurs physiques dans `telemetry`. Chaque mesure est
enregistree dans `iot-backend/data/telemetry.db` (SQLite) et conservee 7 jours
(`READINGS_RETENTION_DAYS`). Les champs sont optionnels ; les mesures doivent
etre des nombres finis et `presence` un booleen. Le champ `ts` (epoch en
secondes) est ajoute par la passerelle a la reception USB. Elle ne rejoue
aucun historique apres une coupure. `/api/status` et les notifications
decrivent les donnees physiques ; les simulations restent dans l'historique
et le flux SSE pour la demonstration.

## Camera Et Reconnaissance Faciale

La page Camera demarre la webcam du PC serveur via Express et FastAPI. YOLO et
ByteTrack detectent et suivent les personnes ; YuNet/SFace identifie les visages
a partir du catalogue local. Le MJPEG et les metadonnees transitent par Express.
Voir [Face Recognition](docs/FACE_RECOGNITION.md) pour l'installation et les photos.

Un ancien service vision externe reste compatible avec ce contrat :

- Flux video MJPEG (`multipart/x-mixed-replace`) annote, sur l'URL definie par
  `VISION_STREAM_URL` (ex. `http://192.168.10.1:8000/stream.mjpg`).
- Detections publiees en JSON sur le topic `sentinel/vision`
  (`MQTT_VISION_TOPIC`) :

  ```json
  {"ts":1791280000,"persons":1,"faces":[{"name":"Alice","confidence":0.92}]}
  ```

  `name` vaut `null` pour un visage inconnu (signale en alerte sur la page),
  `confidence` est compris entre 0 et 1, `ts` et `persons` sont optionnels.

En mode `-Simulate` / `--simulate`, le simulateur publie des detections fictives. Hors simulation,
si `VISION_STREAM_URL` est omis, Express utilise le flux du service IA configure
par `AI_SERVICE_URL` ; une valeur `VISION_STREAM_URL` vide desactive le flux.

## Tester Les Commandes LED

Dans un terminal, ecouter les commandes :

```sh
mosquitto_sub -h 127.0.0.1 -t esp8266/led -v
```

Cliquer sur ON/OFF dans le dashboard, ou appeler l'API :

```sh
curl -i -b /tmp/sentinel-cookies http://127.0.0.1:5173/api/action \
	-H 'Content-Type: application/json' \
	-d '{"ordre":"ON"}'
```

L'API doit repondre HTTP `202` et l'abonne afficher `esp8266/led ON`.
En mode `-Simulate` / `--simulate`, le simulateur journalise `Commande LED simulee : ON` dans
`.runtime/simulator.log`.
La commande MQTT est une chaine `ON` ou `OFF`, pas un objet JSON.
Cela confirme la publication, pas l'execution physique par une carte.

## Verifications Automatiques

Le workflow [GitHub Actions](.github/workflows/ci.yml) verifie le backend,
le frontend, l'IA et la compilation du firmware a chaque push et pull request.
Les tests utilisent des adaptateurs de test et ne demandent ni secrets, ni
webcam, ni ESP physique. Les modeles telecharges restent hors du depot.

```sh
npm --prefix iot-backend test
npm --prefix iot-backend run typecheck
npm --prefix iot-backend run build
npm --prefix iot-frontend test
npm --prefix iot-frontend run lint
npm --prefix iot-frontend run build
(cd firmware && pio run)
python firmware/tests/run_native.py
python -m unittest discover -s scripts/tests -v
(cd ai && python -m pytest -q)
python scripts/check-repository.py
node scripts/check-launcher.mjs
```

Les tests couvrent les regles du domaine, les cas d'usage (avec de faux
adaptateurs), le parsing des messages MQTT, le depot SQLite et la passerelle USB ;
ils ne necessitent ni broker ni carte. Le runner C++ utilise g++, clang++ ou Zig
pour tester le firmware avec des doubles materiels ; `pio run` compile pour
l'ESP8266 actif sans flasher la carte. `check-launcher.mjs` verifie les lanceurs
avec des services isoles et leur arret ; il demande Mosquitto et les dependances
locales installees. Les commandes de publication
et d'abonnement ci-dessus servent aux tests manuels d'integration.

## Notifications Par E-mail

L'onglet **Parametres** du dashboard regle l'adresse qui recoit les alertes,
les active et choisit les types envoyes ; un bouton envoie un e-mail de test.
Les notifications sont uniquement envoyees par e-mail.

| Alerte | Declenchement |
| --- | --- |
| Intrusion | le capteur PIR passe a "presence" |
| Visage inconnu | la reconnaissance faciale signale un visage sans nom |
| Boitier hors ligne | aucune mesure recue depuis 30 s |

- Un meme type d'alerte part au plus une fois toutes les 5 minutes ; les
  mesures rejouees apres une coupure ne declenchent pas d'alerte.
- L'envoi passe par SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
  `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`), STARTTLS exige hors TLS
  implicite. Sans serveur SMTP, la page le signale et aucun e-mail ne part.
- En mode simulation (`run.ps1 -Simulate` ou `run.sh --simulate`), les e-mails sont ecrits
  dans `.runtime/mail/` (fichiers `.eml`, lisibles avec un client mail).
- Les parametres sont stockes dans `iot-backend/data/settings.db`.

## Docker

Le backend et le frontend sont conteneurises (`iot-backend/Dockerfile`,
`iot-frontend/Dockerfile`) et orchestres par `docker-compose.yml`. Le frontend
est servi par nginx, qui relaie `/api` vers le backend : seul le port web est
publie, l'API n'est pas joignable directement.

```sh
cp .env.example .env        # puis renseigner BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d --build
docker compose exec backend node dist/cli/create-user.js operateur@aethercorp.test "Operateur"
```

- Dashboard : http://localhost:8080 (port `WEB_PORT`). Pour un acces depuis le
  reseau de table, ajouter l'URL (ex. `http://192.168.10.1:8080`) a
  `FRONTEND_ORIGINS` et la definir comme `PUBLIC_URL`.
- Le broker MQTT n'est pas inclus : `MQTT_URL` pointe par defaut sur le
  Mosquitto de l'hote (`host.docker.internal:1883`).
- Les comptes et l'historique des capteurs sont conserves dans le volume
  `backend-data`.
- `VISION_STREAM_URL` et `MQTT_VISION_TOPIC` raccordent le script vision de
  l'equipe IA (voir [Camera](#camera-et-reconnaissance-faciale)).
- Durcissement : processus non-root, systeme de fichiers en lecture seule,
  capacites Linux retirees, `no-new-privileges`, en-tetes de securite nginx
  (CSP, `X-Frame-Options`, `nosniff`). Le backend ne fait confiance a
  `X-Forwarded-For` que depuis le sous-reseau interne `172.30.10.0/24` (nginx).

## Avec Un Vrai ESP8266

Le firmware courant utilise USB : suivre [le guide de la passerelle](docs/esp-serial.md).
Le broker reste local ; aucun acces Wi-Fi de la carte au broker n'est necessaire.
Arreter le simulateur avant de recevoir les mesures reelles pour ne pas melanger
leurs origines. Les LEDs et le buzzer sont commandes localement par le firmware ;
les boutons LED du dashboard necessitent un firmware MQTT compatible.

`firmware-old/` conserve une archive de l'ancienne variante reseau, non maintenue
et incompatible avec la chaine USB actuelle. Utiliser `firmware/` pour la carte actuelle.

La configuration du backend par variables d'environnement est detaillee dans
[iot-backend/README.md](iot-backend/README.md). Les lanceurs lisent cette
configuration ; un broker MQTT personnalise doit etre disponible au lancement.
Utiliser `-NoEsp` / `--no-esp` si ce broker exige une authentification ou TLS.
