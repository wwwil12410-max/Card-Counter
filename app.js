(function () {
  "use strict";

  var LOCAL_OWNER_PASSWORD = "";
  var AUTH_KEY = "poker-counter-session";
  var LAST_ROOM_KEY = "poker-counter-last-room";
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
    currentRank: "Q",
    counts: null,
    updatedAt: null
  };

  var els = {};
  var state = null;
  var roomId = "";
  var activeColor = "red";
  var session = null;
  var access = { closed: false };
  var supabaseClient = null;
  var roomChannel = null;
  var saveTimer = null;
  var toastTimer = null;
  var remoteApplying = false;
  var ownerPanelOpen = false;
  var eventsBound = false;
  var shareCardSuccessMessage = "链接已复制";
  var pendingShareMeta = null;

  document.addEventListener("DOMContentLoaded", boot);

  function boot() {
    collectBaseElements();
    bindAuthEvents();
    handleEntry();
  }

  function collectBaseElements() {
    els.bootScreen = document.getElementById("bootScreen");
    els.authGate = document.getElementById("authGate");
    els.authForm = document.getElementById("authForm");
    els.passwordInput = document.getElementById("passwordInput");
    els.authError = document.getElementById("authError");
    els.appShell = document.getElementById("appShell");
  }

  function bindAuthEvents() {
    els.authForm.addEventListener("submit", function (event) {
      event.preventDefault();
      ownerLogin(els.passwordInput.value.trim());
    });
  }

  function handleEntry() {
    var params = new URLSearchParams(window.location.search);
    var grantToken = params.get("grantToken");
    var joinToken = params.get("joinToken");

    if (grantToken) {
      createRoomFromGrant(grantToken);
      return;
    }

    roomId = getOrCreateRoomId();
    session = loadSession();

    if (joinToken && !session) {
      joinWithToken(joinToken);
      return;
    }

    if (!session) {
      showLogin();
      return;
    }

    if (!cloudAuthReady() || session.mode === "local") {
      unlockApp();
      return;
    }

    authRequest({ action: "validate", roomId: roomId, token: session.token })
      .then(function (result) {
        applyAccessResult(result);
        unlockApp();
      })
      .catch(function () {
        clearSession();
        if (joinToken) {
          joinWithToken(joinToken);
        } else {
          showLogin("登录已失效，请重新输入登录密码");
        }
      });
  }

  function showLogin(message) {
    if (els.bootScreen) els.bootScreen.classList.add("is-hidden");
    els.appShell.classList.add("is-hidden");
    els.authGate.classList.remove("is-hidden");
    els.authError.textContent = message || "";
    els.passwordInput.value = "";
    els.passwordInput.focus();
  }

  function ownerLogin(password) {
    if (!password) {
      els.authError.textContent = "请输入登录密码";
      return;
    }
    els.authError.textContent = "";

    if (!cloudAuthReady()) {
      if (LOCAL_OWNER_PASSWORD && password !== LOCAL_OWNER_PASSWORD) {
        els.authError.textContent = "密码错误";
        els.passwordInput.select();
        return;
      }
      session = { mode: "local", role: "owner", token: "local", entry: "password" };
      saveSession(session);
      unlockApp();
      return;
    }

    ownerLoginRequest(password)
      .then(function (result) {
        session = { mode: "cloud", role: result.role, token: result.token, entry: "password" };
        saveSession(session);
        if (result.state) state = normalizeState(result.state);
        applyAccessResult(result);
        unlockApp();
      })
      .catch(function (error) {
        els.authError.textContent = friendlyAuthError(error);
        els.passwordInput.select();
      });
  }

  function ownerLoginRequest(password) {
    var payload = {
      action: "owner-login",
      roomId: roomId,
      password: password,
      initialState: createFreshState(DEFAULT_STATE.redDecks, DEFAULT_STATE.blueDecks)
    };
    return authRequest(payload).catch(function (error) {
      if (!isUnknownActionError(error)) throw error;
      return authRequest({
        action: "login",
        roomId: roomId,
        role: "owner",
        password: password,
        initialState: payload.initialState
      });
    });
  }

  function joinWithToken(joinToken) {
    if (!cloudAuthReady()) {
      showLogin("云端未配置，分享链接不能免密进入");
      return;
    }
    roomId = getRoomIdFromUrl();
    if (!roomId) {
      showLogin("分享链接缺少牌局编号");
      return;
    }
    authRequest({ action: "join-with-token", roomId: roomId, joinToken: joinToken })
      .then(function (result) {
        session = { mode: "cloud", role: result.role, token: result.token, entry: "join" };
        saveSession(session);
        if (result.state) state = normalizeState(result.state);
        removeUrlSecret("joinToken");
        applyAccessResult(result);
        unlockApp();
      })
      .catch(function (error) {
        showLogin(error.message || "玩家链接已失效");
      });
  }

  function createRoomFromGrant(grantToken) {
    if (!cloudAuthReady()) {
      showLogin("云端未配置，授权链接不能开局");
      return;
    }
    authRequest({
      action: "create-room-from-grant",
      grantToken: grantToken,
      initialState: createFreshState(DEFAULT_STATE.redDecks, DEFAULT_STATE.blueDecks)
    })
      .then(function (result) {
        roomId = result.roomId;
        session = { mode: "cloud", role: result.role, token: result.token, entry: "grant" };
        saveSession(session);
        if (result.state) state = normalizeState(result.state);
        replaceUrlWithRoom(roomId);
        applyAccessResult(result);
        unlockApp();
        showToast("已用朋友授权开好新牌局");
      })
      .catch(function (error) {
        showLogin(error.message || "授权链接已失效");
      });
  }

  function unlockApp() {
    if (els.bootScreen) els.bootScreen.classList.add("is-hidden");
    els.authGate.classList.add("is-hidden");
    els.appShell.classList.remove("is-hidden");
    initApp();
  }

  function initApp() {
    collectAppElements();
    renderStaticParts();
    activeColor = normalizeColor(loadLocalActiveColor(roomId));
    state = state || loadLocalState(roomId) || createFreshState(DEFAULT_STATE.redDecks, DEFAULT_STATE.blueDecks);
    state = normalizeState(state);
    bindAppEvents();
    render();
    setupSupabase();
  }

  function collectAppElements() {
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
    els.consoleButton = document.getElementById("consoleButton");
    els.logoutButton = document.getElementById("logoutButton");
    els.syncStatus = document.getElementById("syncStatus");
    els.toast = document.getElementById("toast");
    els.ownerPanel = document.getElementById("ownerPanel");
    els.ownerSheet = document.getElementById("ownerSheet");
    els.ownerSheetBackdrop = document.getElementById("ownerSheetBackdrop");
    els.ownerSheetClose = document.getElementById("ownerSheetClose");
    els.createJoinLinkButton = document.getElementById("createJoinLinkButton");
    els.createGrantLinkButton = document.getElementById("createGrantLinkButton");
    els.closeRoomButton = document.getElementById("closeRoomButton");
    els.expiryBanner = document.getElementById("expiryBanner");
    els.shareCard = document.getElementById("shareCard");
    els.shareCardBackdrop = document.getElementById("shareCardBackdrop");
    els.shareCardClose = document.getElementById("shareCardClose");
    els.shareCardTitle = document.getElementById("shareCardTitle");
    els.shareCardDesc = document.getElementById("shareCardDesc");
    els.shareCardLink = document.getElementById("shareCardLink");
    els.shareCardExpiry = document.getElementById("shareCardExpiry");
    els.shareCardCopy = document.getElementById("shareCardCopy");
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

  function bindAppEvents() {
    if (eventsBound) return;
    eventsBound = true;
    els.keypad.addEventListener("click", function (event) {
      var button = event.target.closest(".card-key");
      if (button) playRank(button.dataset.rank);
    });
    els.redTrackButton.addEventListener("click", function () { setActiveColor("red"); });
    els.blueTrackButton.addEventListener("click", function () { setActiveColor("blue"); });
    els.addCardButton.addEventListener("click", function () { adjustCurrentRank(1); });
    els.minusCardButton.addEventListener("click", function () { adjustCurrentRank(-1); });
    els.resetButton.addEventListener("click", resetRoom);
    els.consoleButton.addEventListener("click", toggleConsole);
    els.ownerSheetBackdrop.addEventListener("click", closeConsole);
    els.ownerSheetClose.addEventListener("click", closeConsole);
    els.shareCardBackdrop.addEventListener("click", closeShareCard);
    els.shareCardClose.addEventListener("click", closeShareCard);
    els.shareCardCopy.addEventListener("click", copyShareLink);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { closeShareCard(); closeConsole(); }
    });
    els.logoutButton.addEventListener("click", logout);
    els.redDecksSelect.addEventListener("change", function () {
      changeDeckCount("red", Number(els.redDecksSelect.value));
    });
    els.blueDecksSelect.addEventListener("change", function () {
      changeDeckCount("blue", Number(els.blueDecksSelect.value));
    });
    els.createJoinLinkButton.addEventListener("click", shareRoom);
    els.createGrantLinkButton.addEventListener("click", createGrantLink);
    els.closeRoomButton.addEventListener("click", toggleRoomClosed);
    window.addEventListener("beforeunload", persistLocal);
  }

  function setupSupabase() {
    var config = getConfig();
    if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase || !session || session.mode !== "cloud") {
      els.syncStatus.textContent = "未连接云端，当前仅本机计数";
      persistLocal();
      return;
    }
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    els.syncStatus.textContent = "";
    fetchRoom().then(subscribeRoom).catch(function () {
      els.syncStatus.textContent = "云端连接失败，当前使用本地缓存";
      persistLocal();
    });
  }

  function fetchRoom() {
    return supabaseClient.from("rooms").select("state").eq("id", roomId).maybeSingle().then(function (result) {
      if (result.error) throw result.error;
      if (result.data && result.data.state) {
        remoteApplying = true;
        state = normalizeState(result.data.state);
        persistLocal();
        render();
        remoteApplying = false;
      } else if (session && session.mode === "cloud") {
        scheduleRemoteSave();
      }
    });
  }

  function subscribeRoom() {
    teardownChannel();
    roomChannel = supabaseClient
      .channel("room-" + roomId)
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: "id=eq." + roomId }, function (payload) {
        if (!payload.new || !payload.new.state) return;
        var incoming = normalizeState(payload.new.state);
        if (state.updatedAt && incoming.updatedAt && incoming.updatedAt < state.updatedAt) return;
        remoteApplying = true;
        state = incoming;
        persistLocal();
        render();
        remoteApplying = false;
        els.syncStatus.textContent = "";
      })
      .subscribe(function (status) {
        if (status === "SUBSCRIBED") els.syncStatus.textContent = "";
      });
  }

  function teardownChannel() {
    if (supabaseClient && roomChannel) supabaseClient.removeChannel(roomChannel);
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
    if (!canEdit()) return;
    var counts = state.counts[activeColor];
    var current = counts[rankKey] || 0;
    var max = maxCountFor(activeColor, rankKey);
    var next = clamp(current + delta, 0, max);
    if (next === current) {
      render();
      showToast(delta < 0 ? colorLabel(activeColor) + rankLabel(rankKey) + " 已经没有了" : colorLabel(activeColor) + rankLabel(rankKey) + " 已经是上限");
      return;
    }
    counts[rankKey] = next;
    saveAndRender(colorLabel(activeColor) + rankLabel(rankKey) + (delta < 0 ? " -1" : " +1"));
  }

  function resetRoom() {
    if (!canEdit()) return;
    if (window.confirm("按当前红蓝副数重新开始这一局？")) {
      state = createFreshState(Number(els.redDecksSelect.value), Number(els.blueDecksSelect.value));
      saveAndRender("牌局已重新开始");
    }
  }

  function changeDeckCount(color, deckCount) {
    if (!canEdit()) {
      render();
      return;
    }
    deckCount = clamp(deckCount, 1, 4);
    if (state[color + "Decks"] === deckCount) return;
    state[color + "Decks"] = deckCount;
    state.counts[color] = createCounts(deckCount);
    saveAndRender(colorLabel(color) + "已重置为 " + deckCount + " 副");
  }

  function canEdit() {
    if (access.closed) {
      showToast("本局已关闭");
      return false;
    }
    if (!session) {
      showToast("请先进入牌局");
      return false;
    }
    return true;
  }

  function setActiveColor(color) {
    activeColor = normalizeColor(color);
    persistLocalActiveColor();
    render();
    showToast("已切换到" + colorLabel(activeColor));
  }

  function saveAndRender(message) {
    state.updatedAt = new Date().toISOString();
    persistLocal();
    render();
    if (message) showToast(message);
    scheduleRemoteSave();
  }

  function scheduleRemoteSave() {
    if (remoteApplying || !session || session.mode !== "cloud") return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveRemoteNow().catch(function (error) {
        els.syncStatus.textContent = error.message || "云端保存失败";
        recoverAfterRemoteReject(error);
      });
    }, 120);
  }

  function saveRemoteNow() {
    els.syncStatus.textContent = "";
    return authRequest({ action: "save-state", roomId: roomId, token: session.token, state: sharedStatePayload() })
      .then(function (result) {
        applyAccessResult(result);
        els.syncStatus.textContent = "";
      });
  }

  function recoverAfterRemoteReject(error) {
    if (!session || session.mode !== "cloud") return;
    authRequest({ action: "validate", roomId: roomId, token: session.token })
      .then(function (result) {
        applyAccessResult(result);
        if (result.state) {
          state = normalizeState(result.state);
          persistLocal();
          render();
        }
      })
      .catch(function () {
        if (error && /closed/i.test(error.message || "")) {
          access.closed = true;
          showToast("本局已关闭");
        }
        fetchRoom().catch(function () {
          render();
        });
      });
  }

  function toggleConsole() {
    if (!isOwner()) return;
    ownerPanelOpen = !ownerPanelOpen;
    renderOwnerPanel();
  }

  function closeConsole() {
    if (!ownerPanelOpen) return;
    ownerPanelOpen = false;
    renderOwnerPanel();
  }

  function shareRoom() {
    if (!session || session.mode !== "cloud" || !isOwner()) {
      showToast("只有房主可以邀请好友");
      return;
    }
    withGenerating(els.createJoinLinkButton, "邀请好友",
      ownerAction({ type: "create-join-link" }).then(function (result) {
        openShareCard({
          title: "邀请好友",
          desc: "好友点开链接免密加入本局，24h 内不限次数。",
          url: joinUrl(result.joinToken, result.expiresAt),
          expiresAt: result.expiresAt,
          successMessage: "邀请好友链接已复制"
        });
      })
    );
  }

  function createGrantLink() {
    if (!session || session.mode !== "cloud" || !isRealOwner()) {
      showToast("只有房主可以生成临时房主链接");
      return;
    }
    withGenerating(els.createGrantLinkButton, "临时房主",
      ownerAction({ type: "create-grant-link" }).then(function (result) {
        openShareCard({
          title: "临时房主",
          desc: "好友点开后成为临时房主，可以邀请其他好友，48h 内不限次数。",
          url: grantUrl(result.grantToken, result.expiresAt),
          expiresAt: result.expiresAt,
          successMessage: "临时房主链接已复制"
        });
      })
    );
  }

  function withGenerating(button, originalText, promise) {
    if (!button || !promise || !promise.then) return promise;
    button.disabled = true;
    button.textContent = "生成中…";
    return promise.catch(function (error) {
      return error;
    }).then(function () {
      button.disabled = false;
      button.textContent = originalText;
    });
  }

  function openShareCard(opts) {
    if (!els.shareCard) return;
    shareCardSuccessMessage = opts.successMessage || "链接已复制";
    pendingShareMeta = {
      title: opts.title,
      desc: opts.desc,
      expiresAt: opts.expiresAt,
      url: opts.url
    };
    els.shareCardTitle.textContent = opts.title;
    els.shareCardDesc.textContent = opts.desc;
    els.shareCardLink.value = opts.url;
    els.shareCardExpiry.textContent = opts.expiresAt ? "有效至 " + formatExpiry(opts.expiresAt) : "";
    els.shareCard.classList.add("open");
    els.shareCard.setAttribute("aria-hidden", "false");
  }

  function closeShareCard() {
    if (!els.shareCard) return;
    els.shareCard.classList.remove("open");
    els.shareCard.setAttribute("aria-hidden", "true");
  }

  function copyShareLink() {
    var meta = pendingShareMeta;
    var url = els.shareCardLink ? els.shareCardLink.value : "";
    if (!url) return;
    var lines = [];
    if (meta && meta.title) lines.push("【" + meta.title + "】");
    if (meta && meta.desc) lines.push(meta.desc);
    lines.push(url);
    if (meta && meta.expiresAt) lines.push("（有效至 " + formatExpiry(meta.expiresAt) + "）");
    var text = lines.join("\n");
    copyText(text, shareCardSuccessMessage);
  }

  function formatExpiry(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    var hh = date.getHours();
    var mm = date.getMinutes();
    return (date.getMonth() + 1) + "月" + date.getDate() + "日 " +
      (hh < 10 ? "0" + hh : hh) + ":" + (mm < 10 ? "0" + mm : mm);
  }

  function toggleRoomClosed() {
    if (!isOwner()) return;
    var nextClosed = !access.closed;
    var text = nextClosed ? "散场后，之前发的邀请好友链接将不能再进入。确认散场？" : "重新开局？";
    if (!window.confirm(text)) return;
    ownerAction({ type: "set-closed", closed: nextClosed }).then(function (result) {
      applyAccessResult(result);
      render();
      showToast(nextClosed ? "已散场" : "已重新开局");
    });
  }

  function ownerAction(payload) {
    if (!session || session.mode !== "cloud" || !isOwner()) {
      showToast("只有房主可以使用控制台");
      return Promise.reject(new Error("需要房主权限"));
    }
    return authRequest(Object.assign({ action: "owner-action", roomId: roomId, token: session.token }, payload))
      .then(function (result) {
        applyAccessResult(result);
        renderOwnerPanel();
        return result;
      })
      .catch(function (error) {
        showToast(error.message || "操作失败");
        throw error;
      });
  }

  function logout() {
    clearSession();
    teardownChannel();
    state = null;
    session = null;
    access = { closed: false };
    ownerPanelOpen = false;
    showLogin("已退出，请重新输入登录密码");
  }

  function render() {
    state = normalizeState(state);
    els.redDecksSelect.value = String(state.redDecks);
    els.blueDecksSelect.value = String(state.blueDecks);
    els.currentCard.textContent = rankLabel(state.currentRank);
    els.activeColorLabel.textContent = colorLabel(activeColor);
    els.activeColorLabel.className = activeColor === "red" ? "red-text" : "blue-text";
    els.roomSummary.textContent = "红 " + state.redDecks + " 副 / 蓝 " + state.blueDecks + " 副 / 剩余 " + totalRemaining() + " 张";
    renderExpiryBanner();
    els.redTrackButton.classList.toggle("active", activeColor === "red");
    els.blueTrackButton.classList.toggle("active", activeColor === "blue");
    RANKS.forEach(function (rank) {
      var redCell = document.getElementById("red-count-" + rank.key);
      var blueCell = document.getElementById("blue-count-" + rank.key);
      var redValue = state.counts.red[rank.key] || 0;
      var blueValue = state.counts.blue[rank.key] || 0;
      redCell.textContent = String(redValue);
      blueCell.textContent = String(blueValue);
      redCell.classList.toggle("empty-count", redValue === 0);
      blueCell.classList.toggle("empty-count", blueValue === 0);
      redCell.classList.toggle("current-red", activeColor === "red" && state.currentRank === rank.key);
      blueCell.classList.toggle("current-blue", activeColor === "blue" && state.currentRank === rank.key);
    });
    Array.prototype.forEach.call(els.keypad.querySelectorAll(".card-key"), function (button) {
      button.classList.toggle("selected", button.dataset.rank === state.currentRank);
    });
    renderOwnerPanel();
  }

  function renderOwnerPanel() {
    if (!els.ownerSheet || !els.consoleButton) return;
    var visible = isOwner();
    var open = visible && ownerPanelOpen;
    els.consoleButton.classList.toggle("is-hidden", !visible);
    els.logoutButton.classList.toggle("is-hidden", !isRealOwner());
    els.createJoinLinkButton.classList.toggle("is-hidden", !visible);
    els.createGrantLinkButton.classList.toggle("is-hidden", !isRealOwner());
    els.closeRoomButton.classList.toggle("is-hidden", !visible);
    els.ownerSheet.classList.toggle("open", open);
    els.ownerSheet.setAttribute("aria-hidden", open ? "false" : "true");
    els.closeRoomButton.textContent = access.closed ? "重新开局" : "散场";
  }

  function createCell(text, id) {
    var cell = document.createElement("div");
    cell.className = "rank-cell";
    if (id) cell.id = id;
    cell.textContent = text;
    return cell;
  }

  function getExpiryFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var exp = params.get("exp");
    if (!exp) return "";
    var date = new Date(exp);
    if (isNaN(date.getTime())) return "";
    return formatExpiry(exp);
  }

  function renderExpiryBanner() {
    if (!els.expiryBanner) return;
    var expiryFromUrl = getExpiryFromUrl();
    if (expiryFromUrl) {
      els.expiryBanner.textContent = "链接有效至 " + expiryFromUrl;
      var expDate = new Date(new URLSearchParams(window.location.search).get("exp"));
      var diffHours = (expDate.getTime() - Date.now()) / 3600000;
      els.expiryBanner.classList.toggle("is-urgent", diffHours > 0 && diffHours < 1);
    } else {
      els.expiryBanner.textContent = "";
    }
  }

  function createFreshState(redDecks, blueDecks) {
    return normalizeState({
      redDecks: clamp(redDecks || 4, 1, 4),
      blueDecks: clamp(blueDecks || 4, 1, 4),
      currentRank: "Q",
      counts: { red: createCounts(redDecks || 4), blue: createCounts(blueDecks || 4) },
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
    var rank = RANKS.find(function (item) { return item.key === rankKey; });
    var deckCount = color === "red" ? state.redDecks : state.blueDecks;
    return (rank ? rank.perDeck : 4) * deckCount;
  }

  function totalRemaining() {
    return sumCounts(state.counts.red) + sumCounts(state.counts.blue);
  }

  function sumCounts(counts) {
    return RANKS.reduce(function (sum, rank) { return sum + (counts[rank.key] || 0); }, 0);
  }

  function sharedStatePayload() {
    return {
      redDecks: state.redDecks,
      blueDecks: state.blueDecks,
      currentRank: state.currentRank,
      counts: state.counts,
      updatedAt: state.updatedAt
    };
  }

  function authRequest(payload) {
    var config = getConfig();
    var url = getAuthFunctionUrl(config);
    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": config.supabaseAnonKey,
        "Authorization": "Bearer " + config.supabaseAnonKey
      },
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || "请求失败");
        return data;
      });
    });
  }

  function isUnknownActionError(error) {
    return /unknown action|未知操作/i.test(error && error.message ? error.message : "");
  }

  function friendlyAuthError(error) {
    var message = error && error.message ? error.message : "";
    if (isUnknownActionError(error)) return "请重新部署 Supabase 函数后再登录";
    if (/not configured|OWNER_SETUP_PASSWORD/i.test(message)) return "云端登录密码还没配置";
    if (/wrong owner password|wrong password|密码不正确|password/i.test(message)) return "密码错误";
    if (/failed to fetch|network/i.test(message)) return "网络连接失败";
    return message || "登录失败";
  }

  function cloudAuthReady() {
    var config = getConfig();
    return !!(config.supabaseUrl && config.supabaseAnonKey && getAuthFunctionUrl(config));
  }

  function getConfig() {
    return window.POKER_COUNTER_CONFIG || {};
  }

  function getAuthFunctionUrl(config) {
    if (config.roomAuthFunctionUrl) return config.roomAuthFunctionUrl;
    if (!config.supabaseUrl) return "";
    return config.supabaseUrl.replace(/\/$/, "") + "/functions/v1/room-auth";
  }

  function applyAccessResult(result) {
    if (!result) return;
    access.closed = result.closed === true;
    if (result.role && session) session.role = result.role;
    if (result.state) state = normalizeState(result.state);
    saveSession(session);
  }

  function isOwner() {
    return !!(session && session.role === "owner");
  }

  function isRealOwner() {
    return !!(session && session.role === "owner" && session.entry !== "grant" && session.entry !== "join");
  }

  function getOrCreateRoomId() {
    var existing = getRoomIdFromUrl();
    if (existing) return existing;
    var last = loadLastRoomId();
    if (last) {
      replaceUrlWithRoom(last);
      return last;
    }
    var id = createRoomId();
    replaceUrlWithRoom(id);
    return id;
  }

  function loadLastRoomId() {
    try {
      var saved = window.localStorage.getItem(LAST_ROOM_KEY) || "";
      return /^[a-zA-Z0-9_-]{6,48}$/.test(saved) ? saved : "";
    } catch (error) {
      return "";
    }
  }

  function persistLastRoomId() {
    try {
      if (roomId) window.localStorage.setItem(LAST_ROOM_KEY, roomId);
    } catch (error) {
      // Local persistence is best-effort.
    }
  }

  function getRoomIdFromUrl() {
    var existing = new URLSearchParams(window.location.search).get("roomId");
    return existing && /^[a-zA-Z0-9_-]{6,48}$/.test(existing) ? existing : "";
  }

  function createRoomId() {
    var bytes = new Uint8Array(9);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
  }

  function replaceUrlWithRoom(id) {
    var url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("roomId", id);
    window.history.replaceState({}, "", url.toString());
  }

  function removeUrlSecret(name) {
    var url = new URL(window.location.href);
    url.searchParams.delete(name);
    window.history.replaceState({}, "", url.toString());
  }

  function playerVisibleRoomUrl() {
    var url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("roomId", roomId);
    return url.toString();
  }

  function joinUrl(token, expiresAt) {
    var url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("roomId", roomId);
    url.searchParams.set("joinToken", token);
    if (expiresAt) url.searchParams.set("exp", expiresAt);
    return url.toString();
  }

  function grantUrl(token, expiresAt) {
    var url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("grantToken", token);
    if (expiresAt) url.searchParams.set("exp", expiresAt);
    return url.toString();
  }

  function storageKey() {
    return "poker-counter-room-" + roomId;
  }

  function sessionKey() {
    return AUTH_KEY + "-" + roomId;
  }

  function activeColorKey(id) {
    return "poker-counter-active-color-" + id;
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
    if (!state) return;
    try {
      window.localStorage.setItem(storageKey(), JSON.stringify(state));
    } catch (error) {
      // Local persistence is best-effort.
    }
  }

  function saveSession(value) {
    try {
      if (value) {
        window.localStorage.setItem(sessionKey(), JSON.stringify(value));
        persistLastRoomId();
      }
    } catch (error) {
      // Local persistence is best-effort.
    }
  }

  function loadSession() {
    try {
      var saved = window.localStorage.getItem(sessionKey());
      return saved ? JSON.parse(saved) : null;
    } catch (error) {
      return null;
    }
  }

  function clearSession() {
    try {
      window.localStorage.removeItem(sessionKey());
    } catch (error) {
      // Local persistence is best-effort.
    }
    session = null;
  }

  function loadLocalActiveColor(id) {
    try {
      return window.localStorage.getItem(activeColorKey(id)) || "red";
    } catch (error) {
      return "red";
    }
  }

  function persistLocalActiveColor() {
    try {
      window.localStorage.setItem(activeColorKey(roomId), activeColor);
    } catch (error) {
      // Local persistence is best-effort.
    }
  }

  function copyText(text, successMessage) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast(successMessage);
      }).catch(function () {
        fallbackCopyText(text, successMessage);
      });
      return;
    }
    fallbackCopyText(text, successMessage);
  }

  function fallbackCopyText(text, successMessage) {
    try {
      var textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-1000px";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      var ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (ok) {
        showToast(successMessage);
        return;
      }
    } catch (error) {
      // Last resort below.
    }
    window.prompt("复制这个链接", text);
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add("show");
    toastTimer = setTimeout(function () { els.toast.classList.remove("show"); }, 1600);
  }

  function rankLabel(rankKey) {
    var rank = RANKS.find(function (item) { return item.key === rankKey; });
    if (!rank) return rankKey;
    if (rank.key === "big") return "大王";
    if (rank.key === "small") return "小王";
    return rank.label;
  }

  function colorLabel(color) {
    return color === "blue" ? "蓝牌" : "红牌";
  }

  function normalizeColor(color) {
    return color === "blue" ? "blue" : "red";
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
