const api = window.settingsApi;
const rootElement = document.documentElement;
const toastElement = document.querySelector("#toast");
const fontSelect = document.querySelector("#font");
const fontSearch = document.querySelector("#font-search");

let state = null;
let installedFonts = [];
let selectedFont = "";
let toastTimer = null;

const i18n = window.settingsI18n;
let currentLanguage = "ko";

function t(key, vars) {
  return i18n ? i18n.translate(currentLanguage, key, vars) : key;
}

// HTML에 담긴 한국어 기본 내용을 선택 언어로 즉시 치환합니다.
function applyLanguage(language) {
  currentLanguage = i18n ? i18n.resolveLanguage(language, state?.systemLocale) : "ko";
  document.documentElement.lang = currentLanguage;
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.getAttribute("data-i18n"));
  }
  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
    element.setAttribute("placeholder", t(element.getAttribute("data-i18n-placeholder")));
  }
  for (const element of document.querySelectorAll("[data-i18n-aria]")) {
    element.setAttribute("aria-label", t(element.getAttribute("data-i18n-aria")));
  }
}

function $(selector) {
  return document.querySelector(selector);
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function quoteFontFamily(fontFamily) {
  if (!fontFamily) return null;
  const escaped = String(fontFamily)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function createFontOption(label, value, fontFamily = "") {
  const option = new Option(label, value);
  option.style.fontFamily = fontFamily ? quoteFontFamily(fontFamily) : "var(--font-body)";
  return option;
}

function applyAppearance(appearance, fontFamily = appearance?.fontFamily || "") {
  const quotedFont = quoteFontFamily(fontFamily);
  if (quotedFont) {
    rootElement.style.setProperty("--user-font", quotedFont);
    rootElement.style.setProperty("--font-display", quotedFont);
  } else {
    rootElement.style.removeProperty("--user-font");
    rootElement.style.removeProperty("--font-display");
  }

  if (appearance?.bubbleBgColor) {
    rootElement.style.setProperty("--bubble-bg", appearance.bubbleBgColor);
  } else {
    rootElement.style.removeProperty("--bubble-bg");
  }
  if (appearance?.bubbleTextColor) {
    rootElement.style.setProperty("--bubble-ink", appearance.bubbleTextColor);
    const textHex = String(appearance.bubbleTextColor).trim();
    if (textHex.startsWith("#") && textHex.length === 7) {
      rootElement.style.setProperty("--bubble-muted", textHex + "a6");
    } else {
      rootElement.style.setProperty("--bubble-muted", textHex);
    }
  } else {
    rootElement.style.removeProperty("--bubble-ink");
    rootElement.style.removeProperty("--bubble-muted");
  }
}

function showError(message) {
  clearTimeout(toastTimer);
  toastElement.textContent = String(message || t("error.generic"));
  toastElement.hidden = false;
  toastTimer = setTimeout(() => {
    toastElement.hidden = true;
    toastElement.textContent = "";
  }, 4500);
}

function responseError(response, fallback) {
  return response?.error || fallback;
}

function setButtonBusy(button, busy, busyLabel = t("busy.check")) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.dataset.wasDisabled = String(button.disabled);
    button.textContent = busyLabel;
    button.disabled = true;
    return;
  }
  if (button.dataset.label) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
  button.disabled = button.dataset.wasDisabled === "true";
  delete button.dataset.wasDisabled;
}

function replaceOptions(select, options, selectedValue) {
  select.replaceChildren(...options);
  select.value = selectedValue || "";
}

function resolveInstalledFontFamily(fontFamily) {
  const requested = String(fontFamily || "").trim();
  if (!requested) return "";
  const exact = installedFonts.find(
    (font) => font.toLocaleLowerCase("en") === requested.toLocaleLowerCase("en")
  );
  if (exact) return exact;

  // 이전 버전은 Arial Bold처럼 개별 face 이름을 저장했습니다. 현재 목록은 CSS가 실제로
  // 인식하는 family 이름만 제공하므로, 남아 있는 style 꼬리표를 한 번 걷어내 이관합니다.
  const family = requested.replace(
    /\s+(?:Regular|Roman|Book|Medium|SemiBold|DemiBold|Bold|Light|Thin|Black|Italic)$/i,
    ""
  );
  return installedFonts.find(
    (font) => font.toLocaleLowerCase("en") === family.toLocaleLowerCase("en")
  ) || "";
}

