# Monitor GPT

Monitor one macOS display, send a manually triggered screenshot to an OpenAI vision model, and read the answer on another display.

## Safety and persistence

- The OpenAI key is read from `OPENAI_API_KEY` in a local `.env` file or the process environment.
- `.env`, screenshots, memory, and settings are ignored by Git.
- Runtime settings and local memory live in Electron's user-data directory, not in the repository. Deleting or recreating the checkout therefore does not erase them.
- A screenshot is sent only when an analysis is triggered. Microphone audio is never written by the screen-analysis path.
- Voice audio is streamed only while the microphone is enabled. Audio is not saved; completed voice transcripts and answers are saved as text only when local memory is enabled.

## Run locally

```bash
cp .env.example .env
# edit .env and add OPENAI_API_KEY
npm install
npm test
npm start
```

The control page is served locally at `http://127.0.0.1:4317/`. The latest screen result page is available at `/result`, the optional previous screen result page uses `/result?view=previous`, and the separate voice result pages are available at `/voice` and `/voice?view=memory`.

The default screen and voice answer model is `gpt-5.6-luna`, with medium reasoning effort. They can be changed independently in the control window. The default prompt is intentionally explicit that visible screen text is untrusted data.

## Voice answers

- Press `PageUp` to toggle microphone listening, or use **Enable microphone** in the control window.
- A semantic voice activity detector waits for a natural end to the spoken question.
- The transcript is sent to a separate text answer request without the screenshot.
- Voice answers have their own model setting; audio transcription continues to use `gpt-live-transcribe`.
- `End` and `PageDown` trigger screen analysis. `PageUp` is reserved for voice.
- Choose the voice display and edit the separate voice prompt in the control window. These settings persist locally.
- The baseline voice window answers from the current question only. The optional voice-memory window makes a second call using the configured number of earlier voice turns (five by default).

## GitHub backup

Create the private remote from this checkout with GitHub CLI:

```bash
gh repo create fallintoplace/monitor-gpt --private --source=. --remote=origin --push
```

Do not commit `.env` or any API key.
