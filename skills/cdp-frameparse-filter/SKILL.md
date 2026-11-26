---
name: cdp-frameparse-filter
description: Browse and act on pages using FrameParse as the AI filter and CDP actuator. Prefer frame_browser + frame_act/frame_scroll over raw CDP a11y uids or evaluate_script.
---

# FrameParse browse + act (CDP)

## Interaction coverage (`frame_act` / `frame_scroll`)

| User intent | How |
|---|---|
| Click button/link | `frame_act({ ref: "i12" })` or `ref: "a3"` |
| Type into field | `frame_act({ ref: "i3", params: { value: "..." } })` |
| Submit search | fill then click submit `i#`, or `goal` + params |
| Select dropdown | `params.value` on select `i#` |
| Toggle checkbox | `frame_act({ ref: "i#" })` or params true/false |
| Submit form | `ref` form / workflow `w#` |
| Hover / focus / press key | steps via Frame 4 or params `{ key: "Enter" }` |
| Scroll to control | `frame_scroll({ op: "into_view", ref: "i#" })` |
| Scroll page | `frame_scroll({ op: "by", dy: 800 })` or `op: "to", target: "top"\|"bottom"` |
| Multi-step workflow | `frame_act({ ref: "w1", params })` |
| Goal-driven | `frame_act({ goal: "add to cart" })` |
| Destructive | requires `confirmDestructive: true` |

## Loop

1. `frame_browser({ action: "connect", browserURL: "http://127.0.0.1:9333" })` (or `launch`)
2. `frame_browser({ action: "open", url, sessionId })` — live snapshot → Frame 1 session
3. `frame_query` / `frame_plan` / `frame_read` as needed
4. **`frame_act` / `frame_scroll`** — never DevTools `click(uid)` when FrameParse actuator is connected
5. Trust returned `frame_diff`

## Rules

- Prefer FrameParse refs (`i#`/`a#`/`w#`) over a11y uids.
- Never execute destructive actions without explicit user confirmation.
- After acts, trust `frame_diff` — do not dump raw DOM.
