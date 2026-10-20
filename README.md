# ronw-planner

A guild party planner for one or many guilds. Import your roster, auto-fill balanced 5-person parties, take attendance, track strikes, and share a read-only lineup.

## Run it

**With Node (recommended):** accounts, guilds, saving on the server, and share links.

```
node server.js
```

Then open http://localhost:4747, sign up, and create your guild. Each guild's data is saved in `guilds/<id>/data.json`, with an hourly copy in `guilds/<id>/backups/` (the newest 48 are kept). No `npm install` is needed. To use a different port, run `PORT=5000 node server.js`.

If you used an earlier version from before guilds existed, your old `data.json` is moved into a guild automatically the first time the server starts (the old file is renamed `data.json.moved`). If you already had accounts, the first one becomes its leader. If not, the first account you sign up on the server's own computer becomes its leader.

**Without Node:** double-click `index.html`. It works the same, but data is saved in that browser only, and share links are off (Export lineup (.csv) and Copy as text still work).

## Run it with Docker

Needs Docker with Compose. In the project folder:

```
docker compose up -d --build
```

The app listens on port `4747` on all of the server's network addresses (`0.0.0.0`) and restarts on its own. Accounts and guild data are kept in the **`data/` folder** next to `docker-compose.yml` (`data/users.json` and `data/guilds/`), so they survive rebuilds and updates, and Git ignores that folder. To put it on a domain, point the server's web server (nginx, Apache, ...) or a Cloudflare Tunnel at `http://127.0.0.1:4747`. With nginx, pass the headers listed under step 6 below.

To change the port or how it's exposed, copy `.env.example` to `.env` and edit it:
- `APP_PORT`: the port on the server (default `4747`).
- `APP_BIND`: `0.0.0.0` (default, reachable from the network) or `127.0.0.1` (this machine only, when a web server or tunnel on the same machine is in front).
- `TRUST_PROXY`: `1` (default) when a web server or tunnel is in front. Set `0` if people open `http://server:4747` directly, so nobody can fake their IP to get around the login limits.

- **Update**: `git pull`, then `docker compose up -d --build`.
- **Logs**: `docker compose logs -f`
- **Account commands**: `docker compose exec -u node app node server.js reset-password <name>` (also `add-user`, `make-leader`, `make-admin`, `delete-user`).
- **Bring existing data in**: stop it (`docker compose down`), copy `users.json` and the `guilds/` folder into `data/`, then start it again. The container fixes the files' owner on start.
- **Back up the data**: copy the `data/` folder somewhere safe.

## Host it on your own server and domain (without Docker)

These steps are for a Linux server you control (a VPS or a home server) with a domain pointed at it. The app listens only on `127.0.0.1`, and a web server in front of it (nginx here) handles the domain and HTTPS.

1. **Install Node 18 or newer** and Git on the server.
2. **Get the code**:
   ```
   git clone https://github.com/Kurt-Zidane/ronw-planner.git
   cd ronw-planner
   ```
3. **Bring the data, or start fresh.** Git never includes the data, so it isn't in the clone.
   - To keep the existing accounts and guilds, copy `users.json` and the `guilds/` folder from the old computer into the `ronw-planner` folder. Send them privately: `users.json` holds hashed passwords and logins.
   - To start fresh, skip this. The first account that signs up becomes the site admin, so sign up yourself right after the site goes live. To bring a guild's data over, use Settings → Download backup on the old computer, then Restore from backup in the new guild.
4. **Keep it running** with pm2, which also restarts it after a crash or reboot:
   ```
   sudo npm install -g pm2
   pm2 start server.js --name ronw-planner
   pm2 save
   pm2 startup
   ```
   Run the command that `pm2 startup` prints. To use another port, start it with `PORT=5000 pm2 start server.js --name ronw-planner`.
