# Belaynish Telegram Bot (Cloudflare Worker)

## Features
- Hugging Face (Space + API)
- Replicate (via webhooks, no cron polling)
- Runway, Stability, Pixabay
- ElevenLabs TTS
- Memory in KV
- Admin commands
- Streaming passthrough
- All replies prefixed with `Belaynish`

## Deploy

1. Install Wrangler in Termux:
   ```bash
   pkg install nodejs -y
   npm install -g wrangler
   wrangler login
