/**
 * Single in-page runtime used by FrameParse's CDP driver.
 * Agents never call this; they call frame_act / frame_scroll with frame refs.
 */
export const FRAMEPARSE_PAGE_RUNTIME = `function(cmd) {
  const SKIP = new Set(["script", "style", "noscript", "template"]);

  function qs(selector) {
    if (!selector) return null;
    try { return document.querySelector(selector); } catch { return null; }
  }

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || el.children.length > 0;
  }

  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width, Math.max(1, r.width)) / 2, y: r.top + Math.min(r.height, Math.max(1, r.height)) / 2, rect: r };
  }

  function fire(el, type, init) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }));
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const op = cmd.op;
  const selector = cmd.selector || "";
  let el = selector ? qs(selector) : null;

  if (["click","dblclick","fill","select","toggle","submit","hover","focus","type","scroll_into_view"].includes(op)) {
    if (!el) return { ok: false, error: "element_not_found", selector, op };
    if (cmd.ensureInView !== false) {
      try { el.scrollIntoView({ block: "center", inline: "nearest", behavior: cmd.behavior || "instant" }); } catch {
        try { el.scrollIntoView(true); } catch {}
      }
    }
  }

  if (op === "scroll_into_view") {
    el.scrollIntoView({ block: cmd.block || "center", inline: cmd.inline || "nearest", behavior: cmd.behavior || "instant" });
    return { ok: true, op, selector, rect: el.getBoundingClientRect().toJSON?.() || null };
  }

  if (op === "scroll_by") {
    const dx = Number(cmd.dx || 0);
    const dy = Number(cmd.dy || 0);
    if (el) el.scrollBy({ left: dx, top: dy, behavior: cmd.behavior || "instant" });
    else window.scrollBy({ left: dx, top: dy, behavior: cmd.behavior || "instant" });
    return { ok: true, op, dx, dy, scrollX: window.scrollX, scrollY: window.scrollY };
  }

  if (op === "scroll_to") {
    if (cmd.target === "top") window.scrollTo({ top: 0, left: 0, behavior: cmd.behavior || "instant" });
    else if (cmd.target === "bottom") window.scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior: cmd.behavior || "instant" });
    else if (el) {
      const r = el.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + r.top + (cmd.dy || 0), left: window.scrollX + r.left + (cmd.dx || 0), behavior: cmd.behavior || "instant" });
    } else {
      window.scrollTo({ top: Number(cmd.y || 0), left: Number(cmd.x || 0), behavior: cmd.behavior || "instant" });
    }
    return { ok: true, op, scrollX: window.scrollX, scrollY: window.scrollY };
  }

  if (op === "wait") {
    return { ok: true, op, waitedMs: Number(cmd.timeoutMs || 0) };
  }

  if (op === "navigate") {
    const url = cmd.url || (el && el.href) || "";
    if (!url) return { ok: false, error: "missing_url", op };
    location.assign(url);
    return { ok: true, op, url };
  }

  if (op === "hover") {
    const c = center(el);
    fire(el, "mouseover", { clientX: c.x, clientY: c.y });
    fire(el, "mouseenter", { clientX: c.x, clientY: c.y });
    fire(el, "mousemove", { clientX: c.x, clientY: c.y });
    return { ok: true, op, selector };
  }

  if (op === "focus") {
    el.focus();
    return { ok: true, op, selector };
  }

  if (op === "click" || op === "dblclick") {
    const c = center(el);
    el.focus?.();
    fire(el, "mousedown", { clientX: c.x, clientY: c.y, button: 0 });
    fire(el, "mouseup", { clientX: c.x, clientY: c.y, button: 0 });
    if (op === "dblclick") {
      fire(el, "click", { clientX: c.x, clientY: c.y, detail: 1 });
      fire(el, "click", { clientX: c.x, clientY: c.y, detail: 2 });
      fire(el, "dblclick", { clientX: c.x, clientY: c.y, detail: 2 });
    } else {
      if (typeof el.click === "function") el.click();
      else fire(el, "click", { clientX: c.x, clientY: c.y, detail: 1 });
    }
    return { ok: true, op, selector, tag: el.tagName.toLowerCase(), name: (el.getAttribute("aria-label") || el.innerText || "").slice(0, 80) };
  }

  if (op === "fill" || op === "type") {
    el.focus();
    const value = cmd.value == null ? "" : String(cmd.value);
    if (op === "fill") setNativeValue(el, value);
    else {
      // append / type into current value
      setNativeValue(el, String(el.value || "") + value);
    }
    return { ok: true, op, selector, value: el.value };
  }

  if (op === "select") {
    const value = cmd.value == null ? "" : String(cmd.value);
    if (el.tagName.toLowerCase() !== "select") return { ok: false, error: "not_select", selector };
    const opts = Array.from(el.options || []);
    let match = opts.find((o) => o.value === value || o.text === value || o.label === value);
    if (!match) match = opts.find((o) => (o.text || "").toLowerCase().includes(value.toLowerCase()));
    if (!match) return { ok: false, error: "option_not_found", selector, value };
    el.value = match.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, op, selector, value: el.value, label: match.text };
  }

  if (op === "toggle") {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      const want = cmd.value;
      if (want === true || want === false || want === "true" || want === "false") {
        const on = want === true || want === "true";
        if (el.checked !== on) el.click();
      } else {
        el.click();
      }
      return { ok: true, op, selector, checked: el.checked };
    }
    el.click();
    return { ok: true, op, selector };
  }

  if (op === "submit") {
    const form = el.tagName.toLowerCase() === "form" ? el : el.closest("form");
    if (!form) {
      if (typeof el.click === "function") el.click();
      return { ok: true, op, selector, via: "click" };
    }
    if (typeof form.requestSubmit === "function") form.requestSubmit(el.tagName.toLowerCase() === "button" || (el.type || "").toLowerCase() === "submit" ? el : undefined);
    else form.submit();
    return { ok: true, op, selector, via: "form" };
  }

  if (op === "press") {
    const target = el || document.activeElement || document.body;
    const key = String(cmd.key || cmd.value || "");
    if (!key) return { ok: false, error: "missing_key", op };
    const init = { key, code: key.length === 1 ? "Key" + key.toUpperCase() : key, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keypress", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true, op, key };
  }

  return { ok: false, error: "unknown_op", op };
}`;
