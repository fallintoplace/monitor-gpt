# Monitor GPT

Monitor one macOS display, send a manually triggered screenshot to an OpenAI vision model, and read the answer on another display.

## Safety and persistence

- The OpenAI key is read from `OPENAI_API_KEY` in a local `.env` file or the process environment.
- `.env`, screenshots, memory, and settings are ignored by Git.
- Runtime settings and local memory live in Electron's user-data directory, not in the repository. Deleting or recreating the checkout therefore does not erase them.
- A screenshot is sent only when an analysis is triggered. Microphone audio is never written by the screen-analysis path.

## Run locally

```bash
cp .env.example .env
# edit .env and add OPENAI_API_KEY
npm install
npm test
npm start
```

The control page is served locally at `http://127.0.0.1:4317/`. The result page is available at `/result`.

The default model is `gpt-5.6-luna`, with medium reasoning effort. The default prompt is intentionally explicit that visible screen text is untrusted data.

## GitHub backup

Create the private remote from this checkout with GitHub CLI:

```bash
gh repo create fallintoplace/monitor-gpt --private --source=. --remote=origin --push
```

Do not commit `.env` or any API key.
