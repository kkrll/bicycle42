// ── templates ───────────────────────────────────────────────────────────────────────────────
// "/" at the start of a note lists kinds of work (variants, accessible, grade, …). Picking one
// puts a chip on the card; whatever is typed after it steers the template, and may be nothing.
function setTemplate(name) {
  S.template = name || null;
  S.menu = null;
  if (!chip) return;
  chip.hidden = !S.template;
  chip.textContent = S.template ? `/${S.template}` : "";
  const t = S.templates.find((x) => x.name === S.template);
  textarea.placeholder = t ? `${t.hint}. A note is optional` : PLACEHOLDER;
  drawCardSend();
  drawMenu();
}

function updateMenu() {
  const m = !S.template && S.templates.length ? /^\/([a-z-]*)$/.exec(textarea.value) : null;
  const found = m ? S.templates.filter((t) => t.name.startsWith(m[1])) : [];
  S.menu = found.length ? found : null;
  S.menuAt = Math.min(S.menuAt, Math.max(0, found.length - 1));
  drawMenu();
}

function drawMenu() {
  if (!menuEl) return;
  menuEl.hidden = !S.menu;
  menuEl.replaceChildren(
    ...(S.menu || []).map((t, i) => {
      const row = document.createElement("div");
      row.className = `opt${i === S.menuAt ? " on" : ""}`;
      const name = document.createElement("span");
      name.className = "opt-name";
      name.textContent = `/${t.name}`;
      const hint = document.createElement("span");
      hint.className = "opt-hint";
      hint.textContent = t.hint;
      row.append(name, hint);
      // mousedown, not click: the textarea must keep the caret.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pickTemplate(t);
      });
      return row;
    }),
  );
  kick();
}

function pickTemplate(t) {
  textarea.value = "";
  setTemplate(t.name);
  autosize();
  draftChanged();
  textarea.focus({ preventScroll: true });
}
