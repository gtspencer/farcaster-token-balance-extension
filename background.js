// ===== Farcaster balances: MV3 service worker =====

// ---------- Storage keys ----------
const K = {
  SETTINGS: "settings",
  USER_TO_ADDR: "usernameToAddress",
  BALANCES: "balances",
  DECIMALS: "decimalsByContract"
};

// ---------- Defaults ----------
const DEFAULTS = {
  rpcUrl: "https://mainnet.base.org", // Base mainnet public RPC (edit in popup)
  contractAddress: "", // BETR 0x051024B653E8ec69E72693F776c41C2A9401FB07
  neynarApiKey: "", // https://dev.neynar.com/home
  tokenSymbol: "" // e.g. "BETR"
};

// ---------- TTL ----------
const TTL_MS = 30 * 60 * 1000; // 30 minutes

// ---------- In-memory mirrors ----------
let settings = { ...DEFAULTS };
let usernameToAddress = {};
/** balances[contract][username] = { hex: "0x...", ts: epochMs, formatted: "..." } */
let balances = {};
let decimalsByContract = {};

// ---------- Queues & inflight sets ----------
/** usernames needing wallet lookup */
const walletQueue = [];
/** { username, contract } needing balance fetch */
const balancesQueue = [];

let processingWallets = false;
let processingBalances = false;

const inFlightWallets = new Set();     // usernames
const inFlightBalances = new Set();    // `${contract}|${username}`

// ---------- Utils ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const toLowerHex = (s) => (s || "").toLowerCase();
const isHexAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s || "");
const strip0x = (h) => h?.startsWith("0x") ? h.slice(2) : h || "";
const pad32 = (hexNoPrefix) => hexNoPrefix.padStart(64, "0");

function encodeBalanceOfData(addr) {
  // balanceOf(address) = 0x70a08231 + 32-byte padded address
  const selector = "70a08231";
  const padded = pad32(strip0x(addr).toLowerCase());
  return "0x" + selector + padded;
}
function encodeDecimalsData() {
  // decimals() = 0x313ce567
  return "0x313ce567";
}

