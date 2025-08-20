// ===== Injected on farcaster.xyz pages (no settings panel) =====
(function () {
    let currentSymbol = "";

    // Load symbol (and other settings if needed)
    chrome.runtime.sendMessage({ type: "getSettings" }, (res) => {
        if (res?.ok && res.settings) {
            currentSymbol = res.settings.tokenSymbol || "";
        }
    });

    function normalizeUsername(s) {
        if (!s) return "";
        return String(s).trim().replace(/^@/, "").toLowerCase();
    }

    // Only anchors with visible username text; ignore avatar/route links.
    function findUsernameElements(root = document) {
        const seenEls = new Set();
        const pairs = [];

        const pushIf = (el, uname) => {
            if (!uname) return;
            const u = normalizeUsername(uname);
            if (!u || seenEls.has(el)) return;
            seenEls.add(el);
            pairs.push([el, u]);
        };

        root.querySelectorAll('a[href^="/"]').forEach((a) => {
            const href = a.getAttribute("href") || "";
            const text = (a.textContent || "").trim();
            if (!text) return; // avatar/empty anchors

            const m = href.match(
                /^\/(?!channel\/|casts?\/|tx\/|~\/|notifications|settings|compose|search)([a-zA-Z0-9._-]+)$/
            );
            if (!m || !m[1]) return;

            if (normalizeUsername(text) !== normalizeUsername(m[1])) return; // must match
            pushIf(a, m[1]);
        });

        // optional fallback
        root.querySelectorAll("[data-username]").forEach((el) => {
            const t = (el.getAttribute("data-username") || "").trim();
            if (t) pushIf(el, t);
        });

        return pairs;
    }

    // Badge is always placed AFTER the anchor (never inside)
    function ensureBadge(el) {
        let sib = el.nextSibling;
        if (sib && sib.nodeType === 1 && sib.classList?.contains("fcb-badge")) return sib;

        const badge = document.createElement("span");
        badge.className = "fcb-badge";
        badge.textContent = "…";
        el.insertAdjacentElement("afterend", badge);
        return badge;
    }

    function setBadge(badge, text) {
        badge.textContent = text ?? "—";
    }

    // Truncate (not round) to two decimals
    function truncate2Decimals(strish) {
        if (strish == null) return "0";
        const s = String(strish);
        const i = s.indexOf(".");
        if (i === -1) return s;
        return s.slice(0, i + 3); // keep '.' + 2 digits
    }

    // Add thousands separators (keeps leading "-" if present)
    function addCommas(strish) {
        if (strish == null) return "0";
        const s = String(strish);
        const neg = s.startsWith("-") ? "-" : "";
        const body = neg ? s.slice(1) : s;
        const [intPart, fracPart] = body.split(".");
        const intWithCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        return neg + (fracPart != null ? `${intWithCommas}.${fracPart}` : intWithCommas);
    }


    function renderBalance(formatted) {
        const n = addCommas(truncate2Decimals(formatted)); // << apply commas
        return currentSymbol ? `${n} ${currentSymbol}` : n;
    }

    function statusToText(res) {
        if (!res?.ok) return "—";
        switch (res.status) {
            case "cached": return renderBalance(res.balanceFormatted);
            case "fetched": return renderBalance(res.balanceFormatted);
            case "no-contract": return "set contract";
            case "needs-key": return "set key";
            case "queued-wallet":
            case "queued-balance":
            case "stale-queued-balance": return "…";
            default: return "—";
        }
    }

    function handleUsername(el, username) {
        const badge = ensureBadge(el);
        chrome.runtime.sendMessage({ type: "ensureBalance", username }, (res) => {
            setBadge(badge, statusToText(res));
        });
    }

    function scan() {
        const pairs = findUsernameElements(document);
        for (const [el, uname] of pairs) handleUsername(el, uname);
    }

    // Debounced re-scan
    let scanTimer = null;
    function scheduleScanSoon() {
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, 150);
    }

    // Observe DOM for infinite scroll insertions
    const mo = new MutationObserver((muts) => {
        for (const m of muts) {
            if (m.addedNodes && m.addedNodes.length) scheduleScanSoon();
        }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // Initial scan
    scan();

    // Live push from background when a balance is written
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type !== "balanceUpdated") return;
        const { username, formatted } = msg;
        if (!username) return;

        // Update every badge adjacent to a matching username link
        document.querySelectorAll('a[href^="/"]').forEach((a) => {
            const href = a.getAttribute("href") || "";
            const text = (a.textContent || "").trim();
            const m = href.match(/^\/([a-zA-Z0-9._-]+)$/);
            if (!m || !m[1] || !text) return;
            if (normalizeUsername(text) !== normalizeUsername(username)) return;

            const badge = ensureBadge(a);
            setBadge(badge, renderBalance(formatted));
        });
    });

    // Storage changes -> refresh and react to symbol updates
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        if (changes["balances"]) scheduleScanSoon();
        if (changes["settings"] && changes["settings"].newValue) {
            const s = changes["settings"].newValue;
            currentSymbol = s.tokenSymbol || "";
            scheduleScanSoon();
        }
    });
})();
