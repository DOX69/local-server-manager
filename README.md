# Localdeck

Inventaire local des serveurs Windows, conteneurs Docker et worktrees Git. Backend et collecteur en Rust. Aucune donnée envoyée à un service externe.

## Démarrer

Prérequis : Windows 64 bits, Docker Desktop en mode conteneurs Linux, Rust/Cargo et Git sur le PATH.

Double-cliquez sur `Démarrer.cmd`. Le premier lancement compile le collecteur Windows et construit l'image `localdeck:local`. Les lancements suivants réutilisent les caches. Ouvrez [localhost:4780](http://localhost:4780).

```powershell
.\Start-Localdeck.ps1
```

Dans Docker Desktop, le projet `localdeck` contient le service `dashboard`. Ses boutons Start/Stop pilotent l'interface. Le collecteur Windows reste disponible pour permettre les redémarrages du conteneur. Après un redémarrage du PC, relancez `Démarrer.cmd`.

Pour fermer aussi le collecteur, double-cliquez sur `Arrêter.cmd` ou lancez :

```powershell
.\Stop-Localdeck.ps1
```

Les autres projets et conteneurs restent en place. Aucun service au démarrage Windows n'est installé.

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

Arrêtez puis relancez Localdeck. La découverte des dossiers est limitée à trois niveaux et un budget de 2 500 dossiers par groupe de racines. Les worktrees des repos découverts sont tous recensés par Git. Les repos Git bare et les processus dont les droits interdisent la lecture peuvent manquer d'attribution.

## Architecture et limites

Un conteneur Linux ne peut pas lire les processus Windows. Le collecteur natif écoute sur 4781 avec un secret aléatoire. Le conteneur s'y connecte via `host.docker.internal`. L'interface est publiée sur `127.0.0.1:4780`. Le port du collecteur doit être accessible depuis Docker Desktop ; il exige le secret sur chaque route. Aucun accès au socket Docker n'est monté dans le conteneur. Les appels Docker passent par le collecteur.

Le secret, l'identité du collecteur et ses logs sont dans `%LOCALAPPDATA%\Localdeck`, hors du projet. L'interface utilise un jeton de session distinct. Les actions revérifient PID et date de démarrage, ou ID et date de démarrage du conteneur. Les erreurs de droits sont affichées. Le lancement normal ne demande pas de droits administrateur.

Les scans sont espacés de huit secondes après la fin de chaque collecte. Les repos et worktrees sont redécouverts environ une fois par minute. Le premier scan peut durer davantage. Le bouton Actualiser relit le dernier inventaire disponible. Les connexions TCP sont un instantané ; un onglet ouvert peut ne plus avoir de socket actif. L'inventaire n'identifie pas automatiquement le titre d'une conversation Codex ou OpenCode.

Les processus internes de WSL et des conteneurs Linux ne figurent pas comme processus Windows. Les conteneurs Docker sont présentés séparément. Seuls les contextes Docker locaux sont pris en charge.

## Développer et vérifier

```powershell
cargo test --locked
cargo clippy --all-targets -- -D warnings
cargo fmt --check
.\Smoke-Test.ps1
```

Le test d'intégration nécessite une instance Localdeck active, Node et l'image `redis:7-alpine` disponible. Il crée un repo temporaire avec un chemin contenant des espaces, lance un serveur après le collecteur, vérifie son attribution et son arrêt, puis arrête un conteneur jetable. Il nettoie uniquement ses fixtures.

Après modification du binaire, fermez le collecteur avec `Arrêter.cmd` avant de recompiler. Le backend embarque les trois fichiers web dans le binaire. Relancez `Démarrer.cmd` pour reconstruire aussi l'image.

Si le collecteur est indisponible, consultez `%LOCALAPPDATA%\Localdeck\collector-error.log`. Vérifiez que les ports 4780/4781 sont libres et que Docker Desktop tourne. Si le pare-feu bloque la communication avec le collecteur, ajustez la règle pour Docker Desktop selon votre configuration réseau.
