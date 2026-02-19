// public/nav.js
// Navigation builder
// - Tablet cell pages (/cell/:id): minimal nav + language selector; NO pickers/links; NO logo hover swap.
// - Dashboard/history + molds/oven: logo + title + links + pickers + theme toggle.

(() => {
  const mount = document.getElementById("topnav");
  if (!mount) return;

  // ---------- safe escaping (FIXED) ----------
  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
  function escapeAttr(str) {
    return escapeHtml(str).replaceAll("`", "&#96;");
  }

  const parts = location.pathname.split("/").filter(Boolean);
  const pageType = parts[0] ?? ""; // dashboard | history | cell | molds | oven
  const pageKey = parts[1] ?? "";

  async function fetchConfig() {
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      return await r.json();
    } catch {
      return { departments: [], cells: [] };
    }
  }

  // ---------- theme ----------
  function isThemeCapablePage() {
    return pageType === "dashboard" || pageType === "history" || pageType === "molds" || pageType === "oven";
  }

  function applyThemeForDept(deptId) {
    if (!isThemeCapablePage()) {
      document.documentElement.classList.remove("theme-dark");
      return { isDark: false, key: null };
    }
    const key = `flooralerts_theme_${deptId ?? "quality"}`;
    const saved = (localStorage.getItem(key) ?? "light").toLowerCase();
    const isDark = saved === "dark";
    document.documentElement.classList.toggle("theme-dark", isDark);
    return { isDark, key };
  }

  // ---------- i18n (tablet only) ----------
  const LANG_KEY = "cherneassist_lang";
  function getSavedLang() {
    return (localStorage.getItem(LANG_KEY) ?? "en").toLowerCase();
  }
  async function ensureI18nLoaded(lang) {
    try {
      if (typeof I18N !== "undefined" && I18N?.load) {
        await I18N.load(lang);
        return true;
      }
    } catch {}
    return false;
  }
  function t(key, vars) {
    try {
      if (typeof I18N !== "undefined" && I18N?.t) return I18N.t(key, vars);
    } catch {}
    if (!vars) return key;
    let s = key;
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{{${k}}}`, String(v));
    return s;
  }

  // ---------- logo hover swap (NON-TABLET ONLY) ----------
  function wireLogoHoverSwap() {
    if (pageType === "cell") return; // ✅ do not apply on tablets
    const logo = document.getElementById("navLogo");
    if (!logo) return;

    const def = logo.getAttribute("data-default") || "/assets/logo.svg";
    const hov = logo.getAttribute("data-hover") || def;

    logo.addEventListener("mouseenter", () => { logo.src = hov; });
    logo.addEventListener("mouseleave", () => { logo.src = def; });
  }

  (async () => {
    const config = await fetchConfig();
    const depts = Array.isArray(config.departments) ? config.departments : [];
    const cells = Array.isArray(config.cells) ? config.cells : [];

    // =====================================================
    // TABLET CELL PAGE
    // =====================================================
    if (pageType === "cell") {
      const lang = getSavedLang();
      await ensureI18nLoaded(lang);

      const appTitle = (t("app_title") === "app_title") ? "CHERNE Assist" : t("app_title");

      mount.innerHTML = `
        <div class="topnav">
          <div class="left">
            <img class="nav-logo" src="/assets/logo.svg" alt="Cherne" />
            <span class="nav-title" id="navAppTitle">${escapeHtml(appTitle)}</span>
            <select id="navLangSelect" aria-label="Language">
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="so">Soomaali</option>
              <option value="km">ខ្មែរ</option>
            </select>
          </div>
          <div class="right"></div>
        </div>
      `;

      const sel = document.getElementById("navLangSelect");
      if (sel) sel.value = lang;

      const titleEl = document.getElementById("navAppTitle");

      sel?.addEventListener("change", async () => {
        const next = sel.value || "en";
        localStorage.setItem(LANG_KEY, next);

        if (typeof I18N !== "undefined" && I18N?.load) {
          await I18N.load(next);
          if (titleEl) titleEl.textContent = I18N.t("app_title");
        } else {
          if (titleEl) titleEl.textContent = "CHERNE Assist";
        }

        window.dispatchEvent(new CustomEvent("cherneassist:langChanged", { detail: { lang: next } }));
      });

      return;
    }

    // =====================================================
    // NON-TABLET PAGES (dashboard/history/molds/oven/etc.)
    // Determine dept context
    // =====================================================
    const currentDept =
      (pageType === "dashboard" || pageType === "history")
        ? (pageKey || "quality")
        : (pageType === "molds")
          ? "maintenance"
          : (pageType === "oven")
            ? "supervisor"
            : "quality";

    const themeInfo = applyThemeForDept(currentDept);

    const contextLinkHtml =
      pageType === "dashboard"
        ? `<a href="/history/${encodeURIComponent(currentDept)}">${escapeHtml("History")}</a>`
        : pageType === "history"
          ? `<a href="/dashboard/${encodeURIComponent(currentDept)}">${escapeHtml("Back to Dashboard")}</a>`
          : "";

    const ovenLinkHtml =
      (pageType === "dashboard" || pageType === "history") && currentDept === "supervisor"
        ? `<a href="/oven">${escapeHtml("Oven Performance")}</a>`
        : "";

    const moldLinkHtml =
      (pageType === "dashboard" && currentDept === "maintenance")
        ? `<a href="/molds">${escapeHtml("Mold Cleaning")}</a>`
        : "";

    const respondersBtnHtml =
      pageType === "history"
        ? `<button id="navManageResponders" class="btn secondary" type="button">${escapeHtml("Manage Responders")}</button>`
        : "";

    const showDeptPicker =
      pageType === "dashboard" || pageType === "history" || pageType === "molds" || pageType === "oven";

    const deptOptionsHtml = depts.map((d) => {
      const selected = d.id === currentDept ? "selected" : "";
      return `<option value="${escapeAttr(d.id)}" ${selected}>${escapeHtml(d.name)}</option>`;
    }).join("");

    const cellOptionsHtml =
      `<option value="">${escapeHtml("Select…")}</option>` +
      cells.map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)}</option>`).join("");

    const showThemeToggle = isThemeCapablePage();

    mount.innerHTML = `
      <div class="topnav">
        <div class="left">
          <img
            id="navLogo"
            class="nav-logo"
            src="/assets/logo.svg"
            data-default="/assets/logo.svg"
            data-hover="/assets/logo-hover.svg"
            alt="CHERNE Assist"
          />
          <span class="nav-title">CHERNE Assist</span>
          ${contextLinkHtml}
          ${ovenLinkHtml}
          ${moldLinkHtml}
          ${respondersBtnHtml}
        </div>

        <div class="right">
          ${showDeptPicker ? `
            <span class="badge">${escapeHtml("Dashboard:")}</span>
            <select id="dashPicker" aria-label="Select department">
              ${deptOptionsHtml}
            </select>
          ` : ""}

          <span class="badge">${escapeHtml("Cell:")}</span>
          <select id="cellPicker" aria-label="Select cell">
            ${cellOptionsHtml}
          </select>

          ${showThemeToggle ? `
            <div class="theme-toggle" title="Toggle theme (per department)">
              <span class="label">${escapeHtml("Theme")}</span>
              <button
                id="themeSwitch"
                class="switch"
                type="button"
                aria-label="Toggle theme"
                data-on="${themeInfo.isDark ? "true" : "false"}"
              ></button>
            </div>
          ` : ""}
        </div>
      </div>
    `;

    // ✅ wire hover swap AFTER HTML is inserted (and not on tablets)
    wireLogoHoverSwap();

    // Dept picker
    const dashPicker = document.getElementById("dashPicker");
    dashPicker?.addEventListener("change", () => {
      const target = dashPicker.value;
      if (!target) return;
      if (pageType === "history") location.href = `/history/${encodeURIComponent(target)}`;
      else location.href = `/dashboard/${encodeURIComponent(target)}`;
    });

    // Cell picker
    const cellPicker = document.getElementById("cellPicker");
    cellPicker?.addEventListener("change", () => {
      const v = cellPicker.value;
      if (v) location.href = `/cell/${encodeURIComponent(v)}`;
    });

    // Theme toggle
    const themeSwitch = document.getElementById("themeSwitch");
    themeSwitch?.addEventListener("click", () => {
      if (!themeInfo.key) return;
      const on = themeSwitch.getAttribute("data-on") === "true";
      const next = !on;
      themeSwitch.setAttribute("data-on", next ? "true" : "false");
      localStorage.setItem(themeInfo.key, next ? "dark" : "light");
      document.documentElement.classList.toggle("theme-dark", next);
    });

    // Responders modal event
    const navManageBtn = document.getElementById("navManageResponders");
    navManageBtn?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("flooralerts:openResponders"));
    });
  })();
})();