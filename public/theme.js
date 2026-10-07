// The theme a person picked, on the page before anything is drawn. The app
// puts it there too (src/main.jsx), but only once its own script has arrived,
// and until then the empty page was the old fixed purple in every theme: a
// purple flash before the light page that opens TameDuck, on the first visit
// after every update. A file of its own because the Content-Security-Policy
// is script-src 'self'. The key is the one src/Appearance.jsx saves.
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("tameduck-theme") || "electric";
} catch (e) {}
