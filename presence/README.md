# Aura Discord presence

This tiny Gateway client makes the existing Aura application appear online as
**Watching Aura VPN**. Cloudflare Workers continue to handle commands, OAuth,
free trials and release announcements.

## VPS deployment

Use a small Ubuntu 24.04 or Debian 12 VPS. Install Docker from Docker's official
repository, clone Aura, then run:

```sh
cd aura/presence
cp .env.example .env
nano .env
docker compose up -d --build
docker compose logs -f --tail=100
```

Paste the same Discord bot token used by the Worker into `.env`. Never commit
that file. The client requests only the `Guilds` intent, so privileged member or
message-content intents are unnecessary.

To update after a repository release:

```sh
git pull --ff-only
docker compose up -d --build
```

Useful checks:

```sh
docker compose ps
docker compose logs --tail=100
docker compose restart
```
