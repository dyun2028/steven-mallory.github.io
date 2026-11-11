+++
title = 'Trader Maths Trainer'
date = 2026-11-05
draft = false
aiassisted = true
summary = 'Desktop app for practising quant and trading interview maths. Electron, JavaScript, SQLite.'
+++

**Tech:** Electron, JavaScript, SQLite · [Source](https://github.com/dyun2028/trader_maths)

**Stack:** An Electron desktop app: a Node.js main process and an HTML/CSS/JavaScript interface connected through a preload bridge. Practice stats are stored locally with Node's built-in `node:sqlite`, the question generators are plain JavaScript modules, and `electron-builder` packages it for Windows, macOS and Linux.

- Built a cross-platform desktop app for practising the maths behind quant and trading interviews: mental arithmetic, percentages, estimation, probability, expected value, Bayes and market making.
- Generated questions procedurally so every answer is computed and correct by construction, with 7 topics and 5 levels each.
- Added timed sprint mode, a review queue that repeats missed questions, and per-topic accuracy and speed stats stored in a local SQLite file.
- Wrote tests that generate questions for every topic and level and verify them.
