# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

**podcast2text** — a tool that transcribes Spotify podcast audio or Youtube videos into text.

## Tech stack



## Setup

## How to run

## Conventions

- Keep functions small and focused; prefer clear names over comments.
- Follow existing formatting in the file you're editing. If a formatter is
  configured (black, ruff), run it before committing.
- Add or update a test when you change behavior.

## Important — do not commit

- **Secrets.** API keys live in `.env`, which is git-ignored. Never hard-code
  a key or commit `.env`. If you add a new key, document it in `.env.example`
  with a placeholder value.
- **Audio files.** Source audio is large and git-ignored by default. Don't
  add `.mp3`/`.wav`/etc. to commits unless it's a deliberately small sample.
- **Model weights.** Don't commit downloaded model files.

## Git workflow

- Branch: `main`. Remote: `origin` (github.com/teijag/podcast2text).
- Write short, present-tense commit messages ("Add SRT output", not "Added...").
- Always show me the diff and wait for approval before pushing.
