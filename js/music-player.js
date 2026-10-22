/* ============================================================
   博客音乐播放器 - Pointer Events 完整版 v2
   修复：
   1. 进度拖动坐标基于 .mp-bar 内容区（排除 padding）
   2. 进度/音量用 pointerdown/move/up + setPointerCapture
   3. 拖动落地时若 audio.duration 无效，回退到预加载时长 durations[]
   4. URL 自动 encodeURI，中文路径更稳
   5. canplay / loadedmetadata 都应用 pendingSeek
   6. PJAX / swup / turbo 切换后自动重初始化，清理旧实例
   7. 调试：URL 加 ?mpdebug=1 或 localStorage.mpdebug=1 打开日志
   ============================================================ */
(function () {
  const ICON_PLAY = '<path d="M8 5v14l11-7z"/>';
  const ICON_PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
  const ICON_VOL = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>';
  const ICON_MUTE = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
  const SVG_PREV = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z"/></svg>';
  const SVG_NEXT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>';
  const ICON_ORDER = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h12v2H3v-2z"/></svg>';
  const ICON_LOOP_ONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/><text x="12" y="15.5" text-anchor="middle" font-size="7" fill="currentColor" stroke="none" font-weight="bold">1</text></svg>';
  const ICON_SHUFFLE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>';
  const PLAY_MODES = ['order', 'loop-one', 'shuffle'];
  const MODE_ICONS = { 'order': ICON_ORDER, 'loop-one': ICON_LOOP_ONE, 'shuffle': ICON_SHUFFLE };
  const MODE_TITLES = { 'order': '顺序播放', 'loop-one': '单曲循环', 'shuffle': '随机播放' };

  // ---- 调试开关 ----
  let DEBUG = /[?&]mpdebug=1/.test(location.search);
  try { if (localStorage.getItem('mpdebug') === '1') DEBUG = true; } catch (e) {}
  function log() { if (DEBUG) console.log.apply(console, ['[MP]'].concat([].slice.call(arguments))); }

  function safeUrl(u) {
    if (!u) return '';
    try { return encodeURI(decodeURI(u)); } catch (e) { return encodeURI(u); }
  }
  function fmt(s) {
    if (!isFinite(s) || isNaN(s)) return '00:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  function buildPlayer(container, playlist) {
    if (!playlist || !playlist.length) return;

    // 若容器里残留旧 wrap，先清掉
    const old = container.querySelector('.mp-wrap');
    if (old) {
      const oa = old.querySelector('audio');
      if (oa) { try { oa.pause(); oa.removeAttribute('src'); oa.load(); } catch (e) {} }
      old.remove();
    }

    container.innerHTML = `
      <div class="mp-wrap">
        <div class="mp-panel">
          <div class="mp-panel-inner">
            <div class="mp-cover-row">
              <img class="mp-cover" src="" alt="cover" />
              <div class="mp-info">
                <div class="mp-title">—</div>
                <div class="mp-artist">—</div>
              </div>
            </div>
            <div class="mp-progress-wrap">
              <div class="mp-bar">
                <div class="mp-bar-fill"></div>
                <div class="mp-bar-thumb"></div>
              </div>
              <div class="mp-time"><span class="mp-cur">00:00</span><span class="mp-dur">00:00</span></div>
            </div>
            <div class="mp-controls">
              <button class="mp-btn mp-mode-btn" title="顺序播放">${ICON_ORDER}</button>
              <button class="mp-btn mp-prev" title="上一首">${SVG_PREV}</button>
              <button class="mp-btn mp-play-btn" title="播放/暂停"><svg class="mp-play-icon" viewBox="0 0 24 24" fill="currentColor">${ICON_PLAY}</svg></button>
              <button class="mp-btn mp-next" title="下一首">${SVG_NEXT}</button>
              <button class="mp-btn mp-vol-icon" title="静音"><svg viewBox="0 0 24 24" fill="currentColor">${ICON_VOL}</svg></button>
            </div>
            <div class="mp-vol-row">
              <div class="mp-vol-slider"><div class="mp-vol-fill"></div></div>
            </div>
            <div class="mp-list-toggle">播放列表 ▾</div>
            <div class="mp-playlist"></div>
          </div>
        </div>
        <div class="mp-toggle" title="单击播放/暂停，双击展开面板">
          <img class="mp-toggle-cover" src="" alt="cover" />
        </div>
        <audio preload="metadata">
      </div>
    `;
    const wrap = container.querySelector('.mp-wrap');
    wrap.__mpContainer = container;
    document.body.appendChild(wrap);

    const audio = wrap.querySelector('audio');
    const panel = wrap.querySelector('.mp-panel');
    const toggle = wrap.querySelector('.mp-toggle');
    const toggleCover = wrap.querySelector('.mp-toggle-cover');
    const cover = wrap.querySelector('.mp-cover');
    const title = wrap.querySelector('.mp-title');
    const artist = wrap.querySelector('.mp-artist');
    const barEl = wrap.querySelector('.mp-bar');
    const barFill = wrap.querySelector('.mp-bar-fill');
    const barThumb = wrap.querySelector('.mp-bar-thumb');
    const progressWrap = wrap.querySelector('.mp-progress-wrap');
    const curTime = wrap.querySelector('.mp-cur');
    const durTime = wrap.querySelector('.mp-dur');
    const playBtn = wrap.querySelector('.mp-play-btn');
    const playIcon = wrap.querySelector('.mp-play-icon');
    const prevBtn = wrap.querySelector('.mp-prev');
    const nextBtn = wrap.querySelector('.mp-next');
    const volSlider = wrap.querySelector('.mp-vol-slider');
    const volFill = wrap.querySelector('.mp-vol-fill');
    const volIcon = wrap.querySelector('.mp-vol-icon');
    const modeBtn = wrap.querySelector('.mp-mode-btn');
    const listToggle = wrap.querySelector('.mp-list-toggle');
    const playlistEl = wrap.querySelector('.mp-playlist');

    let curIndex = 0;
    let isPlaying = false;
    let volume = 0.7;
    let playMode = 0;
    let isSeeking = false;
    let wasPlayingBeforeSeek = false;
    let pendingSeek = null;
    const durations = new Array(playlist.length).fill(0);

    // ---- 有效时长：优先当前 audio，其次预加载缓存 ----
    function getDuration() {
      if (isFinite(audio.duration) && audio.duration > 0) return audio.duration;
      return durations[curIndex] || 0;
    }

    let clickTimer = null;
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
        panel.classList.toggle('mp-open');
        return;
      }
      clickTimer = setTimeout(function () {
        clickTimer = null;
        if (isPlaying) pause(); else play();
      }, 240);
    });

    function loadTrack(i, autoplay) {
      curIndex = (i + playlist.length) % playlist.length;
      const t = playlist[curIndex];
      audio.src = safeUrl(t.url);
      cover.src = safeUrl(t.cover);
      toggleCover.src = safeUrl(t.cover);
      title.textContent = t.name;
      artist.textContent = t.artist;
      barFill.style.width = '0%';
      barThumb.style.left = '0%';
      curTime.textContent = '00:00';
      durTime.textContent = durations[curIndex] ? fmt(durations[curIndex]) : '00:00';
      pendingSeek = null;
      playlistEl.querySelectorAll('.mp-track').forEach(function (el, idx) {
        el.classList.toggle('mp-active', idx === curIndex);
      });
      log('loadTrack', curIndex, t.name, audio.src);
      if (autoplay) play();
    }
    function play() {
      isPlaying = true;
      updatePlayIcon();
      const p = audio.play();
      if (p && p.catch) p.catch(function (err) {
        isPlaying = false; updatePlayIcon();
        log('play() rejected', err && err.name, err && err.message);
      });
    }
    function pause() {
      audio.pause();
      isPlaying = false;
      updatePlayIcon();
    }
    function updatePlayIcon() {
      playIcon.innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY;
      playBtn.title = isPlaying ? '暂停' : '播放';
      cover.classList.toggle('mp-spinning', isPlaying);
      toggle.classList.toggle('mp-playing', isPlaying);
    }
    function setVol(v) {
      volume = Math.max(0, Math.min(1, v));
      audio.volume = volume;
      volFill.style.width = (volume * 100) + '%';
      if (volume === 0) {
        audio.muted = true;
        volIcon.querySelector('svg').innerHTML = ICON_MUTE;
      } else {
        audio.muted = false;
        volIcon.querySelector('svg').innerHTML = ICON_VOL;
      }
    }
    playBtn.addEventListener('click', function (e) { e.stopPropagation(); if (isPlaying) pause(); else play(); });
    prevBtn.addEventListener('click', function (e) { e.stopPropagation(); loadTrack(curIndex - 1, true); });
    nextBtn.addEventListener('click', function (e) { e.stopPropagation(); loadTrack(curIndex + 1, true); });
    modeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      playMode = (playMode + 1) % PLAY_MODES.length;
      const mode = PLAY_MODES[playMode];
      modeBtn.innerHTML = MODE_ICONS[mode];
      modeBtn.title = MODE_TITLES[mode];
      modeBtn.classList.toggle('mp-active', mode !== 'order');
    });

    // ==========【进度条拖动：Pointer Events】==========
    function getTrackRect() {
      const r = barEl.getBoundingClientRect();
      const cs = getComputedStyle(barEl);
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      return { left: r.left + pl, width: Math.max(1, r.width - pl - pr) };
    }
    function pctFromX(clientX) {
      const r = getTrackRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    }
    function paint(pct) {
      const p = Math.max(0, Math.min(1, pct));
      barFill.style.width = (p * 100) + '%';
      barThumb.style.left = (p * 100) + '%';
      const d = getDuration();
      if (d > 0) curTime.textContent = fmt(p * d);
    }
    function seekBegin(clientX) {
      isSeeking = true;
      wasPlayingBeforeSeek = isPlaying;
      progressWrap.classList.add('mp-seeking');
      paint(pctFromX(clientX));
    }
    function seekMove(clientX) {
      if (!isSeeking) return;
      paint(pctFromX(clientX));
    }
    function tryApplySeek(pct) {
      const d = getDuration();
      if (d <= 0) return false;
      try {
        audio.currentTime = pct * d;
        curTime.textContent = fmt(audio.currentTime);
        pendingSeek = null;
        return true;
      } catch (e) {
        log('set currentTime failed', e);
        return false;
      }
    }
    function seekFinish(clientX) {
      if (!isSeeking) return;
      const pct = pctFromX(clientX);
      isSeeking = false;
      progressWrap.classList.remove('mp-seeking');
      paint(pct);
      if (!tryApplySeek(pct)) {
        pendingSeek = pct;
        log('pendingSeek', pct);
      }
      if (wasPlayingBeforeSeek && audio.paused) play();
    }

    progressWrap.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      log('pointerdown x=', e.clientX, 'rect=', getTrackRect(), 'dur=', getDuration());
      try { progressWrap.setPointerCapture(e.pointerId); } catch (err) {}
      seekBegin(e.clientX);
    });
    progressWrap.addEventListener('pointermove', function (e) {
      if (!isSeeking) return;
      seekMove(e.clientX);
    });
    progressWrap.addEventListener('pointerup', function (e) {
      if (!isSeeking) return;
      try { progressWrap.releasePointerCapture(e.pointerId); } catch (err) {}
      seekFinish(e.clientX);
    });
    progressWrap.addEventListener('pointercancel', function () {
      if (!isSeeking) return;
      isSeeking = false;
      progressWrap.classList.remove('mp-seeking');
    });

    // ==========【音量拖动：Pointer Events】==========
    function volPct(clientX) {
      const r = volSlider.getBoundingClientRect();
      if (!r.width) return volume;
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    }
    let volSeeking = false;
    volSlider.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      volSeeking = true;
      try { volSlider.setPointerCapture(e.pointerId); } catch (err) {}
      setVol(volPct(e.clientX));
    });
    volSlider.addEventListener('pointermove', function (e) {
      if (volSeeking) setVol(volPct(e.clientX));
    });
    volSlider.addEventListener('pointerup', function (e) {
      if (!volSeeking) return;
      try { volSlider.releasePointerCapture(e.pointerId); } catch (err) {}
      volSeeking = false;
    });
    volSlider.addEventListener('pointercancel', function () { volSeeking = false; });

    volIcon.addEventListener('click', function (e) {
      e.stopPropagation();
      if (audio.muted || volume === 0) setVol(0.7); else setVol(0);
    });

    function renderPlaylist() {
      playlistEl.innerHTML = playlist.map(function (t, i) {
        return '<div class="mp-track ' + (i === curIndex ? 'mp-active' : '') + '" data-idx="' + i + '">'
          + '<span class="mp-track-idx">'
          + '<span class="mp-equalizer"><span class="mp-eq-bar"></span><span class="mp-eq-bar"></span><span class="mp-eq-bar"></span></span>'
          + '<span class="mp-idx-num">' + String(i + 1).padStart(2, '0') + '</span>'
          + '</span>'
          + '<div class="mp-track-info">'
          + '<div class="mp-track-name">' + t.name + '</div>'
          + '<div class="mp-track-artist">' + t.artist + '</div>'
          + '</div>'
          + '<span class="mp-track-dur">' + (durations[i] ? fmt(durations[i]) : '--:--') + '</span>'
          + '</div>';
      }).join('');
      playlistEl.querySelectorAll('.mp-track').forEach(function (el) {
        el.addEventListener('click', function () { loadTrack(parseInt(el.dataset.idx, 10), true); });
      });
    }
    function preloadDurations() {
      playlist.forEach(function (t, i) {
        const probe = new Audio();
        probe.preload = 'metadata';
        probe.src = safeUrl(t.url);
        probe.addEventListener('loadedmetadata', function () {
          if (!isFinite(probe.duration)) return;
          durations[i] = probe.duration;
          const el = playlistEl.querySelector('.mp-track[data-idx="' + i + '"] .mp-track-dur');
          if (el) el.textContent = fmt(probe.duration);
          if (i === curIndex && !(isFinite(audio.duration) && audio.duration > 0)) {
            durTime.textContent = fmt(probe.duration);
          }
        });
        probe.addEventListener('error', function () {
          log('probe error', i, t.name, probe.src);
        });
      });
    }
    listToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      const open = playlistEl.classList.toggle('mp-show');
      listToggle.textContent = open ? '播放列表 ▴' : '播放列表 ▾';
    });

    function applyPendingSeek() {
      if (pendingSeek !== null && getDuration() > 0) {
        if (tryApplySeek(pendingSeek)) {
          paint(pendingSeek);
          log('applied pendingSeek', pendingSeek);
        }
      }
    }
    audio.addEventListener('timeupdate', function () {
      if (isSeeking) return;
      const d = getDuration();
      if (d <= 0) return;
      const pct = (audio.currentTime / d) * 100;
      barFill.style.width = pct + '%';
      barThumb.style.left = pct + '%';
      curTime.textContent = fmt(audio.currentTime);
    });
    audio.addEventListener('loadedmetadata', function () {
      const d = getDuration();
      if (d > 0) durTime.textContent = fmt(d);
      applyPendingSeek();
    });
    audio.addEventListener('canplay', applyPendingSeek);
    audio.addEventListener('error', function () {
      log('audio error', audio.error && audio.error.code, audio.src);
    });
    audio.addEventListener('ended', function () {
      const mode = PLAY_MODES[playMode];
      if (mode === 'loop-one') { audio.currentTime = 0; play(); }
      else if (mode === 'shuffle') {
        let next = curIndex;
        if (playlist.length > 1) {
          do { next = Math.floor(Math.random() * playlist.length); } while (next === curIndex);
        }
        loadTrack(next, true);
      } else {
        loadTrack(curIndex + 1, true);
      }
    });

    setVol(0.7);
    renderPlaylist();
    preloadDurations();
    loadTrack(0, false);
  }

  function initAll() {
    // 清理已脱离文档的旧播放器（PJAX 切换后）
    document.querySelectorAll('body > .mp-wrap').forEach(function (w) {
      const c = w.__mpContainer;
      if (c && document.contains(c)) return;   // 仍有效，保留
      const a = w.querySelector('audio');
      if (a) { try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) {} }
      w.remove();
    });
    document.querySelectorAll('.music-player').forEach(function (el) {
      if (el.dataset.mpInited === '1') return;
      let songs = [];
      try { songs = JSON.parse(el.dataset.songs || '[]'); }
      catch (err) { songs = []; log('JSON parse error', err); }
      if (songs.length) {
        buildPlayer(el, songs);
        el.dataset.mpInited = '1';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
  // PJAX / swup / turbo 兼容
  ['pjax:complete', 'swup:contentReplaced', 'turbo:load'].forEach(function (ev) {
    document.addEventListener(ev, function () { setTimeout(initAll, 0); });
  });
  // 手动重初始化
  window.__initMusicPlayer = initAll;
})();