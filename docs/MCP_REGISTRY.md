# Publishing to the MCP Registry

FrameParse includes a draft [`server.json`](../server.json) for the [official MCP Registry](https://github.com/modelcontextprotocol/registry).

## Before you publish

1. Install the publisher CLI per registry docs (`mcp-publisher`).
2. Run `mcp-publisher validate server.json` and fix schema errors (field names change with schema versions).
3. Prove namespace ownership for `io.github.rajkavadia/frameparse` (GitHub verification).
4. Prefer **stdio** transport until a public HTTPS MCP endpoint exists (loopback URLs may fail registry validation).

## After publishing

- Submit listing copy to [Glama](https://glama.ai/mcp/servers) (“Add MCP Server” + GitHub URL).
- Open a PR to relevant `awesome-mcp-*` lists.

**Status:** Draft prepared in-repo; **not submitted** until the maintainer runs `mcp-publisher publish` with credentials.