# Movie DB Bot

A Telegram bot that indexes files posted to **your own channel** into MongoDB, and lets
users search for them by name in a private chat.

## How it works

- Post a video/document/audio file to the channel at `CHANNEL_ID` → the bot records its
  `file_id`, filename, and caption in MongoDB.
- Message the bot privately with a title → it regex-searches indexed filenames and
  copies back any matches.

## Setup

1. Copy `.env.example` to `.env` and fill in:
   - `API_ID` / `API_HASH` — from [my.telegram.org](https://my.telegram.org)
   - `BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
   - `MONGO_URI` — your MongoDB connection string
   - `CHANNEL_ID` — the channel to index (the bot must be a member/admin there)
2. `pip install -r requirements.txt`
3. `python main.py`

## Deploying on Render

This is a **background worker**, not a web service — it doesn't listen on an HTTP port,
it just stays connected to Telegram. If the Render service was created as a **Web
Service**, switch it to **Background Worker** (Settings → this can't be changed after
creation on Render — you'd need to recreate the service as a Background Worker type and
point it at this same repo). Web Services expect something bound to a port for health
checks, which this bot will never satisfy.

`render.yaml` already describes it correctly as `type: worker` for Blueprint-based
deploys.
