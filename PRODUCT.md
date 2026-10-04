# Localdeck

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Rust. Interface HTML/CSS/JavaScript embarquée dans le binaire, image Docker Desktop. Collecteur Rust natif Windows pour lire les processus de l'hôte.

## Users

Développeur Windows utilisant Codex et OpenCode. Plusieurs projets et worktrees lancent des serveurs locaux difficiles à retrouver.

## Product Purpose

Voir les ports ouverts, retrouver processus, projets et worktrees associés, voir les clients connectés et arrêter les ressources sélectionnées.

## Operating Context

Usage local sur le PC. Docker Desktop doit permettre de démarrer et fermer l'interface. Les informations Windows nécessitent un collecteur sur l'hôte.

## Capabilities and Constraints

TCP et UDP, IPv4 et IPv6. Attribution fondée sur les processus et Git. Une origine inconnue reste inconnue. Aucun arrêt automatique des autres serveurs. Les services système et le backend Docker partagé sont protégés.

Choix de réalisation : navigateur sur localhost, interface française, dossiers usuels du profil Windows et racines configurables. Aucun démarrage automatique à la connexion Windows installé.
