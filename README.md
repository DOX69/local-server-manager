# Localdeck

Inventaire local des serveurs Windows, conteneurs Docker et worktrees Git. Backend et collecteur en Rust. Interface React avec des composants shadcn/ui. Aucune donnée envoyée à un service externe.

## Démarrer

Prérequis : Windows 64 bits, Docker Desktop en mode conteneurs Linux, Node.js 22+, Rust/Cargo et Git sur le PATH.

À l'installation ou après une mise à jour, double-cliquez sur `Démarrer.cmd`. Ce lancement compile l'interface et le collecteur Windows, construit l'image `localdeck:local` et installe le démarrage automatique du collecteur pour votre compte Windows.

```powershell
.\Start-Localdeck.ps1
```

Au quotidien, démarrez le conteneur `localdeck` depuis Docker Desktop, puis ouvrez [localhost:4780](http://localhost:4780). Ses boutons Start/Stop pilotent l'interface. Le collecteur démarre en arrière-plan à votre connexion Windows et se relance s'il s'arrête. Vous n'avez plus de script à relancer après un redémarrage du PC.

Pour fermer l'interface, utilisez Stop dans Docker Desktop, double-cliquez sur `Arrêter.cmd` ou lancez :

```powershell
.\Stop-Localdeck.ps1
```

Le collecteur reste actif pour que le prochain clic sur Play fonctionne directement. Pour l'arrêter et désactiver son démarrage automatique, lancez `Stop-Localdeck.ps1 -DisableAutostart`. `Démarrer.cmd` le réinstalle.

Une tâche Windows `Localdeck-<SID du compte>` lance un superviseur PowerShell masqué à votre connexion, sans élévation. Chaque minute, Windows vérifie qu'il tourne et le relance si nécessaire. Sa durée d'exécution est illimitée. Le superviseur relance le collecteur si celui-ci s'arrête. Le binaire et les scripts installés sont dans `%LOCALAPPDATA%\Localdeck`, indépendamment du terminal d'installation et de la branche Git ouverte. L'installation remplace l'ancien raccourci `Localdeck.lnk`. Les autres projets et conteneurs restent en place.

## Ce que l'inventaire montre

- Serveurs : TCP/UDP, IPv4/IPv6, ports, PID, dossiers de travail, repo Git, mémoire, CPU et durée de fonctionnement. Les services système sont masqués au départ, accessibles via le filtre.
- Détails : commande, chaîne des processus parents et clients locaux actuellement connectés.
- Origine : Codex ou OpenCode uniquement si un ancêtre correspondant existe encore. Une origine inconnue reste inconnue. Un chemin de worktree Codex ne suffit pas à prouver qui utilise actuellement le serveur.
- Docker : conteneurs actifs et arrêtés, image, ports publiés, projet, service et dossier Compose lorsque les labels existent.
- Worktrees : copies Git découvertes, branche, dossier présent ou absent et nombre de ports associés. La liste inclut les copies sans serveur.

L'arrêt d'un processus termine le PID sélectionné et ferme tous ses ports. Il ne termine pas son agent parent. Un superviseur peut relancer le serveur. Sur Windows, cette terminaison peut interrompre les requêtes en cours. L'arrêt Docker utilise `docker stop` avec huit secondes de grâce. Les volumes sont conservés.

Les services Windows, Docker, WSL, les agents et Localdeck sont protégés. Les runtimes de développement courants et les exécutables construits dans leur repo Git peuvent être arrêtés. Les autres exécutables personnalisés restent protégés.

## Ajouter des dossiers

Le collecteur cherche automatiquement dans `.codex/worktrees`, `professional-projects`, `PycharmProjects` et `Documents/Codex` sous le profil Windows. Il ajoute les repos retrouvés par les processus en écoute, puis interroge `git worktree list`.

Pour des projets ailleurs, modifiez `config.json` :

```json
{ "roots": ["D:\\Projets", "C:\\Users\\vous\\Documents\\Autres projets"] }
```

Relancez `Démarrer.cmd` pour appliquer la configuration au collecteur installé. La découverte des dossiers est limitée à trois niveaux et un budget de 2 500 dossiers par groupe de racines. Les worktrees des repos découverts sont tous recensés par Git. Les repos Git bare et les processus dont les droits interdisent la lecture peuvent manquer d'attribution.

## Architecture et limites

Un conteneur Linux ne peut pas lire les processus Windows. Le collecteur natif écoute sur 4781 avec un secret aléatoire. Le conteneur s'y connecte via `host.docker.internal`. L'interface est publiée sur `127.0.0.1:4780`. Le port du collecteur doit être accessible depuis Docker Desktop ; il exige le secret sur chaque route. Aucun accès au socket Docker n'est monté dans le conteneur. Les appels Docker passent par le collecteur.

Le secret, l'identité du collecteur et ses logs sont dans `%LOCALAPPDATA%\Localdeck`, hors du projet. Le secret est conservé entre les sessions Windows pour que le conteneur existant puisse se reconnecter. L'interface utilise un jeton de session distinct. Les actions revérifient PID et date de démarrage, ou ID et date de démarrage du conteneur. Les erreurs de droits sont affichées. Le lancement normal ne demande pas de droits administrateur.

Les scans sont espacés de huit secondes après la fin de chaque collecte. Les repos et worktrees sont redécouverts environ une fois par minute. Le premier scan peut durer davantage. Le bouton Actualiser relit le dernier inventaire disponible. Les connexions TCP sont un instantané ; un onglet ouvert peut ne plus avoir de socket actif. L'inventaire n'identifie pas automatiquement le titre d'une conversation Codex ou OpenCode.

Les processus internes de WSL et des conteneurs Linux ne figurent pas comme processus Windows. Les conteneurs Docker sont présentés séparément. Seuls les contextes Docker locaux sont pris en charge.

## Développer et vérifier

```powershell
npm ci --prefix .\web
npm run build --prefix .\web
cargo test --locked
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo build --locked
.\Test-CollectorLifecycle.ps1
.\Smoke-Test.ps1
.\Smoke-Test.ps1 -RestartDashboard
```

Le test d'intégration nécessite une instance Localdeck active, Node et l'image `redis:7-alpine` disponible. Il crée un repo temporaire avec un chemin contenant des espaces, lance un serveur après le collecteur, vérifie son attribution et son arrêt, puis arrête un conteneur jetable. Il nettoie uniquement ses fixtures.

L'option `-RestartDashboard` arrête d'abord Localdeck, lance la tâche installée comme lors d'une connexion Windows, puis démarre le conteneur existant avec `docker start`. Elle vérifie le retour de l'inventaire et la conservation du secret avant les tests d'intégration. Elle ne redémarre pas le PC.

Le test de cycle de vie utilise un dossier temporaire, un port libre et une tâche Windows jetable. Il vérifie la relance après panne du collecteur et du superviseur, l'absence de doublons, le refus d'un PID périmé et la conservation du secret lors d'une nouvelle session. Il conserve la tâche Localdeck installée.

Les commandes Cargo embarquent la dernière sortie de `web`. Lancez d'abord `npm ci --prefix .\web` puis `npm run build --prefix .\web`. `Start-Localdeck.ps1` fait ces étapes automatiquement, remplace le collecteur installé et reconstruit l'image Docker. Le collecteur installé ne verrouille pas les binaires de `target`.

Si le collecteur reste indisponible, consultez `%LOCALAPPDATA%\Localdeck\collector-error.log` et `supervisor-error.log`. Vérifiez que la tâche Localdeck est active dans le Planificateur de tâches Windows, que les ports 4780/4781 sont libres et que Docker Desktop tourne. Si le pare-feu bloque la communication avec le collecteur, ajustez la règle pour Docker Desktop selon votre configuration réseau.