5. **Point the domain at the server**: at the domain's DNS settings, add an `A` record for the domain (or a subdomain like `planner`) with the server's public IP.
6. **Put nginx in front.** Create `/etc/nginx/sites-available/ronw-planner`:
   ```
   server {
     listen 80;
     server_name planner.example.com;

     location / {
       proxy_pass http://127.0.0.1:4747;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_http_version 1.1;
       proxy_set_header Connection '';
     }
   }
   ```
   The `X-Forwarded-*` lines let logins see the real visitor IP and know the site is on HTTPS. The last two keep the live-update connection open (see **Live updates** below). Turn it on and get a free HTTPS certificate, which certbot also renews:
   ```
   sudo ln -s /etc/nginx/sites-available/ronw-planner /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d planner.example.com
   ```
   Open ports 80 and 443 in the firewall, and keep 4747 closed to the outside. No ports to open? Use a Cloudflare Tunnel pointed at `http://localhost:4747` instead of nginx.
7. Open the domain and log in. Invite links and share links use the domain automatically.

**Updating** to a newer version: `git pull`, then `pm2 restart ronw-planner`. The data stays as it is.

**Backups**: the server keeps 48 hourly copies per guild, but on the same disk. Copy `users.json` and `guilds/` somewhere else regularly.

**Settings** (environment variables, all optional):
- `PORT`: port to listen on (default `4747`).
- `HOST`: address to listen on (default `127.0.0.1`). Only change it to `0.0.0.0` if the web server in front runs on another machine or in a container.
- `DATA_DIR`: folder for `users.json` and `guilds/` (default: the app folder). Useful to keep data outside the code folder, for example `DATA_DIR=/var/lib/ronw-planner`.
- `TRUST_PROXY=1`: only needed when the web server in front is **not** on the same machine (another server, or Docker). Without it, logins can't see the real visitor IP or that the site is on HTTPS. Don't set it if the app can be reached directly from the internet.

## Accounts, guilds and roles

- The first account on the site is the **site admin**. Sign-up is **invite only** by default: people can only make an account through a guild's invite link (they join that guild as a Member) or a **new-guild link** from the site admin (they can start one guild and become its **Guild Leader**). The admin makes new-guild links, and can turn invite-only off, in Settings → Site. Each new-guild link works once and expires after 7 days.
- **One account, one guild.** To move to another guild, leave the current one in Settings → Guild members, then open the new guild's invite link. The last leader has to hand over leadership before leaving, and the last person in a guild can't leave it.
- **Guild Leader**: everything, plus changing roles, removing people, making a new invite link, restoring and erasing data.
- **Officer**: edits the roster, events, attendance, strikes and auction.
- **Member**: sees the lineups and reservation lists, and signs up for reservations under the roster name an officer linked to their account.
- Settings → Guild members shows the invite link, everyone's role, and who's linked to which roster name.
- Each guild only sees its own data. Passwords are stored hashed in `users.json`, and logins last 30 days.
- **Deleting accounts**: anyone can delete their own account under **My account** (Settings, or the member bar), after typing their password. The site admin can delete any other account in **Settings → Site → Accounts**. Deleting removes the login, signs it out everywhere and takes it out of its guild. The guild's data and the person's roster name stay. A guild's only leader has to make someone else leader first, and the last site admin can't be deleted.
- Commands to run on the server: `node server.js add-user <name>`, `node server.js reset-password <name>`, `node server.js make-leader <name> <guild>`, `node server.js make-admin <name>` and `node server.js delete-user <name>`.

## What's in it

