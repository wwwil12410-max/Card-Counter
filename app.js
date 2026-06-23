(function () {
  "use strict";

  var ACCESS_PASSWORD = "19970402";
  var AUTH_KEY = "poker-counter-auth-ok";
  var RANKS = [
    { key: "big", label: "大", keyLabel: "大\n王", perDeck: 1 },
    { key: "small", label: "小", keyLabel: "小\n王", perDeck: 1 },
    { key: "2", label: "2", keyLabel: "2", perDeck: 4 },
    { key: "A", label: "A", keyLabel: "A", perDeck: 4 },
    { key: "K", label: "K", keyLabel: "K", perDeck: 4 },
    { key: "Q", label: "Q", keyLabel: "Q", perDeck: 4 },
    { key: "J", label: "J", keyLabel: "J", perDeck: 4 },
    { key: "10", label: "10", keyLabel: "10", perDeck: 4 },
    { key: "9", label: "9", keyLabel: "9", perDeck: 4 },
    { key: "8", label: "8", keyLabel: "8", perDeck: 4 },
    { key: "7", label: "7", keyLabel: "7", perDeck: 4 },
    { key: "6", label: "6", keyLabel: "6", perDeck: 4 },
    { key: "5", label: "5", keyLabel: "5", perDeck: 4 },
    { key: "4", label: "4", keyLabel: "4", perDeck: 4 },
    { key: "3", label: "3", keyLabel: "3", perDeck: 4 }
  ];

  var DEFAULT_STATE = {
    redDecks: 4,
    blueDecks: 4,
    activeColor: "red",
    currentRank: "Q",
    counts: null,
    updatedAt: null
  };

  var els = {};
  var state = null;
  var roomId = "";
  var supabaseClient = null;
  var roomChannel = null;
  var saveTimer = null;
  var toastTimer = null;
  var remoteApplying = false;

  document.addEventListener("DOMContentLoaded", startWithPassword);

  function startWithPassword() {
    els.authGate = document.getElementById("authGate");
    els.authForm = document.getElementById("authForm");
    els.passwordInput = document.getElementById("passwordInput");
    els.authError = document.getElementById("authError");
    els.appShell = document.getElementById("appShell");

    if (window.localStorage.getItem(AUTH_KEY) === ACCESS_PASSWORD) {
      unlockApp();
      return;
    }

    els.authGate.classList.remove("is-hidden");
    els.passwordInput.focus();
    els.authForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (els.passwordInput.value.trim() !== ACCESS_PASSWORD) {
        els.authError.textContent = "密码不正确";
        els.passwordInput.select();
        return;
      }
      window.localStorage.setItem(AUTH_KEY, ACCESS_PASSWORD);
      unlockApp();
    });
  }

  function unlockApp() {
    els.authGate.classList.add("is-hidden");
    els.appShell.classList.remove("is-hidden");
    initApp();
  }

  function initApp() {
    collectElements();
    renderStaticParts();
    roomId = getOrCreateRoomId();
    state = loadLocalState(roomId) || createFreshState(DEFAULT_STATE.redDecks, DEFAULT_STATE.blueDecks);
    state = normalizeState(state);
    bindEvents();
    render();
    setupSupabase();
  }

  function collectElements() {
    els.rankHeader = document.getElementById("rankHeader");
    els.redCounts = document.getElementById("redCounts");
    els.blueCounts = document.getElementById("blueCounts");
    els.keypad = document.getElementById("keypad");
    els.roomSummary = document.getElementById("roomSummary");
    els.currentCard = document.getElementById("currentCard");
    els.activeColorLabel = document.getElementById("activeColorLabel");
    els.redDecksSelect = document.getElementById("redDecksSelect");
    els.blueDecksSelect = document.getElementById("blueDecksSelect");
    els.redTrackButton = document.getElementById("redTrackButton");
    els.blueTrackButton = document.getElementById("blueTrackButton");
    els.addCardButton = document.getElementById("addCardButton");
    els.minusCardButton = document.getElementById("minusCardButton");
    els.resetButton = document.getElementById("resetButton");
    els.newRoomButton = document.getElementById("newRoomButton");
    els.copyLinkButton = document.getElementById("copyLinkButton");
    els.homeButton = document.getElementById("homeButton");
    els.syncStatus = document.getElementById("syncStatus");
    els.toast = document.getElementById("toast");
  }

  function renderStaticParts() {
    els.rankHeader.innerHTML = "";
    els.redCounts.innerHTML = "";
    els.blueCounts.innerHTML = "";
    els.keypad.innerHTML = "";

    RANKS.forEach(function (rank) {
      els.rankHeader.appendChild(createCell(rank.label));
      els.redCounts.appendChild(createCell("0", "red-count-" + rank.key));
      els.blueCounts.appendChild(createCell("0", "blue-count-" + rank.key));

      var button = document.createElement("button");
      button.type = "button";
      button.className = "card-key" + (rank.key === "big" || rank.key === "small" ? " joker" : "");
      button.dataset.rank = rank.key;
      button.innerText = rank.keyLabel;
      els.keypad.appendChild(button);
    });
  }

  function createCell(text, id) {
    var cell = document.createElement("div");
    cell.className = "rank-cell";
    if (id) {
      cell.id = id;
    }
    cell.textContent = text;
    return cell;
  }

  function bindEvents() {
    els.keypad.addEventListener("click", function (event) {
      var button = event.target.closest(".card-key");
      if (!button) {
        return;
      }
      playRank(button.dataset.rank);
    });

    els.redTrackButton.addEventListener("click", function () {
      setActiveColor("red");
    });
    els.blueTrackButton.addEventListener("click", function () {
      setActiveColor("blue");
    });

    els.addCardButton.addEventListener("click", function () {
      adjustCurrentRank(1);
    });
    els.minusCardButton.addEventListener("click", function () {
      adjustCurrentRank(-1);
    });

    els.resetButton.addEventListener("click", function () {
      if (window.confirm("按当前红蓝副数重新开始这一局？")) {
        state = createFreshState(Number(els.redDecksSelect.value), Number(els.blueDecksSelect.value));
        saveAndRender("牌局已重新开始");
      }
    });

    els.newRoomButton.addEventListener("click", function () {
      if (!window.confirm("创建一局全新的共享牌局？")) {
        return;
      }
      roomId = createRoomId();
      setRoomIdInUrl(roomId);
      state = createFreshState(DEFAULT_STATE.redDecks, DEFAULT_STATE.blueDecks);
      teardownChannel();
      render();
      saveAndRender("已创建新牌局");
      setupSupabase();
    });

    els.copyLinkButton.addEventListener("click", copyRoomLink);
    els.homeButton.addEventListener("click", function () {
      setRoomIdInUrl(roomId);
      showToast("已回到当前牌局链接");
    });

    els.redDecksSelect.addEventListener("change", function () {
      changeDeckCount("red", Number(els.redDecksSelect.value));
    });
    els.blueDecksSelect.addEventListener("change", function () {
      changeDeckCount("blue", Number(els.blueDecksSelect.value));
    });

    window.addEventListener("beforeunload", persistLocal);
  }

  function setupSupabase() {
    var config = window.POKER_COUNTER_CONFIG || {};
    var url = (config.supabaseUrl || "").trim();
    var key = (config.supabaseAnonKey || "").trim();

    if (!url || !key || !window.supabase) {
      els.syncStatus.textContent = "本地模式：填入 Supabase 配置后可多人共享";
      persistLocal();
      return;
    }

    supabaseClient = window.supabase.createClient(url, key);
    els.syncStatus.textContent = "正在连接共享牌局...";

    fetchRoom()
      .then(subscribeRoom)
      .catch(function () {
        els.syncStatus.textContent = "云端连接失败，当前使用本地模式";
        persistLocal();
      });
  }

  function fetchRoom() {
    return supabaseClient
      .from("rooms")
      .select("state")
      .eq("id", roomId)
      .maybeSingle()
      .then(function (result) {
        if (result.error) {
          throw result.error;
        }
        if (result.data && result.data.state) {
          remoteApplying = true;
          state = normalizeState(result.data.state);
          persistLocal();
          render();
          remoteApplying = false;
          els.syncStatus.textContent = "云端已同步";
          return;
        }
        return saveRemoteNow().then(function () {
          els.syncStatus.textContent = "云端已创建牌局";
        });
      });
  }

  function subscribeRoom() {
    teardownChannel();
    roomChannel = supabaseClient
      .channel("room-" + roomId)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms", filter: "id=eq." + roomId },
        function (payload) {
          if (!payload.new || !payload.new.state) {
            return;
          }
          var incoming = normalizeState(payload.new.state);
          if (state.updatedAt && incoming.updatedAt && incoming.updatedAt < state.updatedAt) {
            return;
          }
          remoteApplying = true;
          state = incoming;
          persistLocal();
          render();
          remoteApplying = false;
          els.syncStatus.textContent = "云端已同步";
        }
      )
      .subscribe(function (status) {
        if (status === "SUBSCRIBED") {
          els.syncStatus.textContent = "共享模式：同一链接实时同步";
        }
      });
  }

  function teardownChannel() {
    if (supabaseClient && roomChannel) {
      supabaseClient.removeChannel(roomChannel);
    }
    roomChannel = null;
  }

  function playRank(rankKey) {
    state.currentRank = rankKey;
    adjustRank(rankKey, -1);
  }

  function adjustCurrentRank(delta) {
    adjustRank(state.currentRank, delta);
  }

  function adjustRank(rankKey, delta) {
    var color = state.activeColor;
    var counts = state.counts[color];
    var current = counts[rankKey] || 0;
    var max = maxCountFor(color, rankKey);
    var next = clamp(current + delta, 0, max);

    if (next === current) {
      render();
      showToast(delta < 0 ? colorLabel(color) + rankLabel(rankKey) + " 已经没有了" : colorLabel(color) + rankLabel(rankKey) + " 已经是上限");
      return;
    }

    counts[rankKey] = next;
    saveAndRender(colorLabel(color) + rankLabel(rankKey) + (delta < 0 ? " -1" : " +1"));
  }

  function setActiveColor(color) {
    if (state.activeColor === color) {
      return;
    }
    state.activeColor = color;
    saveAndRender("已切换到" + colorLabel(color));
  }

  function changeDeckCount(color, deckCount) {
    deckCount = clamp(deckCount, 1, 4);
    if (state[color + "Decks"] === deckCount) {
      return;
    }
    state[color + "Decks"] = deckCount;
    state.counts[color] = createCounts(deckCount);
    saveAndRender(colorLabel(color) + "已重置为 " + deckCount + " 副");
  }

  function saveAndRender(message) {
    state.updatedAt = new Date().toISOString();
    persistLocal();
    render();
    if (message) {
      showToast(message);
    }
    scheduleRemoteSave();
  }

  function scheduleRemoteSave() {
    if (remoteApplying || !supabaseClient) {
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveRemoteNow().catch(function () {
        els.syncStatus.textContent = "云端保存失败，稍后可重试";
      });
    }, 120);
  }

  function saveRemoteNow() {
    if (!supabaseClient) {
      return Promise.resolve();
    }
    els.syncStatus.textContent = "正在保存...";
    return supabaseClient
      .from("rooms")
      .upsert({ id: roomId, state: state, updated_at: new Date().toISOString() })
      .then(function (result) {
        if (result.error) {
          throw result.error;
        }
        els.syncStatus.textContent = "云端已保存";
      });
  }

  function render() {
    state = normalizeState(state);
    els.redDecksSelect.value = String(state.redDecks);
    els.blueDecksSelect.value = String(state.blueDecks);
    els.currentCard.textContent = rankLabel(state.currentRank);
    els.activeColorLabel.textContent = colorLabel(state.activeColor);
    els.activeColorLabel.className = state.activeColor === "red" ? "red-text" : "blue-text";
    els.roomSummary.textContent = "红 " + state.redDecks + " 副 / 蓝 " + state.blueDecks + " 副 / 剩余 " + totalRemaining() + " 张";

    els.redTrackButton.classList.toggle("active", state.activeColor === "red");
    els.blueTrackButton.classList.toggle("active", state.activeColor === "blue");

    RANKS.forEach(function (rank) {
      var redCell = document.getElementById("red-count-" + rank.key);
      var blueCell = document.getElementById("blue-count-" + rank.key);
      var redValue = state.counts.red[rank.key] || 0;
      var blueValue = state.counts.blue[rank.key] || 0;
      redCell.textContent = String(redValue);
      blueCell.textContent = String(blueValue);
      redCell.classList.toggle("empty-count", redValue === 0);
      blueCell.classList.toggle("empty-count", blueValue === 0);
      redCell.classList.toggle("current-red", state.activeColor === "red" && state.currentRank === rank.key);
      blueCell.classList.toggle("current-blue", state.activeColor === "blue" && state.currentRank === rank.key);
    });

    Array.prototype.forEach.call(els.keypad.querySelectorAll(".card-key"), function (button) {
      var rankKey = button.dataset.rank;
      button.classList.toggle("selected", rankKey === state.currentRank);
      button.classList.toggle("disabled", false);
    });
  }

  function createFreshState(redDecks, blueDecks) {
    return normalizeState({
      redDecks: clamp(redDecks || 4, 1, 4),
      blueDecks: clamp(blueDecks || 4, 1, 4),
      activeColor: "red",
      currentRank: "Q",
      counts: {
        red: createCounts(redDecks || 4),
        blue: createCounts(blueDecks || 4)
      },
      updatedAt: new Date().toISOString()
    });
  }

  function createCounts(deckCount) {
    var counts = {};
    RANKS.forEach(function (rank) {
      counts[rank.key] = rank.perDeck * deckCount;
    });
    return counts;
  }

  function normalizeState(rawState) {
    var next = Object.assign({}, DEFAULT_STATE, rawState || {});
    next.redDecks = clamp(Number(next.redDecks) || 4, 1, 4);
    next.blueDecks = clamp(Number(next.blueDecks) || 4, 1, 4);
    next.activeColor = next.activeColor === "blue" ? "blue" : "red";
    next.currentRank = RANKS.some(function (rank) { return rank.key === next.currentRank; }) ? next.currentRank : "Q";
    next.counts = next.counts || {};
    next.counts.red = normalizeCounts(next.counts.red, next.redDecks);
    next.counts.blue = normalizeCounts(next.counts.blue, next.blueDecks);
    next.updatedAt = next.updatedAt || new Date().toISOString();
    return next;
  }

  function normalizeCounts(counts, deckCount) {
    var fallback = createCounts(deckCount);
    var next = {};
    RANKS.forEach(function (rank) {
      next[rank.key] = clamp(Number(counts && counts[rank.key]) || 0, 0, fallback[rank.key]);
    });
    return next;
  }

  function maxCountFor(color, rankKey) {
    var rank = RANKS.find(function (item) {
      return item.key === rankKey;
    });
    var deckCount = color === "red" ? state.redDecks : state.blueDecks;
    return (rank ? rank.perDeck : 4) * deckCount;
  }

  function totalRemaining() {
    return sumCounts(state.counts.red) + sumCounts(state.counts.blue);
  }

  function sumCounts(counts) {
    return RANKS.reduce(function (sum, rank) {
      return sum + (counts[rank.key] || 0);
    }, 0);
  }

  function getOrCreateRoomId() {
    var params = new URLSearchParams(window.location.search);
    var existing = params.get("roomId");
    if (existing && /^[a-zA-Z0-9_-]{6,48}$/.test(existing)) {
      return existing;
    }
    var id = createRoomId();
    setRoomIdInUrl(id);
    return id;
  }

  function createRoomId() {
    var bytes = new Uint8Array(9);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function setRoomIdInUrl(id) {
    var url = new URL(window.location.href);
    url.searchParams.set("roomId", id);
    window.history.replaceState({}, "", url.toString());
  }

  function storageKey() {
    return "poker-counter-room-" + roomId;
  }

  function loadLocalState(id) {
    try {
      var saved = window.localStorage.getItem("poker-counter-room-" + id);
      return saved ? JSON.parse(saved) : null;
    } catch (error) {
      return null;
    }
  }

  function persistLocal() {
    if (!state) {
      return;
    }
    try {
      window.localStorage.setItem(storageKey(), JSON.stringify(state));
    } catch (error) {
      // Local persistence is best-effort.
    }
  }

  function copyRoomLink() {
    var link = window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () {
        showToast("牌局链接已复制");
      }).catch(fallbackCopy);
      return;
    }
    fallbackCopy();

    function fallbackCopy() {
      window.prompt("复制这个牌局链接", link);
    }
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add("show");
    toastTimer = setTimeout(function () {
      els.toast.classList.remove("show");
    }, 1600);
  }

  function rankLabel(rankKey) {
    var rank = RANKS.find(function (item) {
      return item.key === rankKey;
    });
    if (!rank) {
      return rankKey;
    }
    if (rank.key === "big") {
      return "大王";
    }
    if (rank.key === "small") {
      return "小王";
    }
    return rank.label;
  }

  function colorLabel(color) {
    return color === "blue" ? "蓝牌" : "红牌";
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
