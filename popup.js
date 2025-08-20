// Load current settings
document.addEventListener("DOMContentLoaded", () => {
  chrome.runtime.sendMessage({ type: "getSettings" }, (res) => {
    if (!res?.ok) return;
    const s = res.settings || {};
    $("rpc").value = s.rpcUrl || "";
    $("contract").value = s.contractAddress || "";
    $("neynar").value = s.neynarApiKey || "";
    $("symbol").value = s.tokenSymbol || "";
  });
});

$("save").addEventListener("click", async () => {
  const settings = {
    rpcUrl: $("rpc").value.trim(),
    contractAddress: $("contract").value.trim(),
    neynarApiKey: $("neynar").value.trim(),
    tokenSymbol: $("symbol").value.trim()
  };
  chrome.runtime.sendMessage({ type: "setSettings", settings }, (res) => {
    setStatus(res?.ok ? "Saved ✓" : "Save failed", !!res?.ok);
  });
});

$("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clearAll" }, (res) => {
    setStatus(res?.ok ? "Cleared ✓" : "Clear failed", !!res?.ok);
  });
});

function $(id) { return document.getElementById(id); }
function setStatus(text, ok) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("ok", !!ok);
  setTimeout(() => { s.textContent = ""; s.classList.remove("ok"); }, 1200);
}