function updateFontPreview() {
  $("#font-preview-name").textContent = selectedFont || t("font.systemDefault");
  applyAppearance(state?.appearance || {}, selectedFont);
}

function renderFonts() {
  const query = fontSearch.value.trim().toLocaleLowerCase("ko");
  const filteredFonts = query
    ? installedFonts.filter((font) => font.toLocaleLowerCase("ko").includes(query))
    : installedFonts;
  const options = [createFontOption(t("font.systemDefault"), "")];

  if (selectedFont && !filteredFonts.includes(selectedFont)) {
    options.push(createFontOption(`${selectedFont} ${t("font.currentSuffix")}`, selectedFont, selectedFont));
  }
  options.push(...filteredFonts.map((font) => createFontOption(font, font, font)));
  if (query && filteredFonts.length === 0) {
    const empty = new Option(t("font.noResult"), "__empty__");
    empty.disabled = true;
    options.push(empty);
  }

  replaceOptions(fontSelect, options, selectedFont);
  $("#font-count").textContent = query
    ? t("font.countFiltered", { filtered: filteredFonts.length, total: installedFonts.length })
    : t("font.count", { count: installedFonts.length });
  updateFontPreview();
}

function renderGeneral({ resetAppearance = false } = {}) {
  if (!state) return;
  if (resetAppearance) selectedFont = resolveInstalledFontFamily(state.appearance.fontFamily);
  replaceOptions(
    $("#pet"),
    state.pets.map((pet) => new Option(pet.label, pet.key)),
    state.petKey
  );
  $("#bubble-mode").value = state.activityBubbleMode;
  $("#usage-badges").checked = state.showUsageBadges !== false;
  $("#subagent-badge").checked = state.showSubagentBadge !== false;
  $("#language").value = state.language || "system";
  $("#follow").checked = state.followMouse;
  const autostart = $("#autostart");
  autostart.checked = state.autoStart;
  autostart.disabled = state.autoStartSupported === false;
  $("#autostart-note").textContent = autostart.disabled
    ? t("pet.autostartNote")
    : "";

  const bgVal = state.appearance.bubbleBgColor || "";
  $("#bubble-bg-color").value = bgVal;
  if (/^#[0-9a-fA-F]{6}$/.test(bgVal) || /^#[0-9a-fA-F]{3}$/.test(bgVal) || /^#[0-9a-fA-F]{8}$/.test(bgVal)) {
    $("#bubble-bg-picker").value = bgVal.slice(0, 7);
  } else {
    $("#bubble-bg-picker").value = "#ffffff";
  }

  const textVal = state.appearance.bubbleTextColor || "";
  $("#bubble-text-color").value = textVal;
  if (/^#[0-9a-fA-F]{6}$/.test(textVal) || /^#[0-9a-fA-F]{3}$/.test(textVal)) {
    $("#bubble-text-picker").value = textVal.slice(0, 7);
  } else {
    $("#bubble-text-picker").value = "#09090b";
  }

  renderFonts();
}

function accountInitial(account, provider) {
  const source = account.email || account.label || provider.label || "C";
  return source.trim().slice(0, 1).toLocaleUpperCase("ko") || "C";
}

function createEmptyState(title) {
  const empty = createElement("div", "empty-state");
  empty.appendChild(createElement("strong", "", title));
  return empty;
}

