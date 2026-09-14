NIGHTCAMP ONLINE
================

This build is the multiplayer/server version.

PLAYER SYSTEM
- Every new browser gets a guest account token.
- New accounts start with 100.00 virtual Scrap.
- Online battle entry fees and payouts are calculated on the server.
- The guest token is stored in the browser so the player gets the same account when they return.
- User balances are saved in data/users.json (or DATA_DIR/users.json when DATA_DIR is configured).

ONLINE BATTLES
- Create a room and share the 6-character code.
- Supports 1v1, 2v2, 3v3, 1v1v1 and 1v1v1v1.
- Normal, Cursed, Jackpot, Cursed Jackpot and Last Drop rules.
- Every player must have enough Scrap for the selected cases before the server allows the battle to start.
- The server deducts entry, decides the authoritative result, and pays the winner/team.

LOCAL TEST
1. Install Node.js 20+
2. npm install
3. npm start
4. Open http://localhost:3000

ONLINE HOSTING
render.yaml is included for deployment to a Node.js host that supports persistent disks.
The DATA_DIR environment variable should point to persistent storage if balances must survive server restarts/redeploys.

IMPORTANT
Scrap is virtual in-game currency only. This project has no deposits, withdrawals, cashout or real-money functionality.
Not affiliated with Rust, Facepunch, Steam or Valve.
