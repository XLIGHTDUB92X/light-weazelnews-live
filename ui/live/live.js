/* ============================================================
   light-weazelnews-live - live.js
   ============================================================
   The "Go Live" add-on's entire UI half. Loaded by index.html right after
   app.js (`<script src="live/live.js"></script>`, after
   `<script src="app.js"></script>`) - 404s harmlessly if this file isn't
   present, which is how the base resource works identically whether or not
   this add-on is installed.

   Because both files load as plain, non-deferred, non-async <script> tags in
   document order, by the time this file's own top-level code runs:
     - app.js's top-level code has already finished running (it defines
       window.registerWeazelNewsLiveAddon and window.__weazelNewsInternals
       before anything else), but
     - DOMContentLoaded (which fires app.js's own init()) has NOT fired yet.
   That's the window this file uses to inject its own DOM fragments (nav
   button, #liveView, #liveViewerModal, #liveCommentOverlay,
   #liveBannerList) into the page BEFORE app.js's init() runs and goes
   looking for elements like #liveTabBtn / #liveCard / #liveView.

   This file is its own separate top-level scope from app.js's IIFE, so it
   can't reach app.js's internals directly - it reads them from
   window.__weazelNewsInternals (same `el`/`state`/`callNui`/etc. app.js uses
   internally - `state` in particular is the SAME object reference, so
   writes here are visible there and vice versa), and registers its own
   closeOverlay/init/handleMessage via window.registerWeazelNewsLiveAddon so
   app.js's few remaining Go-Live-aware call sites (stopWatchingLive callers,
   the message dispatcher's fallback branch, init()'s own liveAddon.init()
   call) reach this file's real implementations instead of silently no-oping.
   ============================================================ */