function createProviderGroup(provider) {
  const group = createElement("section", "provider-group");
  const heading = createElement("header", "provider-heading");
  const title = createElement("div", "provider-title");
  title.append(
    createElement("span", "provider-mark", provider.label.slice(0, 1)),
    createElement("h2", "", provider.label)
  );

  const addButton = createElement("button", "button", t("accounts.add"));
  addButton.type = "button";
  addButton.addEventListener("click", () =>
    runAccountAction({ provider: provider.id, action: "login" }, addButton)
  );
  heading.append(title, addButton);
  group.appendChild(heading);

  const list = createElement("div", "stack-list");
  if (!provider.accounts?.length) {
    list.appendChild(createEmptyState(t("accounts.empty")));
    group.appendChild(list);
    return group;
  }

  for (const account of provider.accounts) {
    const row = createElement("article", "list-row");
    const identity = createElement("div", "list-identity");
    identity.appendChild(
      createElement("span", "account-avatar", accountInitial(account, provider))
    );

    const copy = createElement("div", "list-copy");
    const titleRow = createElement("span");
    titleRow.appendChild(createElement("strong", "", account.email || account.label));
    if (account.active) titleRow.appendChild(createElement("span", "active-chip", t("accounts.current")));
    copy.appendChild(titleRow);
    if (account.plan) copy.appendChild(createElement("small", "", account.plan));
    identity.appendChild(copy);

    const actions = createElement("div", "list-actions");
    const switchButton = createElement(
      "button",
      "button",
      account.active ? t("accounts.using") : t("accounts.switch")
    );
    switchButton.type = "button";
    switchButton.disabled = account.active;
    switchButton.addEventListener("click", () =>
      runAccountAction(
        { provider: provider.id, action: "switch", profileKey: account.key },
        switchButton
      )
    );
    actions.appendChild(switchButton);

    const deleteButton = createElement("button", "button danger-button", t("accounts.delete"));
    deleteButton.type = "button";
    deleteButton.disabled = account.active;
    deleteButton.addEventListener("click", () => {
      const accountLabel = account.email || account.label || provider.label;
      if (!window.confirm(t("accounts.confirmDelete", { label: accountLabel }))) return;
      runAccountAction(
        { provider: provider.id, action: "delete", profileKey: account.key },
        deleteButton
      );
    });
    actions.appendChild(deleteButton);
    row.append(identity, actions);
    list.appendChild(row);
  }
  group.appendChild(list);
  return group;
}

function renderAccounts() {
  const root = $("#provider-groups");
  root.replaceChildren();
  for (const provider of state?.providers || []) {
    root.appendChild(createProviderGroup(provider));
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function resetLabel(value) {
  if (!value) return t("usage.resetNone");
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(String(value))) {
    return String(value);
  }
  const time = new Intl.DateTimeFormat(i18n ? i18n.dateLocale(currentLanguage) : "ko-KR", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return t("usage.resetAt", { time });
}

function createUsageGauge(gauge) {
  const used = clampPercent(gauge.usedPercent);
  const remaining = Math.round(100 - used);
  const container = createElement("div", "usage-gauge");
  const row = createElement("div", "usage-row");
  row.append(
    createElement("span", "", gauge.label),
    createElement("strong", "", `${remaining}%`)
  );
  const track = createElement("div", "usage-track");
  const fill = createElement("i", used >= 90 ? "is-danger" : used >= 70 ? "is-warn" : "");
  fill.style.width = `${used}%`;
  track.appendChild(fill);
  container.append(row, track, createElement("small", "", resetLabel(gauge.resetText)));
  return container;
}

function renderUsage() {
  const root = $("#usage-cards");
  root.replaceChildren();
  for (const item of state?.usage || []) {
    const card = createElement("article", "usage-card");
    const heading = createElement("header", "usage-card-heading");
    const providerLabel = item.providerLabel || item.label || t("accounts.title");
    const title = createElement("div", "usage-account-title");
    title.append(
      createElement("h2", "", providerLabel),
      createElement("p", "", item.accountLabel || t("accounts.heading"))
    );
    heading.append(
      createElement("span", "provider-mark", providerLabel.slice(0, 1)),
      title
    );
    if (item.active) heading.appendChild(createElement("span", "usage-current", t("accounts.current")));
    card.appendChild(heading);

    if (item.error) {
      card.appendChild(createElement("p", "usage-error", item.error));
    } else if (!item.gauges?.length) {
      card.appendChild(createElement("p", "usage-error", t("usage.noLimits")));
    } else {
      for (const gauge of item.gauges) card.appendChild(createUsageGauge(gauge));
    }
    root.appendChild(card);
  }
}

function renderAll(options = {}) {
  renderGeneral(options);
  renderAccounts();
  renderUsage();
}

async function runAccountAction(input, sourceButton) {
  const busyLabel = input.action === "switch"
    ? t("busy.switch")
    : input.action === "delete"
      ? t("busy.delete")
      : t("busy.open");
  setButtonBusy(sourceButton, true, busyLabel);
  try {
    const response = await api.account(input);
    if (!response?.ok) throw new Error(responseError(response, t("error.accountAction")));
    state = response.data;
    renderAccounts();
    renderUsage();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    setButtonBusy(sourceButton, false);
  }
}

function activateSection(button, { focus = false } = {}) {
  const sectionId = button.dataset.section;
  for (const navButton of document.querySelectorAll(".nav-item")) {
    const active = navButton === button;
    navButton.classList.toggle("is-active", active);
    navButton.setAttribute("aria-selected", String(active));
    navButton.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll(".panel")) {
    const active = panel.id === sectionId;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }
  if (focus) button.focus();
  $(".workspace").scrollTo({ top: 0, behavior: "smooth" });
}

function registerNavigation() {
  const buttons = [...document.querySelectorAll(".nav-item")];
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => activateSection(button));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      let targetIndex = index;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        targetIndex = (index + 1) % buttons.length;
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        targetIndex = (index - 1 + buttons.length) % buttons.length;
      } else if (event.key === "Home") {
        targetIndex = 0;
      } else if (event.key === "End") {
        targetIndex = buttons.length - 1;
      }
      activateSection(buttons[targetIndex], { focus: true });
    });
  });
  api.onNavigate((section) => {
    const target = buttons.find((button) => button.dataset.section === section);
    if (target) activateSection(target);
  });
}

