# Interface Localdeck

Tableau de contrôle cyberpunk sombre pour un outil qui observe le poste local. La navigation reste à gauche sur ordinateur et passe au-dessus du contenu sur mobile. La table garde la priorité visuelle.

Le fond bleu nuit porte une grille discrète. Les cartes restent presque noires, avec des filets fins et quelques reflets cyan. Le cyan identifie l'activité locale. Le violet sert d'accent pour OpenCode et les worktrees. Le rouge est réservé aux actions d'arrêt. Les témoins verts indiquent les ressources actives.

La navigation présente le PC détecté et les sections Serveurs, Docker et Worktrees. Trois cartes résument uniquement les données du collecteur. La recherche, les filtres de colonne et le tri restent dans la barre d'inventaire. Les ports, PID, chemins et commandes utilisent une police monospace. Les détails s'ouvrent dans un panneau latéral ; l'arrêt garde une confirmation explicite.

L'interface utilise React, Vite et les composants shadcn/ui. Le thème s'appuie sur leurs variables sémantiques, puis ajoute les états de statut propres à Localdeck. Les tableaux défilent horizontalement sur mobile. Les contrôles restent accessibles au clavier et réduisent leurs animations si le système le demande.

Les états de chargement, déconnexion, données anciennes, inventaire vide et avertissement du collecteur sont visibles. Les données restent locales et proviennent du collecteur Windows.