(function () {
  'use strict';

  const internals = window.__weazelNewsInternals;
  if (!internals) {
    // app.js isn't loaded, or loaded after this file by mistake - there's
    // nothing to hook into. Fail quietly rather than throwing on every page
    // load; the base resource still works fine, just without Go Live.
    console.warn('[light-weazelnews-live] window.__weazelNewsInternals not found - make sure live.js loads AFTER app.js in index.html.');
    return;
  }

  const {
    el, state, callNui: sharedCallNui, showToast, escapeHtml, fmtMoney,
    closeModal, closeProfileModal, closeAdSubmitModal, closeTipSubmitModal,
  } = internals;

  const IS_BROWSER = !window.invokeNative && !navigator.userAgent.includes('CitizenFX');

  // ---------------------------------------------------------
  // DOM injection - runs immediately, synchronously, before app.js's
  // DOMContentLoaded-triggered init() fires. Every anchor lookup is
  // null-guarded so a mismatched/older base index.html just skips that
  // piece instead of throwing.
  // ---------------------------------------------------------
  (function injectDom() {
    // Nav button - after Editor Queue, before Tips (matches the comment
    // left in index.html marking this spot).
    const tipsTabBtn = document.getElementById('tipsTabBtn');
    if (tipsTabBtn) {
      tipsTabBtn.insertAdjacentHTML('beforebegin',
        '<button class="nav-btn" data-tab="live" id="liveTabBtn" style="display:none;"><i class="fa-solid fa-tower-broadcast"></i><span>Go Live</span></button>'
      );
    }

    // Live banner list - right before the feed list, inside #feedView.
    const feedList = document.getElementById('feedList');
    if (feedList) {
      feedList.insertAdjacentHTML('beforebegin',
        '<div id="liveBannerList" class="live-banner-list"></div>'
      );
    }

    // #liveView main - right before #publishView (matches where it sat in
    // the original, single-package index.html).
    const publishView = document.getElementById('publishView');
    if (publishView) {
      publishView.insertAdjacentHTML('beforebegin', `
  <main id="liveView" class="view">
    <div class="live-card" id="liveCard">
      <div class="live-card-header"><i class="fa-solid fa-tower-broadcast"></i> Go Live</div>
      <p class="live-card-sub">Already streaming on Twitch, Kick, or YouTube? Paste the link below and it shows up in-game for anyone with the app open, with a "Watch" button right on the Feed.</p>

      <label class="field-label" for="liveUrlInput">Stream link</label>
      <input id="liveUrlInput" class="field-input" type="text" placeholder="https://twitch.tv/yourchannel" autocomplete="off" />

      <label class="field-label" for="liveTitleInput">What's happening (optional)</label>
      <input id="liveTitleInput" class="field-input" type="text" maxlength="100" placeholder="Live from the field..." autocomplete="off" />

      <div class="form-error" id="liveFormError"></div>

      <button type="button" class="go-live-btn" id="goLiveBtn"><i class="fa-solid fa-circle"></i> Go Live</button>
    </div>

    <div class="live-active-bar" id="liveActiveBar" style="display:none;">
      <div class="live-active-info">
        <div class="live-active-title"><span class="live-dot"></span> You're live on <span id="liveActivePlatform"></span></div>
        <div class="live-active-sub" id="liveActiveTitle"></div>
        <div class="live-active-viewers"><i class="fa-solid fa-eye"></i> <span id="liveViewerCount">0</span> watching <i class="fa-solid fa-heart live-active-like-icon"></i> <span id="liveActiveLikeCount">0</span></div>
      </div>
      <button type="button" class="end-live-btn" id="endLiveBtn">End</button>
    </div>

    <!-- The reporter's own stream, embedded right back at them, just so
         they can see for themselves that it's actually showing up and
         looking right - not required for anything to function. -->
    <div class="live-self-preview-wrap" id="liveSelfPreviewWrap" style="display:none;">
      <iframe id="liveSelfPreviewFrame" class="live-self-preview-frame" allowfullscreen></iframe>
      <!-- TikTok has no real embeddable live player, so there's nothing to
           preview here - shown in place of the iframe for that platform
           only, so it's clear you're still live for viewers rather than
           looking like the app silently failed. -->
      <div class="live-self-preview-unavailable" id="liveSelfPreviewUnavailable" style="display:none;">
        <i class="fa-solid fa-tower-broadcast"></i>
        <span>TikTok LIVE can't be previewed here, but you're live for viewers</span>
      </div>
    </div>

    <!-- Reporter-only poll controls, shown only while live. -->
    <div class="live-poll-host" id="livePollHost" style="display:none;">
      <div class="live-poll-host-header"><i class="fa-solid fa-square-poll-vertical"></i> Live Poll</div>
      <div id="livePollStartForm">
        <input type="text" id="pollQuestionInput" class="field-input" maxlength="120" placeholder="Ask viewers a question..." />
        <input type="text" class="field-input poll-option-input" maxlength="40" placeholder="Option 1" />
        <input type="text" class="field-input poll-option-input" maxlength="40" placeholder="Option 2" />
        <input type="text" class="field-input poll-option-input" maxlength="40" placeholder="Option 3 (optional)" />
        <input type="text" class="field-input poll-option-input" maxlength="40" placeholder="Option 4 (optional)" />
        <button type="button" class="go-live-btn" id="startPollBtn">Start Poll</button>
      </div>
      <div id="livePollHostResults" style="display:none;">
        <div class="live-poll-question" id="livePollHostQuestion"></div>
        <div id="livePollHostBars" class="live-poll-bars"></div>
        <button type="button" class="end-live-btn" id="endPollBtn">End Poll</button>
      </div>
    </div>
  </main>
      `);
    }

    // Live comment overlay - floats over whichever tab is open while live;
    // top-level, right after #toast.
    const toast = document.getElementById('toast');
    if (toast) {
      toast.insertAdjacentHTML('afterend',
        '<div id="liveCommentOverlay" class="live-comment-overlay"></div>'
      );
    }

    // #liveViewerModal - right before #postModal (matches where it sat in
    // the original, single-package index.html).
    const postModal = document.getElementById('postModal');
    if (postModal) {
      postModal.insertAdjacentHTML('beforebegin', `
  <div id="liveViewerModal" class="modal">
    <div class="modal-backdrop"></div>
    <div class="modal-card live-viewer-card">
      <button class="modal-close" id="liveViewerCloseBtn"><i class="fa-solid fa-xmark"></i></button>
      <div class="live-viewer-video-wrap">
        <iframe id="liveViewerFrame" class="live-viewer-video" allow="autoplay; fullscreen" style="display:none;"></iframe>
        <div class="live-viewer-status" id="liveViewerStatus">Connecting...</div>
      </div>

      <!-- TikTok has no real embeddable live player - see the "Go Live"
           section of the README. This is the fallback shown only for a
           TikTok link, in place of the iframe above. -->
      <a class="live-viewer-open-external" id="liveViewerOpenExternal" target="_blank" rel="noopener noreferrer" style="display:none;">
        <i class="fa-solid fa-arrow-up-right-from-square"></i>
        <span>TikTok LIVE can't be embedded - tap to open it in your browser</span>
      </a>

      <div class="live-viewer-info">
        <span class="live-dot"></span>
        <div>
          <div class="live-viewer-title" id="liveViewerTitle"></div>
          <div class="live-viewer-sub" id="liveViewerSub"></div>
        </div>
        <button type="button" class="live-like-btn" id="liveLikeBtn" title="Like this stream">
          <i class="fa-solid fa-heart"></i> <span id="liveLikeCount">0</span>
        </button>
      </div>

      <!-- A live poll the reporter started, if one is running right now. -->
      <div id="liveViewerPoll" class="live-poll-viewer" style="display:none;">
        <div class="live-poll-question" id="liveViewerPollQuestion"></div>
        <div id="liveViewerPollOptions" class="live-poll-options"></div>
      </div>

      <!-- Sent straight to the reporter, privately - never shown to other
           viewers. See the "Go Live" section of the README. -->
      <form class="live-comment-form" id="liveCommentForm">
        <input class="live-comment-input" id="liveCommentInput" type="text" maxlength="150" placeholder="Say something to the reporter..." autocomplete="off" />
        <button type="submit" class="live-comment-send" id="liveCommentSendBtn"><i class="fa-solid fa-paper-plane"></i></button>
      </form>
    </div>
  </div>
      `);
    }
  })();

  // ---------------------------------------------------------
  // Browser-preview mock - only ever used outside the actual game
  // (IS_BROWSER), so designers can still preview ui/index.html with this
  // add-on dropped in without needing a live FiveM server. Mirrors the
  // Go-Live-specific mock handlers that used to live in app.js's own
  // mockNui before this feature was extracted.
  // ---------------------------------------------------------
  const MOCK_MY_CITIZENID = 'ABC12345';
  const mockLiveBroadcasts = {}; // citizenId -> { authorName, title, platform, streamUrl }
  const mockPoll = { question: null, options: [], counts: [], votedBy: {} };

  async function callNui(name, data) {
    if (!IS_BROWSER) return sharedCallNui(name, data);

    if (name === 'getLiveConfig') {
      return {
        liveEnabled: true,
        livePlatforms: { twitch: true, kick: true, youtube: true, tiktok: false },
        livePollsEnabled: true,
      };
    }
    if (name === 'getLiveBroadcasts') {
      return {
        success: true,
        broadcasts: Object.keys(mockLiveBroadcasts).map((id) => ({
          citizenId: id, authorName: mockLiveBroadcasts[id].authorName, title: mockLiveBroadcasts[id].title,
        })),
      };
    }
    if (name === 'goLive') {
      const platform = detectStreamPlatform(data && data.streamUrl);
      if (!platform) return { success: false, error: 'Paste a valid Twitch, Kick, or YouTube link.' };
      mockLiveBroadcasts[MOCK_MY_CITIZENID] = {
        authorName: (data.authorName || 'Weazel News'), title: (data.title || 'Live from the field'),
        platform, streamUrl: data.streamUrl,
      };
      return { success: true, citizenId: MOCK_MY_CITIZENID, platform, streamUrl: data.streamUrl, twitchEmbedParents: [] };
    }
    if (name === 'joinLive') {
      const b = mockLiveBroadcasts[data && data.citizenId];
      if (!b) return { success: false, error: 'This broadcast has ended.' };
      return {
        success: true, title: b.title, authorName: b.authorName, platform: b.platform, streamUrl: b.streamUrl,
        twitchEmbedParents: [], likeCount: 0, liked: false,
        poll: mockPoll.question ? { question: mockPoll.question, options: mockPoll.options, counts: mockPoll.counts, voted: mockPoll.votedBy[MOCK_MY_CITIZENID] } : null,
      };
    }
    if (name === 'endLive') { delete mockLiveBroadcasts[MOCK_MY_CITIZENID]; return { success: true }; }
    if (name === 'leaveLive') return { success: true };
    if (name === 'sendLiveComment') return { success: false, error: 'Live comments need a real server to relay them.' };
    if (name === 'likeLive') return { success: true, likeCount: 1 };
    if (name === 'startLivePoll') {
      mockPoll.question = data.question;
      mockPoll.options = data.options;
      mockPoll.counts = data.options.map(() => 0);
      mockPoll.votedBy = {};
      return { success: true };
    }
    if (name === 'voteLivePoll') {
      if (!mockPoll.question) return { success: false, error: 'No poll running.' };
      if (mockPoll.votedBy[MOCK_MY_CITIZENID]) return { success: false, error: 'Already voted.' };
      mockPoll.votedBy[MOCK_MY_CITIZENID] = data.optionIndex;
      mockPoll.counts[data.optionIndex - 1] += 1;
      return { success: true, voted: data.optionIndex };
    }
    if (name === 'endLivePoll') {
      mockPoll.question = null;
      return { success: true };
    }
    return sharedCallNui(name, data);
  }

  // ---------------------------------------------------------
  // Live broadcasts ("Go Live") - a reporter pastes a link to a stream
  // they're already broadcasting on Twitch, Kick, YouTube, or TikTok (via
  // OBS, Streamlabs, the platform's own app, whatever they're already
  // using), and this app just embeds THAT platform's own player - both for
  // the reporter's own "yep, that's live" self-preview and for anyone who
  // taps "Watch". No camera/mic/WebRTC involved anywhere in this app at
  // all. See README.md -> "Go Live" for the per-platform notes (Twitch's
  // "parent" param, TikTok's lack of a real embeddable live player).
  // ---------------------------------------------------------
  const PLATFORM_LABEL = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', tiktok: 'TikTok' };

  const liveBroadcasts = {}; // citizenId -> { authorName, title } - everyone currently live

  // Client-side mirror of server_live.lua's DetectStreamPlatform - used only
  // to give an instant "that doesn't look right" check and to pick the right
  // embed builder; the server independently re-validates the link itself,
  // so nothing security-relevant depends on this copy being perfect. Gated
  // by state.livePlatforms (set from Config.LivePlatforms in init(), below)
  // so a platform turned off there - TikTok, by default: it has no real
  // embeddable LIVE player at all - gets rejected right here with a clear
  // message instead of round-tripping to the server first.
  function detectStreamPlatform(url) {
    if (!url) return null;
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (e) {
      return null;
    }
    const platforms = state.livePlatforms || {};
    const hostIs = (domain) => host === domain || host.endsWith('.' + domain);
    if (platforms.twitch && hostIs('twitch.tv')) return 'twitch';
    if (platforms.kick && hostIs('kick.com')) return 'kick';
    if (platforms.youtube && (hostIs('youtube.com') || hostIs('youtu.be'))) return 'youtube';
    if (platforms.tiktok && hostIs('tiktok.com')) return 'tiktok';
    return null;
  }

  // Builds what to actually put on screen for a given stream link:
  // { type: 'iframe', src } for a platform with a real embeddable player,
  // or { type: 'external', src } for one that doesn't (TikTok has no real
  // embeddable LIVE player - its oEmbed API only covers regular posted
  // videos - so that case is a plain "open it yourself" link instead).
  // Twitch's "parent" hostname check is picky about exactly which frame's
  // hostname it ends up comparing against, and this app runs nested two
  // iframes deep (LB Phone's own top-level NUI page, normally
  // "cfx-nui-lb-phone", contains an iframe for this app, normally
  // "cfx-nui-light-weazelnews", which is what actually embeds the Twitch
  // player) - so rather than guess exactly one hostname, every one this
  // page can actually read gets sent as a candidate, alongside whatever's
  // configured server-side. window.top.location and ancestorOrigins reads
  // are wrapped in try/catch since a cross-origin ancestor can throw or
  // simply not expose them, which is fine - those are just extra
  // candidates, never load-bearing on their own.
  function collectAncestorHostnames() {
    const hosts = [];
    try { hosts.push(window.location.hostname); } catch (e) { /* ignore */ }
    try { hosts.push(window.top.location.hostname); } catch (e) { /* cross-origin - expected */ }
    try {
      (window.location.ancestorOrigins || []).forEach((origin) => {
        try { hosts.push(new URL(origin).hostname); } catch (e2) { /* ignore */ }
      });
    } catch (e) { /* ancestorOrigins not supported in this browser */ }
    return hosts;
  }

  function buildStreamEmbed(url, platform, twitchEmbedParents) {
    platform = platform || detectStreamPlatform(url);
    if (platform === 'twitch') {
      const m = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i);
      if (!m) return null;
      const parents = ['cfx-nui-light-weazelnews', 'cfx-nui-lb-phone', 'localhost']
        .concat(collectAncestorHostnames())
        .concat(twitchEmbedParents || [])
        .filter(Boolean);
      const params = new URLSearchParams();
      params.set('channel', m[1]);
      params.set('muted', 'true');
      // URLSearchParams collapses repeats of the same key added via set(),
      // so the repeated "parent" params Twitch wants are appended by hand.
      let qs = params.toString();
      const seen = new Set();
      parents.forEach((p) => {
        if (seen.has(p)) return;
        seen.add(p);
        qs += `&parent=${encodeURIComponent(p)}`;
      });
      return { type: 'iframe', src: `https://player.twitch.tv/?${qs}` };
    }
    if (platform === 'kick') {
      const m = url.match(/kick\.com\/([a-zA-Z0-9_-]+)/i);
      if (!m) return null;
      return { type: 'iframe', src: `https://player.kick.com/${m[1]}` };
    }
    if (platform === 'youtube') {
      const m = url.match(/(?:v=|youtu\.be\/)([\w-]+)/);
      if (!m) return null;
      return { type: 'iframe', src: `https://www.youtube.com/embed/${m[1]}?autoplay=1` };
    }
    if (platform === 'tiktok') {
      return { type: 'external', src: url };
    }
    return null;
  }

  function renderLiveBanners() {
    const list = el('liveBannerList');
    if (!list) return;
    list.innerHTML = '';
    Object.keys(liveBroadcasts).forEach((citizenId) => {
      if (citizenId === state.myLiveCitizenId) return; // don't show your own broadcast as something to go "watch"
      const b = liveBroadcasts[citizenId];
      const row = document.createElement('div');
      row.className = 'live-banner';
      row.innerHTML = `
        <div class="live-banner-info">
          <span class="live-dot"></span>
          <div>
            <div class="live-banner-title">${escapeHtml(b.authorName)}</div>
            <div class="live-banner-sub">${escapeHtml(b.title)}</div>
          </div>
        </div>
        <button type="button" class="watch-live-btn">Watch</button>
      `;
      row.querySelector('.watch-live-btn').addEventListener('click', () => watchLive(citizenId));
      list.appendChild(row);
    });
  }

  async function loadLiveBroadcasts() {
    const res = await callNui('getLiveBroadcasts');
    if (res && res.success) {
      Object.keys(liveBroadcasts).forEach((k) => delete liveBroadcasts[k]);
      (res.broadcasts || []).forEach((b) => {
        liveBroadcasts[b.citizenId] = { authorName: b.authorName, title: b.title };
      });
      renderLiveBanners();
    }
  }

  // ---- Broadcaster side ----

  async function startGoLive() {
    if (state.isLive) return;

    const urlInput = el('liveUrlInput');
    const titleInput = el('liveTitleInput');
    const errEl = el('liveFormError');
    if (errEl) errEl.textContent = '';

    const streamUrl = (urlInput.value || '').trim();
    const platform = detectStreamPlatform(streamUrl);
    if (!platform) {
      if (errEl) errEl.textContent = 'Paste a valid Twitch, Kick, or YouTube link.';
      return;
    }

    const title = (titleInput.value || '').trim();
    const authorName = el('authorInput') ? el('authorInput').value.trim() : '';

    const res = await callNui('goLive', { streamUrl, title, authorName });
    if (!res.success) {
      if (errEl) errEl.textContent = res.error || 'Could not go live.';
      return;
    }

    state.isLive = true;
    state.myLiveCitizenId = res.citizenId || null;

    el('liveCard').style.display = 'none';
    el('liveActiveBar').style.display = 'flex';
    el('liveActivePlatform').textContent = PLATFORM_LABEL[res.platform] || res.platform;
    el('liveActiveTitle').textContent = title || 'Live from the field';
    el('liveViewerCount').textContent = '0';
    el('liveActiveLikeCount').textContent = '0';

    if (state.livePollsEnabled) {
      el('livePollHost').style.display = 'block';
      renderHostPoll(null);
    }

    showSelfPreview(res.platform, res.streamUrl, res.twitchEmbedParents);

    urlInput.value = '';
    titleInput.value = '';

    renderLiveBanners();
  }

  // Embeds the reporter's own stream right back at them (muted), just so
  // they can see for themselves it's actually showing up and looking
  // right - purely cosmetic, nothing else depends on this working. For a
  // platform with no real embeddable player (TikTok), this used to just
  // hide the whole preview area with nothing in its place, which looked
  // exactly like the app had silently failed - it shows an explanatory
  // message instead now, same idea as the viewer-side fallback link.
  function showSelfPreview(platform, streamUrl, twitchEmbedParents) {
    const wrap = el('liveSelfPreviewWrap');
    const frame = el('liveSelfPreviewFrame');
    const unavailable = el('liveSelfPreviewUnavailable');
    if (!wrap || !frame) return;
    const embed = buildStreamEmbed(streamUrl, platform, twitchEmbedParents);
    wrap.style.display = 'block';
    if (embed && embed.type === 'iframe') {
      if (unavailable) unavailable.style.display = 'none';
      frame.style.display = 'block';
      frame.src = embed.src;
    } else {
      frame.style.display = 'none';
      frame.src = 'about:blank';
      if (unavailable) unavailable.style.display = 'flex';
    }
  }

  async function endGoLive() {
    if (!state.isLive) return;
    await callNui('endLive');
    stopBroadcasting();
  }

  function stopBroadcasting() {
    state.isLive = false;
    state.myLiveCitizenId = null;

    if (el('liveCard')) el('liveCard').style.display = 'block';
    if (el('liveActiveBar')) el('liveActiveBar').style.display = 'none';
    const previewWrap = el('liveSelfPreviewWrap');
    const previewFrame = el('liveSelfPreviewFrame');
    const previewUnavailable = el('liveSelfPreviewUnavailable');
    if (previewWrap) previewWrap.style.display = 'none';
    if (previewFrame) previewFrame.src = 'about:blank';
    if (previewUnavailable) previewUnavailable.style.display = 'none';
    const overlay = el('liveCommentOverlay');
    if (overlay) overlay.innerHTML = '';

    const pollHost = el('livePollHost');
    if (pollHost) pollHost.style.display = 'none';

    renderLiveBanners();
  }

  // ---- Viewer side ----

  async function watchLive(citizenId) {
    const known = liveBroadcasts[citizenId];
    const res = await callNui('joinLive', { citizenId });
    if (!res.success) {
      showToast(res.error || 'Could not join this broadcast.');
      return;
    }

    closeModal();
    closeProfileModal();
    closeAdSubmitModal();
    closeTipSubmitModal();

    state.liveViewingCitizenId = citizenId;
    state.liveLiked = !!res.liked;

    el('liveViewerTitle').textContent = res.authorName || (known && known.authorName) || 'Weazel News';
    el('liveViewerSub').textContent = res.title || (known && known.title) || '';
    const likeBtn = el('liveLikeBtn');
    el('liveLikeCount').textContent = res.likeCount || 0;
    likeBtn.classList.toggle('liked', state.liveLiked);
    likeBtn.disabled = state.liveLiked;
    el('liveViewerModal').classList.add('open');

    state.viewerPoll = res.poll || null;
    renderViewerPoll();

    showViewerEmbed(res.platform, res.streamUrl, res.twitchEmbedParents);
  }

  function showViewerEmbed(platform, streamUrl, twitchEmbedParents) {
    const frame = el('liveViewerFrame');
    const statusEl = el('liveViewerStatus');
    const externalLink = el('liveViewerOpenExternal');

    const embed = buildStreamEmbed(streamUrl, platform, twitchEmbedParents);

    if (embed && embed.type === 'iframe') {
      if (externalLink) externalLink.style.display = 'none';
      statusEl.textContent = 'Loading stream...';
      statusEl.classList.remove('hidden');
      frame.style.display = 'block';
      frame.onload = () => statusEl.classList.add('hidden');
      frame.src = embed.src;
    } else {
      // No real embeddable player for this one (TikTok) - or the link
      // didn't parse cleanly - so hand them a plain "go watch it there"
      // link instead of a broken/blank video area.
      frame.style.display = 'none';
      frame.src = 'about:blank';
      statusEl.classList.add('hidden');
      if (externalLink) {
        externalLink.href = (embed && embed.src) || streamUrl || '#';
        externalLink.style.display = 'flex';
      }
    }
  }

  function stopWatchingLive() {
    if (state.liveViewingCitizenId) {
      callNui('leaveLive', { citizenId: state.liveViewingCitizenId });
    }
    state.liveViewingCitizenId = null;
    state.liveLiked = false;
    state.viewerPoll = null;
    const modal = el('liveViewerModal');
    if (modal) modal.classList.remove('open');
    const frame = el('liveViewerFrame');
    if (frame) {
      frame.src = 'about:blank';
      frame.style.display = 'none';
    }
    const externalLink = el('liveViewerOpenExternal');
    if (externalLink) externalLink.style.display = 'none';
    const likeBtn = el('liveLikeBtn');
    if (likeBtn) {
      likeBtn.classList.remove('liked');
      likeBtn.disabled = false;
    }
  }

  // Sends a comment to whoever's broadcast is currently open in the live
  // viewer. Goes ONLY to that reporter's own screen (server_live.lua
  // enforces this) - it is never shown to any other viewer, so there's
  // nothing to render back here beyond clearing the input.
  async function sendLiveComment(text) {
    if (!state.liveViewingCitizenId) return;
    const btn = el('liveCommentSendBtn');
    btn.disabled = true;
    const res = await callNui('sendLiveComment', { citizenId: state.liveViewingCitizenId, body: text });
    btn.disabled = false;
    if (!res.success) {
      showToast(res.error || 'Could not send that.');
    }
  }

  // Likes whichever broadcast is currently open in the live viewer. One
  // like per viewer per broadcast (server-enforced) - the button is
  // disabled immediately so a double-click can't fire this twice, and the
  // actual displayed count is driven by the liveLikeUpdate broadcast below
  // (which reaches us too, since we're one of the broadcast's viewers),
  // not by this call's own response.
  async function likeLiveStream() {
    if (!state.liveViewingCitizenId || state.liveLiked) return;
    const btn = el('liveLikeBtn');
    btn.disabled = true;
    const res = await callNui('likeLive', { citizenId: state.liveViewingCitizenId });
    if (!res.success) {
      btn.disabled = false;
      showToast(res.error || 'Could not like this right now.');
      return;
    }
    state.liveLiked = true;
    btn.classList.add('liked');
  }

  // Updates whichever like-count readout is currently on screen - the
  // reporter's own "you're live" bar if we're broadcasting, and/or the live
  // viewer's like button if we're watching (both can receive this, since
  // the server pushes it to the broadcaster AND every current viewer).
  function updateLiveLikeDisplay(likeCount) {
    if (state.isLive) {
      const activeEl = el('liveActiveLikeCount');
      if (activeEl) activeEl.textContent = likeCount;
    }
    if (state.liveViewingCitizenId) {
      const countEl = el('liveLikeCount');
      if (countEl) countEl.textContent = likeCount;
    }
  }

  // Reporter-only: renders one incoming live comment as a floating,
  // auto-fading overlay item. Only ever called from handleMessage below,
  // which only ever fires on the broadcaster's own client (see the comment
  // on #liveCommentOverlay's injection, above).
  function addLiveCommentOverlay(authorName, body) {
    const overlay = el('liveCommentOverlay');
    if (!overlay || !state.isLive) return;

    const item = document.createElement('div');
    item.className = 'live-comment-item';
    item.innerHTML = `<span class="live-comment-author">${escapeHtml(authorName)}</span>${escapeHtml(body)}`;
    overlay.appendChild(item);

    while (overlay.children.length > 5) {
      overlay.removeChild(overlay.firstChild);
    }

    setTimeout(() => {
      item.classList.add('fade-out');
      setTimeout(() => item.remove(), 400);
    }, 6000);
  }

  // ---- Live polls ----
  // server_live.lua pushes livePollUpdate to the broadcaster AND every
  // current viewer whenever a poll starts, gets a new vote, or ends (payload
  // null means ended/cleared) - routed here via handleMessage, below. Both
  // renderers below are driven purely by that push, same as the like-count
  // display above.

  // Reporter-side: toggles between the "start a poll" form and a live
  // results view with a bar per option.
  function renderHostPoll(poll) {
    const startForm = el('livePollStartForm');
    const results = el('livePollHostResults');
    if (!startForm || !results) return;

    if (!poll) {
      startForm.style.display = 'block';
      results.style.display = 'none';
      return;
    }

    startForm.style.display = 'none';
    results.style.display = 'block';
    el('livePollHostQuestion').textContent = poll.question;

    const counts = poll.counts || [];
    const total = counts.reduce((a, b) => a + b, 0);
    el('livePollHostBars').innerHTML = poll.options.map((opt, i) => {
      const count = counts[i] || 0;
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      return `
        <div class="live-poll-bar-row">
          <div class="live-poll-bar-label"><span>${escapeHtml(opt)}</span><span>${count} (${pct}%)</span></div>
          <div class="live-poll-bar-track"><div class="live-poll-bar-fill" style="width:${pct}%"></div></div>
        </div>
      `;
    }).join('');
  }

  // Reads the poll form and starts it on the reporter's own current
  // broadcast. The form itself only flips over to the results view once
  // the livePollUpdate push confirms it (see renderHostPoll above).
  async function startLivePoll() {
    const question = el('pollQuestionInput').value.trim();
    const options = Array.from(document.querySelectorAll('.poll-option-input'))
      .map((inp) => inp.value.trim())
      .filter(Boolean);

    if (!question) { showToast('Give the poll a question first.'); return; }
    if (options.length < 2) { showToast('A poll needs at least 2 options.'); return; }

    const btn = el('startPollBtn');
    btn.disabled = true;
    const res = await callNui('startLivePoll', { question, options });
    btn.disabled = false;

    if (!res.success) {
      showToast(res.error || 'Could not start that poll.');
      return;
    }

    el('pollQuestionInput').value = '';
    document.querySelectorAll('.poll-option-input').forEach((inp) => { inp.value = ''; });

    // Flip straight to the results view now rather than waiting on the
    // livePollUpdate push - the push still arrives right behind this and
    // re-renders with the same (still-zero) counts, harmlessly.
    renderHostPoll({ question, options, counts: options.map(() => 0) });
  }

  async function endLivePoll() {
    const btn = el('endPollBtn');
    btn.disabled = true;
    const res = await callNui('endLivePoll');
    btn.disabled = false;
    if (!res.success) {
      showToast(res.error || 'Could not end the poll.');
      return;
    }
    renderHostPoll(null);
  }

  // Viewer-side: a clickable list of options before voting, which turns
  // into a read-only result bar per option (with our own pick highlighted)
  // the moment we've voted - either just now, or already on join.
  function renderViewerPoll() {
    const wrap = el('liveViewerPoll');
    const poll = state.viewerPoll;
    if (!wrap) return;

    if (!poll) {
      wrap.style.display = 'none';
      el('liveViewerPollOptions').innerHTML = '';
      return;
    }

    wrap.style.display = 'block';
    el('liveViewerPollQuestion').textContent = poll.question;

    const counts = poll.counts || [];
    const total = counts.reduce((a, b) => a + b, 0);
    const votedIdx = poll.voted || null;
    const showResults = votedIdx != null;

    el('liveViewerPollOptions').innerHTML = poll.options.map((opt, i) => {
      const idx = i + 1;
      const count = counts[i] || 0;
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      const isVoted = votedIdx === idx;
      return `
        <button type="button" class="live-poll-option-btn ${isVoted ? 'voted' : ''}" data-index="${idx}" ${showResults ? 'disabled' : ''}>
          ${showResults ? `<div class="live-poll-option-fill" style="width:${pct}%"></div>` : ''}
          <div class="live-poll-option-label">
            <span>${escapeHtml(opt)}</span>
            ${showResults ? `<span class="live-poll-option-pct">${pct}%</span>` : ''}
          </div>
        </button>
      `;
    }).join('');

    if (!showResults) {
      el('liveViewerPollOptions').querySelectorAll('.live-poll-option-btn').forEach((btn) => {
        btn.addEventListener('click', () => voteLivePoll(Number(btn.dataset.index)));
      });
    }
  }

  async function voteLivePoll(optionIndex) {
    if (!state.liveViewingCitizenId || !state.viewerPoll || state.viewerPoll.voted) return;

    const res = await callNui('voteLivePoll', { citizenId: state.liveViewingCitizenId, optionIndex });
    if (!res.success) {
      showToast(res.error || 'Could not vote.');
      return;
    }

    // Reflect our own vote immediately rather than waiting on the
    // livePollUpdate push (which still arrives right behind this and
    // re-renders with the server's authoritative counts).
    state.viewerPoll.voted = optionIndex;
    const counts = state.viewerPoll.counts || (state.viewerPoll.counts = state.viewerPoll.options.map(() => 0));
    counts[optionIndex - 1] = (counts[optionIndex - 1] || 0) + 1;
    renderViewerPoll();
  }

  // Called from handleMessage, below, whenever the server pushes a poll
  // change - to the broadcaster, to every current viewer, or both.
  function handleLivePollUpdate(poll) {
    if (state.isLive) {
      renderHostPoll(poll);
    }
    if (state.liveViewingCitizenId) {
      if (!poll) {
        state.viewerPoll = null;
      } else {
        // A brand new poll (different question) always starts un-voted;
        // the same poll getting a new vote keeps whatever we already knew
        // about our own vote, since this push never carries that back.
        const keepVoted = state.viewerPoll && state.viewerPoll.question === poll.question
          ? state.viewerPoll.voted
          : null;
        state.viewerPoll = { ...poll, voted: keepVoted };
      }
      renderViewerPoll();
    }
  }

  function wireButtons() {
    const goLiveBtn = el('goLiveBtn');
    const endLiveBtn = el('endLiveBtn');
    const viewerCloseBtn = el('liveViewerCloseBtn');
    const viewerBackdrop = document.querySelector('#liveViewerModal .modal-backdrop');
    const startPollBtn = el('startPollBtn');
    const endPollBtn = el('endPollBtn');
    const commentForm = el('liveCommentForm');
    const likeBtn = el('liveLikeBtn');

    if (goLiveBtn) goLiveBtn.addEventListener('click', startGoLive);
    if (endLiveBtn) endLiveBtn.addEventListener('click', endGoLive);
    if (viewerCloseBtn) viewerCloseBtn.addEventListener('click', stopWatchingLive);
    if (viewerBackdrop) viewerBackdrop.addEventListener('click', stopWatchingLive);
    if (startPollBtn) startPollBtn.addEventListener('click', startLivePoll);
    if (endPollBtn) endPollBtn.addEventListener('click', endLivePoll);

    if (commentForm) {
      commentForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = el('liveCommentInput');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        sendLiveComment(text);
      });
    }

    if (likeBtn) likeBtn.addEventListener('click', likeLiveStream);
  }

  // Button/form listeners can be wired as soon as the DOM injection above
  // has run - no need to wait for liveAddon.init() (which runs later, after
  // the server round-trip in app.js's own init()).
  wireButtons();

  // ---------------------------------------------------------
  // Registration with app.js
  // ---------------------------------------------------------
  async function init() {
    const perm = await callNui('getLiveConfig');

    state.liveEnabled = !!(perm && perm.liveEnabled);
    // Falls back to the same twitch/kick/youtube-on, tiktok-off defaults as
    // config.lua if the server ever omits this (older mock data, etc.) so
    // the "Go Live" form doesn't silently accept everything.
    state.livePlatforms = (perm && perm.livePlatforms) || { twitch: true, kick: true, youtube: true, tiktok: false };
    state.livePollsEnabled = !!(perm && perm.livePollsEnabled);
    state.isLive = false;
    state.myLiveCitizenId = null;
    state.liveViewingCitizenId = null;
    state.liveLiked = false;
    state.viewerPoll = null;

    const tabBtn = el('liveTabBtn');
    const card = el('liveCard');
    if (tabBtn) tabBtn.style.display = (state.canPost && state.liveEnabled) ? 'flex' : 'none';
    if (card) card.style.display = state.liveEnabled ? 'block' : 'none';

    if (state.liveEnabled) loadLiveBroadcasts();
  }

  function handleMessage(msg) {
    if (msg.action === 'liveStarted') {
      liveBroadcasts[msg.citizenId] = { authorName: msg.authorName, title: msg.title };
      renderLiveBanners();
      if (!state.isLive) showToast(`${msg.authorName} is live: ${msg.title}`);
    } else if (msg.action === 'liveEnded') {
      delete liveBroadcasts[msg.citizenId];
      renderLiveBanners();
      // If we were watching exactly this broadcast, don't leave the viewer
      // stuck on a frozen/dead video with a "Connecting..." that'll never
      // resolve - close it out and let them know why.
      if (state.liveViewingCitizenId === msg.citizenId) {
        stopWatchingLive();
        showToast('That broadcast has ended.');
      }
    } else if (msg.action === 'liveViewerCount') {
      // Only ever received while WE are the one broadcasting (server only
      // ever targets this at a broadcast's own serverId).
      if (state.isLive) {
        const countEl = el('liveViewerCount');
        if (countEl) countEl.textContent = msg.count;
      }
    } else if (msg.action === 'liveComment') {
      addLiveCommentOverlay(msg.authorName, msg.body);
    } else if (msg.action === 'liveLikeUpdate') {
      updateLiveLikeDisplay(msg.likeCount);
    } else if (msg.action === 'livePollUpdate') {
      handleLivePollUpdate(msg.poll || null);
    }
  }

  window.registerWeazelNewsLiveAddon({
    closeOverlay: stopWatchingLive,
    init,
    handleMessage,
  });
})();
