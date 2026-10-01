# cloud-to-mac-bridge

Lets Claude cloud sessions use **Draw Things** running on your Mac.

```
Claude (cloud) -> claude.ai connector -> Cloudflare Tunnel -> this MCP server (127.0.0.1:8787) -> Draw Things API (127.0.0.1:7860)
```

Draw Things itself is never exposed. Only `/mcp/<token>` is reachable from outside, and every request without the right token gets a 404.

## Tools

| Tool | What it does |
|---|---|
| `drawthings_status` | Checks Draw Things is reachable, returns current model and settings |
| `drawthings_generate` | txt2img. Unset options use the app's current settings |
| `drawthings_img2img` | img2img from an earlier output (`source_file`) or base64 |

Full-size PNGs are saved on the Mac in `OUTPUT_DIR`. Claude gets a JPEG preview (max 1024px by default) so results stay small.

## Setup on the Mac

### 1. Draw Things
Settings > **API Server** > on, protocol **HTTP**, port **7860**. Check it:
```bash
curl http://127.0.0.1:7860/
```

### 2. Bridge
```bash
git clone https://github.com/fxreza/cloud-to-mac-bridge && cd cloud-to-mac-bridge
npm install && npm run build
cp .env.example .env
npm run gen-token        # paste the output into BRIDGE_TOKEN in .env
npm start
```

### 3. Cloudflare Tunnel
Needs a free Cloudflare account and a domain on Cloudflare.
```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create drawthings-bridge
cloudflared tunnel route dns drawthings-bridge drawthings.YOUR_DOMAIN.com
cp cloudflared/config.example.yml ~/.cloudflared/config.yml   # then edit it
cloudflared tunnel run drawthings-bridge
```
No domain? `cloudflared tunnel --url http://127.0.0.1:8787` gives a temporary `trycloudflare.com` URL for testing. It changes every run.

### 4. Connector in claude.ai
Settings > Connectors > Add custom connector, URL:
```
https://drawthings.YOUR_DOMAIN.com/mcp/<BRIDGE_TOKEN>
```
Then start a new cloud session and ask it to run `drawthings_status`.

### 5. Keep it running (optional)
- `launchd/com.drawthings.bridge.plist` starts the bridge at login.
- `sudo cloudflared service install` does the same for the tunnel.
- The Mac must stay awake: System Settings > Energy, or `caffeinate -s`.

## Security notes
- **The token is the only lock.** Anyone with the full URL can use your GPU. Don't paste the URL in public places. To revoke, change `BRIDGE_TOKEN` and update the connector.
- **This repo is public.** That's fine for the code, but never commit `.env`. It is in `.gitignore`.
- For a stronger lock, put Cloudflare Access in front of the hostname.
- `img2img` only reads plain file names inside `OUTPUT_DIR`, so it can't read other files on the Mac.

## Known limits
- Long generations (big models, many steps) may hit the connector's request timeout before Draw Things finishes. Start with small sizes and step counts.
- Parameter names follow the Draw Things HTTP API (`guidance_scale`, `steps`, `sampler`, ...). Anything else goes through `extra` unchanged. Check names against your app version if a setting seems ignored.
- Draw Things runs one job at a time. The bridge queues requests.
