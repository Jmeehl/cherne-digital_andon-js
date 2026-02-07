// public/pwa.js
(() => {
  // Register service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // Ensure we have a manifest link on every page.
  // For /cell/:id pages, use a cell-specific manifest so each tablet can be “installed” for its cell.
  const parts = location.pathname.split("/").filter(Boolean);
  const pageType = parts[0] || "";
  const key = parts[1] || "";

  let manifestHref = "/manifest.json"; // default manifest (dashboards/history)
  if (pageType === "cell" && key) manifestHref = `/manifest/${encodeURIComponent(key)}.json`;

  let link = document.querySelector('link[rel="manifest"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "manifest";
    document.head.appendChild(link);
  }
  link.href = manifestHref;

  // iOS standalone hint (doesn't fully use manifest like Android/Chrome, but helps)
  // These tags are harmless on other platforms.
  const metaCapable = document.querySelector('meta[name="apple-mobile-web-app-capable"]') ||
    Object.assign(document.createElement("meta"), { name: "apple-mobile-web-app-capable", content: "yes" });
  if (!metaCapable.parentNode) document.head.appendChild(metaCapable);

  const metaStatusBar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]') ||
    Object.assign(document.createElement("meta"), { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" });
  if (!metaStatusBar.parentNode) document.head.appendChild(metaStatusBar);

  const metaTheme = document.querySelector('meta[name="theme-color"]') ||
    Object.assign(document.createElement("meta"), { name: "theme-color", content: "#000000" });
  if (!metaTheme.parentNode) document.head.appendChild(metaTheme);

  // Apple touch icon (iOS home screen icon)
const appleIcon =
  document.querySelector('link[rel="apple-touch-icon"][sizes="180x180"]') ||
  Object.assign(document.createElement("link"), {
    rel: "apple-touch-icon",
    sizes: "180x180",
    href: "/assets/apple-touch-icon-180x180.png"
  });

if (!appleIcon.parentNode) document.head.appendChild(appleIcon);

if (!appleIcon.parentNode) document.head.appendChild(appleIcon);
})();