- **Roster**: import a CSV or paste rows straight from Excel or Google Sheets. It recognizes columns like IGN/name, class/job, level, gear score/GS/power, rank, contribution and discord. Merge updates members by name. You can sort, search, edit, mark members inactive, and export a CSV.
- **Events**: built from modes (Guild League, Polarity and Siege War to start, all editable in Settings). Each mode has fields with slot caps; a blank cap means the whole active roster.
- **Auto-fill**: keeps locked parties and pinned slots, puts a tank and/or support in each party when that box is ticked, then spreads everyone else so each party's gear score total stays close. It skips members marked absent and can fill from one group only.
- **Board**: drag between slots and the bench, or click a slot to pick someone. You can also set a leader (★), pin, lock, rename, add notes, and add or remove parties.
- **Attendance**: present, late or absent per event, either for the lineup or the whole roster. The overview shows each member's rate. "Strike absentees" adds a strike to everyone marked absent.
- **Groups**: subsets of the roster, such as statics or mains, to fill events from. On a board, **Add group** puts a whole group into one field's empty slots, skipping anyone already placed or marked absent. With "Keep them together" on, it fills empty parties first so a static stays in one party, and it can add parties when there isn't room. The bench also has a group filter for dragging people one by one.
- **Sharing**: with the server running, More → Create share link gives a read-only page at `/share/<token>`. It shows only names, jobs, level and GS, never Discord or notes. Anyone with the link can open it without an account. It only works while the server is running and others can reach it, so for people outside your network use **Copy as text**.
- **Lineup CSV**: a board's More → **Export lineup (.csv)** saves the lineup as `Field, Party, IGN, Class, Leader, Level, Gear Score`, one row per person in slot order. Events → **Import CSV** reads the same columns and creates a new event with the same fields and parties. People are matched to the roster by exact name; anyone who isn't in the roster leaves their slot empty and is listed in the preview, and the roster itself never changes. Only `Party` and `IGN` are required. Use it to copy a lineup to another guild or site, or to bring one in from a spreadsheet.
- **Auction**: reservation queues such as Equipment, Relics and Cards. Paste your numbered Discord list and it splits into lists in the same order. When something drops, type it into "Item dropped?" (for example "orc hero" or "dex 10") to see who's next across every list, then press Give. Given items move to history, and Undo puts the person back in their old spot. Use ▲▼ to reorder, and "Copy for Discord" to post the updated, renumbered list. With the server running, a share link lets members search for their own spot. Tick "Let members add themselves" in the share dialog and members can also pick their name from the roster, choose a list and join the end of it, with no Discord post needed. Everyone gets one spot per list: a list they're already in is greyed out, and the server refuses a second spot (officers can still add anyone by hand). Logged-in members also see **Your spots**, where they can edit what they want or give up their own spots, and only their own; a spot counts as theirs when it's linked to their roster name, or carries that name (like a pasted Discord list). Their sign-ups, edits and removals show up on your Auction page right away, and your own saves never undo them.
- **Live updates**: every open page updates by itself within about a second when its guild's data changes: officers see each other's saves and members' changes, members see lineups and reservation lists change, and share links update too. Nobody needs to refresh. An update waits while you're typing, in a dialog or dragging, and an officer page with unsaved changes keeps them (the next save reports the conflict as before). It uses one Server-Sent Events connection per page at `/api/live` (or `/api/share/<token>/live`), which only says "something changed", never the data. Behind nginx, keep the `proxy_http_version 1.1` and `Connection ''` lines from step 6; a quiet connection is pinged every 25 seconds so proxies don't close it. If it's blocked anyway, officer pages still check every 60 seconds.
- **Settings**: guild name, party size, modes, which jobs count as tank, support or DPS, and JSON backup and restore.

## Files

- `server.js`: a zero-dependency Node server that serves the app and handles accounts, guilds, saving and share links.
- `index.html`, `styles.css`, `app.js`: the app itself, in plain JavaScript with no build step.
- `package.json`: lets you start it with `npm start`. There are no dependencies to install.
- `Dockerfile`, `docker-compose.yml`, `.env.example`: the Docker setup. The image never contains `users.json` or `guilds/`.
- `data/`: with Docker, holds `users.json` and `guilds/`. Kept out of Git.
- `users.json`: accounts, logins and guild membership. Never served to browsers, and kept out of Git.
- `guilds/`: one folder per guild with its `data.json` and `backups/`. Never served to browsers, and kept out of Git.