function registerAppearanceControls() {
  fontSearch.addEventListener("input", renderFonts);
  fontSelect.addEventListener("change", () => {
    if (fontSelect.value === "__empty__") return;
    selectedFont = fontSelect.value;
    updateFontPreview();
  });
  $("#language").addEventListener("change", () => {
    applyLanguage($("#language").value);
    renderFonts();
    renderAccounts();
    renderUsage();
  });
  async function handleSave(event) {
    const button = event.currentTarget;
    setButtonBusy(button, true, t("action.saving"));
    try {
      const response = await api.save({
        fontFamily: selectedFont || null,
        petKey: $("#pet").value,
        activityBubbleMode: $("#bubble-mode").value,
        followMouse: $("#follow").checked,
        autoStart: $("#autostart").checked,
        bubbleBgColor: $("#bubble-bg-color").value.trim() || null,
        bubbleTextColor: $("#bubble-text-color").value.trim() || null,
        showUsageBadges: $("#usage-badges").checked,
        showSubagentBadge: $("#subagent-badge").checked,
        language: $("#language").value,
      });
      if (!response?.ok) throw new Error(responseError(response, t("error.save")));
      state = response.data;
      applyLanguage(state.language);
      renderAll({ resetAppearance: true });
      applyAppearance(state.appearance, selectedFont);
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  }
  $("#save").addEventListener("click", handleSave);
  $("#save-bubble").addEventListener("click", handleSave);
}

function registerProviderControls() {
  $("#refresh-accounts").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, t("busy.check"));
    try {
      const response = await api.get();
      if (!response?.ok) throw new Error(responseError(response, t("error.accounts")));
      state = response.data;
      renderAccounts();
      renderUsage();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });

  $("#refresh-usage").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, t("busy.check"));
    try {
      const response = await api.usage();
      if (!response?.ok) throw new Error(responseError(response, t("error.usage")));
      state = response.data;
      renderAccounts();
      renderUsage();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });
}

function registerAppearanceUpdates() {
  api.onAppearance((appearance) => {
    applyAppearance(appearance, appearance?.fontFamily || selectedFont);
    if (state) state.appearance = { ...state.appearance, ...appearance };
  });
}

