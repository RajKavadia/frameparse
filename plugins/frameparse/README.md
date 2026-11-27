# FrameParse

Cursor plugin for **zero-AI** 4-layer webpage frames: progressive MCP observation plus CDP click/scroll using `i#` / `a#` / `w#` refs.

## Included

- `mcp.json` — `npx -y frameparse mcp`
- `skills/frameparse` — token-minimal browse loop
- `skills/cdp-frameparse-filter` — prefer FrameParse refs over DevTools a11y uids
- `rules/prefer-frameparse-mcp.mdc` — optional guidance when FrameParse is available

## Usage

After install, use `frame_open` → `frame_query` / `frame_plan` → `frame_act` / `frame_scroll`.

Docs: https://github.com/RajKavadia/frameparse#readme  
npm: `npm install frameparse`
