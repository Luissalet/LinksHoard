const field = document.getElementById("url");
const state = document.getElementById("state");
chrome.storage.local.get("linksUrl").then(({ linksUrl }) => { field.value = linksUrl || "http://127.0.0.1:5181"; });
document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ linksUrl: field.value.trim() || "http://127.0.0.1:5181" });
  state.textContent = "Guardado.";
});