function registerTitlebarControls() {
  $("#btn-minimize").addEventListener("click", () => api.minimize());
  $("#btn-maximize").addEventListener("click", () => api.maximize());
  $("#btn-close").addEventListener("click", () => api.close());

  api.onMaximizedState((isMaximized) => {
    const btn = $("#btn-maximize");
    const maxIcon = btn.querySelector(".icon-maximize");
    const restoreIcon = btn.querySelector(".icon-restore");
    if (isMaximized) {
      if (maxIcon) maxIcon.style.display = "none";
      if (restoreIcon) restoreIcon.style.display = "block";
      btn.setAttribute("aria-label", t("titlebar.restore"));
    } else {
      if (maxIcon) maxIcon.style.display = "block";
      if (restoreIcon) restoreIcon.style.display = "none";
      btn.setAttribute("aria-label", t("titlebar.maximize"));
    }
  });
}

function registerColorPickerControls() {
  const bgPicker = $("#bubble-bg-picker");
  const bgInput = $("#bubble-bg-color");
  const textPicker = $("#bubble-text-picker");
  const textInput = $("#bubble-text-color");

  function isValidColor(str) {
    const s = new Option().style;
    s.color = str;
    return s.color !== '';
  }

  bgPicker.addEventListener("input", () => {
    bgInput.value = bgPicker.value;
    updateLiveColors();
  });
  textPicker.addEventListener("input", () => {
    textInput.value = textPicker.value;
    updateLiveColors();
  });

  bgInput.addEventListener("input", () => {
    const val = bgInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val) || /^#[0-9a-fA-F]{3}$/.test(val) || /^#[0-9a-fA-F]{8}$/.test(val)) {
      bgPicker.value = val.slice(0, 7);
    }
    updateLiveColors();
  });
  textInput.addEventListener("input", () => {
    const val = textInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val) || /^#[0-9a-fA-F]{3}$/.test(val)) {
      textPicker.value = val.slice(0, 7);
    }
    updateLiveColors();
  });

  function updateLiveColors() {
    const bgVal = bgInput.value.trim();
    const textVal = textInput.value.trim();
    const previewBg = bgVal && isValidColor(bgVal) ? bgVal : "";
    const previewText = textVal && isValidColor(textVal) ? textVal : "";

    if (previewBg) {
      rootElement.style.setProperty("--bubble-bg", previewBg);
    } else {
      rootElement.style.removeProperty("--bubble-bg");
    }

    if (previewText) {
      rootElement.style.setProperty("--bubble-ink", previewText);
    } else {
      rootElement.style.removeProperty("--bubble-ink");
    }

    // 실제 말풍선에도 즉시 미리보기를 본냅니다. 저장은 적용 버튼, 창을 닫으면 저장값으로 복원됩니다.
    api.previewAppearance({ bubbleBgColor: previewBg, bubbleTextColor: previewText });
  }
}

function registerUsageUpdates() {
  api.onUsageRefreshed((payload) => {
    if (!state || !payload || typeof payload !== "object") return;
    if (Array.isArray(payload.providers)) state.providers = payload.providers;
    if (Array.isArray(payload.usage)) state.usage = payload.usage;
    renderAccounts();
    renderUsage();
  });
}

async function initialize() {
  registerTitlebarControls();
  registerColorPickerControls();
  registerNavigation();
  registerAppearanceControls();
  registerProviderControls();
  registerAppearanceUpdates();
  registerUsageUpdates();

  try {
    const [fontResponse, settingsResponse] = await Promise.all([api.fonts(), api.get()]);
    installedFonts = fontResponse?.ok && Array.isArray(fontResponse.data)
      ? fontResponse.data
      : [];
    if (!settingsResponse?.ok) {
      throw new Error(responseError(settingsResponse, t("error.load")));
    }
    state = settingsResponse.data;
    selectedFont = resolveInstalledFontFamily(state.appearance.fontFamily);
    applyLanguage(state.language);
    renderAll({ resetAppearance: true });
    applyAppearance(state.appearance, selectedFont);
  } catch (error) {
    showError(error.message || String(error));
  }
}

initialize();
