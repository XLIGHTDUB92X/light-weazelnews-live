# light-weazelnews-live

Optional, free "Go Live" add-on for the [light-weazelnews] FiveM/LB Phone news app. Lets reporters paste a link to a stream they're already broadcasting on Twitch, Kick, YouTube, or TikTok (via OBS, Streamlabs, the platform's own app, etc.) and have the app embed that platform's own player in-game — both as a self-preview for the reporter, and full-page for anyone who taps "Watch".

This is a separate download, not bundled into `light-weazelnews` itself. The base resource works exactly the same with or without this installed — it only unlocks a "Live" tab for reporters once it's dropped in.

## Installation

1. Download or clone this repo.
2. Copy its two folders — `live/` and `ui/live/` — into your `light-weazelnews` resource's own folder, so you end up with:
   ```
   light-weazelnews/
     live/
       client_live.lua
       server_live.lua
     ui/
       live/
         live.css
         live.js
       app.js            (already there)
       index.html        (already there)
       style.css         (already there)
     client.lua          (already there)
     server.lua          (already there)
     config.lua          (already there)
     fxmanifest.lua      (already there)
   ```
3. Restart `light-weazelnews` (or the whole server). No `fxmanifest.lua` edit needed, and no new config — `config.lua`'s existing `Config.LiveEnabled`, `Config.LivePlatforms`, `Config.LivePollsEnabled`, `Config.LivePay*`, `Config.MaxLive*`, `Config.TwitchEmbedParents`, `Config.LiveCommentsEnabled`, and `Config.NotifyOnLive` values (already present in `light-weazelnews/config.lua`) control this add-on exactly like they always did.
4. Done — reporters now see a "Live" tab next to Publish.

To remove it again later, delete the same two folders (`live/` and `ui/live/`) from your `light-weazelnews` folder and restart. The base resource keeps working fine either way.

## How it loads

- `live/client_live.lua` and `live/server_live.lua` are picked up automatically by `light-weazelnews/client.lua` and `light-weazelnews/server.lua` via `LoadResourceFile` + `load()` — they don't need to be (and aren't) declared in `fxmanifest.lua`. If they're missing, those loader blocks just no-op; nothing errors.
- `ui/live/live.css` and `ui/live/live.js` are picked up by `light-weazelnews/ui/index.html`, which already links/scripts them (`<link rel="stylesheet" href="live/live.css">` and `<script src="live/live.js"></script>`, loaded right after `app.js`). A 404 for either, if this add-on isn't installed, is harmless.
- `live.js` registers itself with the base app via `window.registerWeazelNewsLiveAddon(...)` and reads/writes the same shared state the base app uses internally via `window.__weazelNewsInternals`.

## Compatibility

Requires a matching version of `light-weazelnews` (one new to this split, i.e. one whose `server.lua`/`client.lua` already contain the small loader blocks and whose `ui/index.html` already links `live/live.css` and `live/live.js`). If your `light-weazelnews` predates this split, update it first — the base resource documents this in its own README under "Go Live".

Usage limit reached · Resets 10:30 PM · limits shared with Claude Code
