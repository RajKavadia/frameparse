# Benchmarks

Reproduce everything in this document:

```bash
npm run benchmark
```

## Methodology

- **Parser latency:** Median/p95 over repeated `parsePageFrames` runs (see `benchmarks/benchmark.ts`).
- **Raw tokens:** `estimateTokens` on the input HTML string (character heuristic, not a specific LLM tokenizer).
- **Frame tokens:** formatted AI output for the relevant layer or MCP tool response text.
- **MCP tasks:** In-process `FrameParseMcpServer.handleMessage` (no network except HTTP section uses local server).
- **Fixtures:** `tests/fixtures/*` and synthetic SPAs generated in the benchmark script (repeated product cards + inline CSS/JS noise).

Compare **trends** across releases, not absolute dollar/token billing.

## Latest results (local run, 2026-11-27)

### Parser latency & structure compression

| Fixture | Size (KB) | Raw tok | Frame 1 tok | F1 compression | Full parse median (ms) |
|---------|-----------|---------|-------------|----------------|------------------------|
| Small SaaS dashboard | 1.2 | 305 | 90 | 3.4× | 0.24 |
| Medium e-commerce | 3.3 | 835 | 159 | 5.3× | 0.31 |
| Large SPA (200 cards) | 251 | 64,257 | 196 | 327.8× | 5.95 |
| XLarge SPA (800 cards) | 943.4 | 241,507 | 196 | 1232.2× | 34.46 |

### Agentic MCP vs raw HTML (harness)

| Task | Raw HTML tok | MCP emitted tok | Savings |
|------|--------------|-----------------|---------|
| E-commerce: open + query price | 833 | 298 | 64.2% |
| E-commerce: plan "add to cart" (cached) | 833 | 227 | 72.7% |
| Large SPA: open + query | 64,257 | 447 | 99.3% |
| SaaS dashboard: post-action diff | 190 | 69 | 63.7% |

### MCP stdio round-trip (ms)

Cold `initialize` ~48ms; typical tool calls ~0.3–9ms (`frame_open` fixture ~8.7ms).

### HTTP `/mcp`

`frame_plan` median ~1.5ms over 20 calls on `127.0.0.1:4173`.