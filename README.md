# ronw-planner

A guild party planner for one or many guilds. Import your roster, auto-fill balanced 5-person parties, take attendance, track strikes, and share a read-only lineup.

## Run it

**With Node (recommended):** accounts, guilds, saving on the server, and share links.

```
node server.js
```

Then open http://localhost:4747, sign up, and create your guild. Each guild's data is saved in `guilds/<id>/data.json`, with an hourly copy in `guilds/<id>/backups/` (the newest 48 are kept). No `npm install` is needed. To use a different port, run `PORT=5000 node server.js`.

If you used an earlier version from before guilds existed, your old `data.json` is moved into a guild automatically the first time the server starts (the old file is renamed `data.json.moved`). If you already had accounts, the first one becomes its leader. If not, the first account you sign up on the server's own computer becomes its leader.

**Without Node:** double-click `index.html`. It works the same, but data is saved in that browser only, and share links are off (the "Export lineup (.html)" button still works).

## Accounts, guilds and roles

- The first account on the site is the **site admin**. Sign-up is **invite only** by default: people can only make an account through a guild's invite link (they join that guild as a Member) or a **new-guild link** from the site admin (they can start one guild and become its **Guild Leader**). The admin makes new-guild links, and can turn invite-only off, in Settings → Site. Each new-guild link works once and expires after 7 days.
- **One account, one guild.** To move to another guild, leave the current one in Settings → Guild members, then open the new guild's invite link. The last leader has to hand over leadership before leaving, and the last person in a guild can't leave it.
- **Guild Leader**: everything, plus changing roles, removing people, making a new invite link, restoring and erasing data.
- **Officer**: edits the roster, events, attendance, strikes and auction.
- **Member**: sees the lineups and reservation lists, and signs up for reservations under the roster name an officer linked to their account.
- Settings → Guild members shows the invite link, everyone's role, and who's linked to which roster name.
- Each guild only sees its own data. Passwords are stored hashed in `users.json`, and logins last 30 days.
- Commands to run on the server: `node server.js add-user <name>`, `node server.js reset-password <name>`, `node server.js make-leader <name> <guild>` and `node server.js make-admin <name>`.

## What's in it

- **Roster**: import a CSV or paste rows straight from Excel or Google Sheets. It recognizes columns like IGN/name, class/job, level, gear score/GS/power, rank, contribution and discord. Merge updates members by name. You can sort, search, edit, mark members inactive, and export a CSV.
- **Events**: built from modes (Guild League, Polarity and Siege War to start, all editable in Settings). Each mode has fields with slot caps; a blank cap means the whole active roster.
- **Auto-fill**: keeps locked parties and pinned slots, puts a tank and/or support in each party when that box is ticked, then spreads everyone else so each party's gear score total stays close. It skips members marked absent and can fill from one group only.
- **Board**: drag between slots and the bench, or click a slot to pick someone. You can also set a leader (★), pin, lock, rename, add notes, and add or remove parties.
- **Attendance**: present, late or absent per event, either for the lineup or the whole roster. The overview shows each member's rate. "Strike absentees" adds a strike to everyone marked absent.
- **Groups**: subsets of the roster, such as statics or mains, to fill events from.
- **Sharing**: with the server running, More → Create share link gives a read-only page at `/share/<token>`. It shows only names, jobs, level and GS, never Discord or notes. Anyone with the link can open it without an account. It only works while the server is running and others can reach it, so for people outside your network use **Export lineup (.html)** or **Copy as text**.
- **Auction**: reservation queues such as Equipment, Relics and Cards. Paste your numbered Discord list and it splits into lists in the same order. When something drops, type it into "Item dropped?" (for example "orc hero" or "dex 10") to see who's next across every list, then press Give. Given items move to history, and Undo puts the person back in their old spot. Use ▲▼ to reorder, and "Copy for Discord" to post the updated, renumbered list. With the server running, a share link lets members search for their own spot. Tick "Let members add themselves" in the share dialog and members can also pick their name from the roster, choose a list and join the end of it, with no Discord post needed. Their sign-ups show up in your Auction page within about 20 seconds.
- **Settings**: guild name, party size, modes, which jobs count as tank, support or DPS, and JSON backup and restore.

## Files

- `server.js`: a zero-dependency Node server that serves the app and handles accounts, guilds, saving and share links.
- `index.html`, `styles.css`, `app.js`: the app itself, in plain JavaScript with no build step.
- `users.json`: accounts, logins and guild membership. Never served to browsers.
- `guilds/`: one folder per guild with its `data.json` and `backups/`. Never served to browsers.