function hexToBigInt0x(hex) {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

function formatUnits(valueBigInt, decimals) {
  const neg = valueBigInt < 0n;
  let s = (neg ? -valueBigInt : valueBigInt).toString();
  const d = Math.max(0, decimals | 0);
  if (d === 0) return (neg ? "-" : "") + s;
  if (s.length <= d) s = s.padStart(d + 1, "0");
  const i = s.length - d;
  const whole = s.slice(0, i);
  let frac = s.slice(i).replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}

async function loadAll() {
  const res = await chrome.storage.local.get([K.SETTINGS, K.USER_TO_ADDR, K.BALANCES, K.DECIMALS]);
  settings = { ...DEFAULTS, ...(res[K.SETTINGS] || {}) };
  usernameToAddress = res[K.USER_TO_ADDR] || {};
  balances = res[K.BALANCES] || {};
  decimalsByContract = res[K.DECIMALS] || {};
  await evictExpiredBalances();
}

async function savePartial(obj) {
  await chrome.storage.local.set(obj);
}

function ensureContractBucket(contract) {
  if (!balances[contract]) balances[contract] = {};
}

function isFresh(ts) {
  return typeof ts === "number" && now() - ts < TTL_MS;
}

async function evictExpiredBalances() {
  let mutated = false;
  const cutoff = now() - TTL_MS;
  for (const contract of Object.keys(balances)) {
    const byUser = balances[contract];
    for (const uname of Object.keys(byUser)) {
      const rec = byUser[uname];
      if (!rec || typeof rec.ts !== "number" || rec.ts < cutoff) {
        delete byUser[uname];
        mutated = true;
      }
    }
    if (Object.keys(byUser).length === 0) {
      delete balances[contract];
      mutated = true;
    }
  }
  if (mutated) await savePartial({ [K.BALANCES]: balances });
}

// ---------- Neynar lookup ----------
async function fetchWalletForUsername(username) {
  const key = settings.neynarApiKey;
  if (!key) return null;

  const url = `https://api.neynar.com/v2/farcaster/user/by_username?username=${encodeURIComponent(username)}`;
  try {
    const resp = await fetch(url, {
      headers: { "accept": "application/json", "api_key": key }
    });
    if (!resp.ok) throw new Error(`Neynar status ${resp.status}`);
    const data = await resp.json();
    const u = data?.user || {};
    const primary = u?.verified_addresses?.primary?.eth_address || "";
    return isHexAddress(primary) ? primary.toLowerCase() : null;
  } catch {
    return null;
  }
}

// ---------- JSON-RPC ----------
async function ethCall(to, data, rpcUrl) {
  const body = { jsonrpc: "2.0", id: Date.now(), method: "eth_call", params: [{ to, data }, "latest"] };
  const resp = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`RPC ${resp.status}`);
  const j = await resp.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

async function getDecimalsForContract(contract) {
  const c = toLowerHex(contract);
  if (decimalsByContract[c] != null) return decimalsByContract[c];
  try {
    const res = await ethCall(c, encodeDecimalsData(), settings.rpcUrl);
    const n = Number(hexToBigInt0x(res));
    if (Number.isFinite(n) && n >= 0 && n <= 36) {
      decimalsByContract[c] = n;
      await savePartial({ [K.DECIMALS]: decimalsByContract });
      return n;
    }
  } catch { /* ignore */ }
  decimalsByContract[c] = 18;
  await savePartial({ [K.DECIMALS]: decimalsByContract });
  return 18;
}

async function fetchBalanceOf(contract, wallet) {
  const data = encodeBalanceOfData(wallet);
  const result = await ethCall(contract, data, settings.rpcUrl);
  return hexToBigInt0x(result);
}

// ---------- Queue helpers ----------
function enqueueWallet(username) {
  if (!username || inFlightWallets.has(username)) return;
  if (!walletQueue.includes(username)) walletQueue.push(username);
  void processWalletQueue();
}

function enqueueBalance(username, contract) {
  if (!username || !isHexAddress(contract)) return;
  const key = `${contract}|${username}`;
  if (inFlightBalances.has(key)) return;
  const existing = balancesQueue.find(t => t.username === username && t.contract === contract);
  if (!existing) balancesQueue.push({ username, contract });
  void processBalancesQueue();
}

// ---------- Broadcast to all Farcaster tabs ----------
function broadcastBalanceUpdate(payload) {
  chrome.tabs.query(
    { url: ["*://farcaster.xyz/*", "*://*.farcaster.xyz/*"] },
    (tabs) => {
      for (const tab of tabs) {
        try {
          chrome.tabs.sendMessage(tab.id, payload, () => void chrome.runtime.lastError);
        } catch (_) { /* ignore */ }
      }
    }
  );
}

// ---------- Queue processors ----------
async function processWalletQueue() {
  if (processingWallets) return;
  processingWallets = true;
  try {
    while (walletQueue.length) {
      const username = walletQueue.shift();
      if (!username) continue;
      if (usernameToAddress[username]) continue; // done elsewhere
      inFlightWallets.add(username);

      try {
        const addr = await fetchWalletForUsername(username);
        if (addr) {
          usernameToAddress[username] = addr;
          await savePartial({ [K.USER_TO_ADDR]: usernameToAddress });

          // Once wallet is known, schedule a balance fetch if contract set
          const contract = toLowerHex(settings.contractAddress || "");
          if (isHexAddress(contract)) enqueueBalance(username, contract);
        }
      } finally {
        inFlightWallets.delete(username);
        await sleep(60);
      }
    }
  } finally {
    processingWallets = false;
  }
}

async function processBalancesQueue() {
  if (processingBalances) return;
  processingBalances = true;
  try {
    while (balancesQueue.length) {
      const { username, contract } = balancesQueue.shift() || {};
      if (!username || !isHexAddress(contract)) continue;

      const key = `${contract}|${username}`;
      if (inFlightBalances.has(key)) continue;
      inFlightBalances.add(key);

      try {
        const addr = usernameToAddress[username];
        if (!addr) {
          enqueueWallet(username); // wallet unknown; resolve first
          continue;
        }
        const [decimals, v] = await Promise.all([
          getDecimalsForContract(contract),
          fetchBalanceOf(contract, addr)
        ]);
        const hex = "0x" + v.toString(16);
        const formatted = formatUnits(v, decimals);

        ensureContractBucket(contract);
        balances[contract][username] = { hex, ts: now(), formatted };
        await savePartial({ [K.BALANCES]: balances });

        // Push live update to all content scripts
        broadcastBalanceUpdate({ type: "balanceUpdated", username, contract, hex, formatted });

        await sleep(100);
      } catch {
        // swallow per-user failures
      } finally {
        inFlightBalances.delete(key);
      }
    }
  } finally {
    processingBalances = false;
  }
}

// ---------- Public API (messages) ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "getSettings") {
        sendResponse({ ok: true, settings });
        return;
      }

      if (msg?.type === "setSettings") {
        settings = { ...settings, ...(msg.settings || {}) };
        await savePartial({ [K.SETTINGS]: settings });
        await evictExpiredBalances();
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "clearAll") {
        usernameToAddress = {};
        balances = {};
        decimalsByContract = {};
        await chrome.storage.local.set({
          [K.USER_TO_ADDR]: {},
          [K.BALANCES]: {},
          [K.DECIMALS]: {}
        });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "ensureBalance") {
        // msg: { username, contractAddress? }
        const username = String(msg.username || "").trim().toLowerCase();
        const contract = toLowerHex(msg.contractAddress || settings.contractAddress || "");

        if (!username) {
          sendResponse({ ok: false, error: "missing username" });
          return;
        }

        // Wallet known?
        const knownWallet = usernameToAddress[username];
        if (!knownWallet) {
          // early signal if Neynar key is missing
          if (!settings.neynarApiKey) {
            sendResponse({ ok: true, status: "needs-key" });
            return;
          }
          enqueueWallet(username);
          sendResponse({ ok: true, status: "queued-wallet" });
          return;
        }

        // Contract configured?
        if (!isHexAddress(contract)) {
          sendResponse({ ok: true, status: "no-contract" });
          return;
        }

        await evictExpiredBalances();

        const cached = balances?.[contract]?.[username];
        if (cached && isFresh(cached.ts)) {
          sendResponse({
            ok: true,
            status: "cached",
            balanceHex: cached.hex,
            balanceFormatted: cached.formatted,
            ts: cached.ts
          });
          return;
        }

        // Not fresh/missing -> enqueue
        enqueueBalance(username, contract);
        sendResponse({ ok: true, status: cached ? "stale-queued-balance" : "queued-balance" });
        return;
      }

      sendResponse({ ok: false, error: "unknown message" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true; // keep the channel open
});

// ---------- Boot (no top-level await in service workers) ----------
let initialized = false;
async function init() {
  if (initialized) return;
  initialized = true;
  try {
    await loadAll();
  } catch (e) {
    console.warn("init error", e);
  }
}
init();
chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());
