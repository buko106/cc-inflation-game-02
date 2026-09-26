/*
 * 画面描画と操作。Game エンジンのイベントを受けて演出を出し、定期的に表示を更新する。
 */
(function () {
  'use strict';

  const D = window.GameData;
  const SAVE_KEY = 'inflation-quest-save-v1';
  const TAB_KEY = 'inflation-quest-tab';
  const STEP = 0.05; // ゲームの1ティック（秒）
  const AUTOSAVE_SEC = 10;
  const MAX_POPUPS = 40;

  const $ = (id) => document.getElementById(id);
  const B = (x) => BigNum.from(x);

  let game;
  let lastFrame = 0;
  let acc = 0;
  let slowTimer = 0;
  let autosaveTimer = 0;
  let lastTapAt = 0;
  let bannerUntil = 0;
  let pendingLevelUp = null;
  let pendingChain = null;
  let chainFlushAt = 0;
  let currentTab = 'equip';
  let lastHeroTitle = '';

  // ---------------------------------------------------------------------------
  // 表示ヘルパー
  // ---------------------------------------------------------------------------
  const fmt = (x) => BigNum.format(x, game.state.settings.notation);

  function fmtMult(x) {
    const b = B(x);
    if (b.lt(1000)) return trimNum(b.toNumber(), 2);
    return fmt(b);
  }

  function trimNum(n, digits) {
    return n.toFixed(digits).replace(/\.?0+$/, '');
  }

  function fmtTime(sec) {
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}時間${m}分`;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 数値の桁数から、ダメージ表示の色の段階を決める
  function magnitudeTier(b) {
    const e = b.e;
    if (e < 4) return 0;
    if (e < 8) return 1;
    if (e < 16) return 2;
    if (e < 32) return 3;
    if (e < 68) return 4;
    if (e < 308) return 5;
    return 6;
  }

  // 桁が増えるほど文字も大きくする
  function popSize(b, base) {
    const digits = Math.max(0, b.e);
    return Math.min(base + Math.log2(digits + 1) * 3.2, base + 26);
  }

  const HERO_TITLES = [
    [0, '見習い勇者'], [2, '駆け出し勇者'], [4, '一人前の勇者'], [8, '歴戦の勇者'], [12, '伝説の勇者'],
    [16, '神話の勇者'], [32, '天文学的勇者'], [68, '無量大数の勇者'], [100, 'グーゴル勇者'],
    [308, '∞を超えた勇者'], [1000, '千桁の勇者'], [10000, '万桁の勇者'], [1e6, '桁が桁を超えた勇者'],
  ];

  function heroTitle(level) {
    const e = level.e;
    let t = HERO_TITLES[0][1];
    for (const [min, name] of HERO_TITLES) if (e >= min) t = name;
    return t;
  }

  // 桁の梯子: 最大ダメージがどの単位まで届いたか
  const LADDER = [
    ['万', 4], ['億', 8], ['兆', 12], ['京', 16], ['垓', 20], ['秭', 24], ['穣', 28], ['溝', 32], ['澗', 36],
    ['正', 40], ['載', 44], ['極', 48], ['恒河沙', 52], ['阿僧祇', 56], ['那由他', 60], ['不可思議', 64],
    ['無量大数', 68], ['グーゴル', 100], ['∞突破', 308], ['千桁', 1000], ['万桁', 1e4], ['十万桁', 1e5],
    ['百万桁', 1e6],
  ];

  // ---------------------------------------------------------------------------
  // セーブ / ロード（localStorage は使えない環境もあるので必ず try/catch）
  // ---------------------------------------------------------------------------
  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* 何もしない */ }
  }

  function snapshot() {
    const data = game.serialize();
    data.savedAt = Date.now();
    return data;
  }

  function save() {
    return storageSet(SAVE_KEY, JSON.stringify(snapshot()));
  }

  function loadSaved() {
    const raw = storageGet(SAVE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function encodeSave() {
    const json = JSON.stringify(snapshot());
    return btoa(unescape(encodeURIComponent(json)));
  }

  function decodeSave(text) {
    const json = decodeURIComponent(escape(atob(text.trim())));
    const data = JSON.parse(json);
    if (!data || typeof data !== 'object' || !('totalExp' in data)) throw new Error('invalid');
    return data;
  }

  // ---------------------------------------------------------------------------
  // ログ / 演出
  // ---------------------------------------------------------------------------
  const logLines = [];
  function log(html) {
    logLines.push(html);
    if (logLines.length > 6) logLines.shift();
    $('log').innerHTML = logLines.map((l) => `<p>${l}</p>`).join('');
  }

  function popup(text, opts) {
    const layer = $('popups');
    while (layer.childElementCount >= MAX_POPUPS) layer.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'pop ' + (opts.cls || '');
    el.textContent = text;
    el.style.left = opts.x + '%';
    el.style.top = opts.y + '%';
    el.style.fontSize = (opts.size || 18) + 'px';
    el.addEventListener('animationend', (ev) => { if (ev.animationName !== 'rainbow') el.remove(); });
    layer.appendChild(el);
  }

  function damagePopup(amount, source, crit, pos) {
    const tier = magnitudeTier(amount);
    const base = source === 'party' ? 13 : source === 'tap' ? 17 : 19;
    let size = popSize(amount, base);
    if (crit) size *= 1.25;
    const cls = [source === 'party' ? 'party' : 't' + tier, crit ? 'crit' : ''].join(' ');
    const x = pos ? pos.x : 50 + (Math.random() * 30 - 15);
    const y = pos ? pos.y : 38 + (Math.random() * 16 - 8);
    popup(fmt(amount), { cls, x, y, size });
  }

  function banner(title, sub, cls) {
    const el = $('banner');
    el.className = 'banner';
    el.innerHTML = `<strong>${escapeHtml(title)}</strong>${sub ? `<span>${escapeHtml(sub)}</span>` : ''}`;
    void el.offsetWidth; // アニメーションを再生し直す
    el.className = 'banner show ' + (cls || '');
    bannerUntil = performance.now() + 1600;
  }

  function spriteAnim(cls) {
    const sp = $('sprite');
    sp.classList.remove('hit', 'dying', 'spawning');
    if (!cls) return;
    void sp.offsetWidth;
    sp.classList.add(cls);
  }

  // ---------------------------------------------------------------------------
  // ゲームイベント
  // ---------------------------------------------------------------------------
  function onGameEvent(type, d) {
    switch (type) {
      case 'hit':
        if (d.source !== 'tap') damagePopup(d.amount, d.source, d.crit, null);
        spriteAnim('hit');
        break;
      case 'partyHit':
        damagePopup(d.amount, 'party', false, { x: 22 + Math.random() * 12, y: 30 + Math.random() * 20 });
        break;
      case 'kill':
        spriteAnim('dying');
        popup('+' + fmt(d.gold) + 'G', { cls: 'gold', x: 50 + (Math.random() * 20 - 10), y: 64, size: 15 });
        if (d.enemy.isBoss) log(`${escapeHtml(d.enemy.name)}を たおした！ <span class="g">${fmt(d.gold)}G</span> と <span class="x">${fmt(d.exp)}EXP</span> を手に入れた`);
        break;
      case 'chain':
        if (!pendingChain) pendingChain = { kills: 0, areas: 0, gold: BigNum.ZERO, areaFrom: d.areaFrom };
        pendingChain.kills += d.kills;
        pendingChain.areas += d.areas;
        pendingChain.gold = pendingChain.gold.add(d.gold);
        pendingChain.areaTo = d.areaTo;
        popup(`貫通 ×${d.kills}`, { cls: 'chain', x: 50, y: 22, size: 18 });
        break;
      case 'spawn':
        renderEnemy(true);
        break;
      case 'levelUp':
        if (!pendingLevelUp) pendingLevelUp = { from: d.from };
        pendingLevelUp.to = d.to;
        break;
      case 'areaClear':
        log(`エリア${d.cleared} を クリアした！`);
        break;
      case 'bossFail':
        banner(d.reason === 'timeout' ? '時間切れ…' : 'やられた…', '修行モードで力をためよう', 'bad');
        log(`<span class="r">${escapeHtml(d.boss ? d.boss.name : 'ボス')}を 倒しきれなかった…</span> 自動進行をOFFにして修行モードへ`);
        break;
      case 'death':
        banner('ちからつきた…', `エリア${d.to}へ撤退`, 'bad');
        log(`<span class="r">勇者は ちからつきた…</span> エリア${d.to}へ撤退した。防具を強化しよう`);
        break;
      case 'heroHit': {
        const bar = $('heroHpFill').parentElement;
        bar.classList.remove('hurt');
        void bar.offsetWidth;
        bar.classList.add('hurt');
        break;
      }
      case 'skill':
        log(`${d.skill.icon} <span class="v">${escapeHtml(d.skill.name)}</span>！ ${escapeHtml(d.skill.desc)}`);
        break;
      case 'autoAdvance':
      case 'areaChange':
        renderSlow();
        break;
      case 'purchase':
        renderSlow();
        break;
      default:
        break;
    }
  }

  // 連続で届くイベントは1秒ごとにまとめてログに出す
  function flushBatched(now) {
    if (now < chainFlushAt) return;
    chainFlushAt = now + 1000;
    if (pendingChain) {
      const c = pendingChain;
      pendingChain = null;
      const area = c.areas > 0 ? ` エリア${c.areaFrom}→${c.areaTo}` : '';
      log(`<span class="v">貫通攻撃！</span> ${fmt(c.kills)}体をまとめて撃破${area} <span class="g">+${fmt(c.gold)}G</span>`);
    }
    if (pendingLevelUp && now > bannerUntil - 600) {
      const l = pendingLevelUp;
      pendingLevelUp = null;
      const diff = l.to.sub(l.from);
      banner('LEVEL UP!', `Lv ${fmt(l.from)} → ${fmt(l.to)}`);
      log(`レベルが <span class="x">${fmt(diff)}</span> 上がった！ Lv ${fmt(l.to)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------
  let lastEnemyRef = null;
  function renderEnemy(spawned) {
    const e = game.enemy;
    const sp = $('sprite');
    if (!e) return;
    if (e !== lastEnemyRef) {
      lastEnemyRef = e;
      sp.textContent = e.emoji;
      sp.classList.toggle('boss', e.isBoss);
      $('enemyName').textContent = e.isBoss ? `👑 ${e.name}` : e.name;
      $('enemyName').classList.toggle('boss', e.isBoss);
      spriteAnim(spawned ? 'spawning' : null);
    }
  }

  function renderFast() {
    const s = game.state;
    const st = game.getStats();
    const e = game.enemy;
    if (e) {
      renderEnemy(false);
      const ratio = e.maxHp.isZero() ? 0 : e.hp.div(e.maxHp).toNumber();
      $('enemyHpFill').style.width = (Math.max(0, Math.min(1, ratio)) * 100).toFixed(1) + '%';
      $('enemyHpText').textContent = `${fmt(e.hp.max(0))} / ${fmt(e.maxHp)}`;
    } else {
      $('enemyHpFill').style.width = '0%';
    }
    const bossOn = !!(e && e.isBoss);
    $('bossTimer').hidden = !bossOn;
    if (bossOn) {
      const limit = game.bossTimeLimit();
      $('bossTimerFill').style.width = (Math.max(0, game.bossTimeLeft / limit) * 100).toFixed(1) + '%';
      $('bossTimerSec').textContent = Math.max(0, game.bossTimeLeft).toFixed(1);
    }
    const hpRatio = game.heroHp.div(st.maxHp).toNumber();
    $('heroHpFill').style.width = (Math.max(0, Math.min(1, hpRatio)) * 100).toFixed(1) + '%';
    $('heroHpText').textContent = `${fmt(game.heroHp.max(0))} / ${fmt(st.maxHp)}`;
    $('heroExpFill').style.width = (game.levelProgress() * 100).toFixed(1) + '%';
    $('gold').textContent = fmt(s.gold);
    renderSkills();
  }

  function renderSlow() {
    const s = game.state;
    const st = game.getStats();
    const info = Game.areaInfo(s.area);

    $('areaNo').textContent = `エリア ${s.area.toLocaleString()}`;
    $('areaName').textContent = info.name;
    $('field').style.setProperty('--hue', info.hue);
    $('prevArea').disabled = s.area <= 1;
    $('nextArea').disabled = s.area >= s.maxArea;

    const pips = $('pips');
    if (pips.childElementCount !== Game.CONFIG.enemiesPerArea) {
      pips.innerHTML = '';
      for (let i = 0; i < Game.CONFIG.enemiesPerArea; i++) pips.appendChild(document.createElement('i'));
    }
    const bossNow = !!(game.enemy && game.enemy.isBoss);
    [...pips.children].forEach((p, i) => {
      const isBoss = i === Game.CONFIG.enemiesPerArea - 1;
      p.className = [isBoss ? 'boss' : '', i < s.kills ? 'done' : '', isBoss && bossNow ? 'now' : ''].join(' ');
    });

    const auto = $('autoAdv');
    auto.setAttribute('aria-pressed', String(s.autoAdvance));
    auto.textContent = s.autoAdvance ? '自動進行 ON' : (s.kills >= Game.CONFIG.enemiesPerArea - 1 ? 'ボスに挑む ▶' : '修行中（自動進行 OFF）');

    $('souls').textContent = fmt(s.souls);
    $('heroLv').textContent = fmt(st.level);
    const title = heroTitle(st.level);
    if (title !== lastHeroTitle) {
      if (lastHeroTitle) log(`称号が「<span class="g">${escapeHtml(title)}</span>」になった！`);
      lastHeroTitle = title;
      $('heroTitle').textContent = title;
    }
    $('heroExpText').textContent = `あと ${fmt(game.expToNext())}`;
    $('statAtk').textContent = fmt(st.atk);
    $('statDef').textContent = fmt(st.def);
    $('statParty').textContent = fmt(st.partyDps);
    $('statDps').textContent = fmt(st.heroDps.add(st.partyDps));

    renderLadder();
    if (currentTab === 'equip') renderEquip();
    if (currentTab === 'party') renderParty();
    if (currentTab === 'soul') renderSoul();
    if (currentTab === 'record') renderRecords();
  }

  let ladderBuilt = false;
  let ladderReached = -1;
  function renderLadder() {
    const ol = $('ladder');
    if (!ladderBuilt) {
      ol.innerHTML = LADDER.map(([name, e]) => `<li title="1e${e}">${name}</li>`).join('');
      ladderBuilt = true;
    }
    const maxE = game.state.stats.maxDamage.isZero() ? -1 : game.state.stats.maxDamage.e;
    let reached = -1;
    LADDER.forEach(([, e], i) => { if (maxE >= e) reached = i; });
    if (reached === ladderReached) return;
    [...ol.children].forEach((li, i) => {
      li.className = i <= reached ? 'reached' : i === reached + 1 ? 'next' : '';
    });
    if (ladderReached >= 0 && reached > ladderReached) {
      log(`ダメージが「<span class="g">${LADDER[reached][0]}</span>」の桁に到達した！`);
    }
    ladderReached = reached;
    const next = ol.children[reached + 1] || ol.children[reached];
    if (next) {
      const left = next.offsetLeft - ol.clientWidth / 2;
      ol.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    }
  }

  // --- 装備 ---
  const equipRefs = {};
  function buildEquip() {
    const root = $('equipRows');
    root.innerHTML = '';
    for (const def of D.EQUIPMENT) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="row-icon">${def.icon}</div>
        <div class="row-main">
          <div class="row-title"><span class="slot">${def.slot}</span><span class="name"></span><span class="lv"></span></div>
          <div class="row-sub"></div>
        </div>
        <button type="button" class="buy"><span class="buy-lv"></span><span class="buy-cost"></span></button>`;
      const btn = row.querySelector('.buy');
      btn.addEventListener('click', () => {
        const before = Game.equipName(def, game.state.equip[def.id]).replace(/ \+\d+$/, '');
        if (game.buyEquip(def.id, game.state.settings.buyAmount)) {
          const after = Game.equipName(def, game.state.equip[def.id]).replace(/ \+\d+$/, '');
          if (after !== before) log(`${def.slot}が <span class="g">${escapeHtml(after)}</span> に進化した！`);
        }
      });
      root.appendChild(row);
      equipRefs[def.id] = {
        name: row.querySelector('.name'),
        lv: row.querySelector('.lv'),
        sub: row.querySelector('.row-sub'),
        btn,
        btnLv: row.querySelector('.buy-lv'),
        btnCost: row.querySelector('.buy-cost'),
      };
    }
  }

  function renderEquip() {
    const s = game.state;
    for (const def of D.EQUIPMENT) {
      const r = equipRefs[def.id];
      const n = s.equip[def.id];
      const { levels, cost } = game.equipCost(def.id, s.settings.buyAmount);
      r.name.textContent = Game.equipName(def, n);
      r.lv.textContent = `Lv ${n.toLocaleString()}`;
      const cur = game.equipMult(def.id, n);
      const next = game.equipMult(def.id, n + levels);
      const toEvolve = D.EQUIP_EVOLVE_EVERY - (n % D.EQUIP_EVOLVE_EVERY);
      r.sub.innerHTML = `${def.effect} ×<b>${fmtMult(cur)}</b> <span class="next">→ ×${fmtMult(next)}</span> <span class="milestone">進化まで ${toEvolve}</span>`;
      r.btnLv.textContent = `+${levels.toLocaleString()} 強化`;
      r.btnCost.textContent = `${fmt(cost)}G`;
      r.btn.disabled = s.gold.lt(cost);
    }
  }

  // --- 仲間 ---
  const partyRefs = [];
  function buildParty() {
    const root = $('partyRows');
    root.innerHTML = '';
    D.PARTY.forEach((def, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="row-icon"></div>
        <div class="row-main">
          <div class="row-title"><span class="name"></span><span class="lv"></span></div>
          <div class="row-sub"></div>
          <div class="share"><i></i></div>
        </div>
        <button type="button" class="buy"><span class="buy-lv"></span><span class="buy-cost"></span></button>`;
      const btn = row.querySelector('.buy');
      btn.addEventListener('click', () => {
        const wasZero = game.state.party[i] === 0;
        if (game.buyParty(i, game.state.settings.buyAmount) && wasZero) {
          log(`${def.icon} <span class="v">${escapeHtml(def.name)}</span>が 仲間になった！`);
          buildParty();
          renderParty();
        }
      });
      root.appendChild(row);
      partyRefs[i] = {
        row,
        icon: row.querySelector('.row-icon'),
        name: row.querySelector('.name'),
        lv: row.querySelector('.lv'),
        sub: row.querySelector('.row-sub'),
        share: row.querySelector('.share'),
        shareFill: row.querySelector('.share i'),
        btn,
        btnLv: row.querySelector('.buy-lv'),
        btnCost: row.querySelector('.buy-cost'),
      };
    });
  }

  function renderParty() {
    const s = game.state;
    const st = game.getStats();
    let firstLockedShown = false;
    D.PARTY.forEach((def, i) => {
      const r = partyRefs[i];
      const unlocked = game.partyUnlocked(i);
      // 未解放の仲間は次の1人だけシルエットで見せる
      const visible = unlocked || !firstLockedShown;
      if (!unlocked) firstLockedShown = true;
      r.row.hidden = !visible;
      if (!visible) {
        r.btn.disabled = true;
        return;
      }
      r.row.classList.toggle('locked', !unlocked);
      const n = s.party[i];
      if (!unlocked) {
        r.icon.textContent = '❔';
        r.name.textContent = '？？？';
        r.lv.textContent = '';
        r.sub.textContent = '前の仲間を雇うと出会える';
        r.share.hidden = true;
        r.btn.disabled = true;
        r.btnLv.textContent = '未解放';
        r.btnCost.textContent = '—';
        return;
      }
      const { levels, cost } = game.partyCost(i, s.settings.buyAmount);
      const ratio = game.partyMemberRatio(i, n);
      const nextRatio = game.partyMemberRatio(i, n + levels);
      const toMilestone = D.PARTY_MILESTONE_EVERY - (n % D.PARTY_MILESTONE_EVERY);
      r.icon.textContent = def.icon;
      r.name.textContent = def.name;
      r.lv.textContent = n > 0 ? `Lv ${n.toLocaleString()}` : '未加入';
      r.sub.innerHTML = `攻撃力 ×<b>${fmtMult(ratio)}</b> /秒 <span class="next">→ ×${fmtMult(nextRatio)}</span> <span class="milestone">×4まで ${toMilestone}</span>`;
      const share = st.partyRatio.isZero() ? 0 : ratio.div(st.partyRatio).toNumber();
      r.share.hidden = n === 0;
      r.shareFill.style.width = (Math.min(1, share) * 100).toFixed(1) + '%';
      r.btnLv.textContent = n === 0 ? '雇う' : `+${levels.toLocaleString()} Lv`;
      r.btnCost.textContent = `${fmt(cost)}G`;
      r.btn.disabled = s.gold.lt(cost);
    });
  }

  // --- 転生 ---
  const soulRefs = {};
  function buildSoul() {
    const root = $('soulRows');
    root.innerHTML = '';
    for (const def of D.SOUL_UPGRADES) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="row-icon">${def.icon}</div>
        <div class="row-main">
          <div class="row-title"><span class="name">${def.name}</span><span class="lv"></span></div>
          <div class="row-sub"></div>
        </div>
        <button type="button" class="buy soul"><span class="buy-lv">強化</span><span class="buy-cost"></span></button>`;
      const btn = row.querySelector('.buy');
      btn.addEventListener('click', () => {
        if (game.buySoulUpgrade(def.id)) log(`${def.icon} <span class="s">${escapeHtml(def.name)}</span>が Lv${game.state.soulUpgrades[def.id]} になった`);
      });
      root.appendChild(row);
      soulRefs[def.id] = { lv: row.querySelector('.lv'), sub: row.querySelector('.row-sub'), btn, btnCost: row.querySelector('.buy-cost') };
    }
  }

  function soulEffectText(id, lv) {
    switch (id) {
      case 'power': return `攻撃力・仲間DPS ×<b>${fmtMult(B(2).pow(lv))}</b>`;
      case 'wealth': return `ゴールド ×<b>${fmtMult(B(2).pow(lv))}</b>`;
      case 'wisdom': return `経験値 ×<b>${fmtMult(B(3).pow(lv))}</b>`;
      case 'vitality': return `最大HP・防御力 ×<b>${fmtMult(B(3).pow(lv))}</b>`;
      case 'time': return `ボス制限時間 <b>${Game.CONFIG.bossTime + 5 * lv}秒</b>`;
      case 'soul': return `転生で得る魂 ×<b>${fmtMult(B(1.5).pow(lv))}</b>`;
      default: return '';
    }
  }

  function renderSoul() {
    const s = game.state;
    const gain = game.soulsOnPrestige();
    $('soulBonus').textContent = '×' + fmtMult(game.soulPassiveMult());
    $('soulGain').textContent = '+' + fmt(gain);
    const btn = $('prestigeBtn');
    btn.disabled = gain.lt(1);
    btn.textContent = gain.lt(1) ? '転生する' : `転生する（魂 +${fmt(gain)}）`;
    const min = Game.CONFIG.prestigeMinArea;
    $('prestigeNote').textContent = s.maxArea < min
      ? `エリア${min}に到達すると転生できる（いまの最高: エリア${s.maxArea}）。`
      : `到達エリアが1つ進むごとに、得られる魂は約${trimNum((Game.CONFIG.soulGrowth - 1) * 100, 0)}%増える。進めなくなったら転生しどき。`;
    for (const def of D.SOUL_UPGRADES) {
      const r = soulRefs[def.id];
      const lv = s.soulUpgrades[def.id];
      const maxed = game.soulUpgradeMaxed(def.id);
      const cost = game.soulUpgradeCost(def.id);
      r.lv.textContent = `Lv ${lv.toLocaleString()}${def.max ? ' / ' + def.max : ''}`;
      r.sub.innerHTML = `${escapeHtml(def.desc)}<br>いま: ${soulEffectText(def.id, lv)}`;
      r.btnCost.textContent = maxed ? '最大' : `魂 ${fmt(cost)}`;
      r.btn.disabled = maxed || s.souls.lt(cost);
    }
  }

  // --- 記録 ---
  function renderRecords() {
    const s = game.state;
    const st = s.stats;
    const rows = [
      ['プレイ時間', fmtTime(st.playTime)],
      ['最高到達エリア', `エリア ${s.bestArea.toLocaleString()}`],
      ['最大ダメージ', fmt(st.maxDamage)],
      ['累計ゴールド', fmt(st.totalGold) + 'G'],
      ['倒した敵', fmt(st.kills)],
      ['倒したボス', fmt(st.bossKills)],
      ['ちからつきた回数', fmt(st.deaths)],
      ['転生回数', fmt(st.prestiges)],
      ['累計の魂', fmt(st.totalSouls)],
      ['今回の最高エリア', `エリア ${s.maxArea.toLocaleString()}`],
    ];
    $('records').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');
    document.querySelectorAll('[data-notation]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.notation === s.settings.notation));
    });
  }

  // --- スキル ---
  const skillRefs = {};
  function buildSkills() {
    const root = $('skills');
    root.innerHTML = '';
    D.SKILLS.forEach((def, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'skill';
      btn.innerHTML = `<span class="skill-icon">${def.icon}</span><span class="skill-name">${def.name}</span><span class="skill-state"></span>`;
      btn.title = `${def.name} [${i + 1}]: ${def.desc}（再使用 ${def.cooldown}秒）`;
      btn.addEventListener('click', () => game.useSkill(def.id));
      root.appendChild(btn);
      skillRefs[def.id] = { btn, state: btn.querySelector('.skill-state') };
    });
  }

  function renderSkills() {
    const s = game.state;
    for (const def of D.SKILLS) {
      const r = skillRefs[def.id];
      const sk = s.skills[def.id];
      const unlocked = game.skillUnlocked(def.id);
      const active = sk.active > 0;
      const ready = unlocked && sk.cooldown <= 0;
      r.btn.classList.toggle('locked', !unlocked);
      r.btn.classList.toggle('active', active);
      r.btn.classList.toggle('ready', ready && !active);
      r.btn.disabled = !ready;
      r.btn.style.setProperty('--cd', unlocked && !active ? (sk.cooldown / def.cooldown).toFixed(3) : 0);
      let text;
      if (!unlocked) text = `エリア${def.unlockArea}`;
      else if (active) text = `▶ ${Math.ceil(sk.active)}秒`;
      else if (sk.cooldown > 0) text = `${Math.ceil(sk.cooldown)}秒`;
      else text = '使える';
      if (r.state.textContent !== text) r.state.textContent = text;
    }
  }

  // ---------------------------------------------------------------------------
  // モーダル（alert/confirm は使えない環境があるので自前）
  // ---------------------------------------------------------------------------
  function openModal(title, bodyHtml, actions) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHtml;
    const act = $('modalActions');
    act.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (a.cls) b.className = a.cls;
      b.addEventListener('click', () => {
        if (a.onClick && a.onClick() === false) return;
        closeModal();
      });
      act.appendChild(b);
    }
    $('modal').hidden = false;
    const primary = act.querySelector('.primary') || act.lastElementChild;
    if (primary) primary.focus();
  }

  function closeModal() {
    $('modal').hidden = true;
  }

  function showOffline(r) {
    if (!r) return;
    const lv = r.levelTo.gt(r.levelFrom) ? `<p>レベルが <b>${fmt(r.levelFrom)} → ${fmt(r.levelTo)}</b> に上がった。</p>` : '';
    openModal('おかえりなさい', `
      <p>留守にしていた <b>${fmtTime(r.seconds)}</b> の間も、勇者と仲間はエリア${game.state.area}で戦い続けていた。</p>
      <p>倒した敵 <b>${fmt(r.kills)}</b> 体 / ゴールド <b>+${fmt(r.gold)}G</b> / 経験値 <b>+${fmt(r.exp)}</b></p>${lv}`,
    [{ label: 'つづける', cls: 'primary' }]);
    log(`放置中に <span class="g">${fmt(r.gold)}G</span> と <span class="x">${fmt(r.exp)}EXP</span> を手に入れた`);
  }

  // ---------------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------------
  function doTap(ev) {
    const now = performance.now();
    if (now - lastTapAt < 50) return; // 連打の上限: 秒間20回
    lastTapAt = now;
    if (!game.enemy) return;
    let pos = null;
    if (ev && ev.clientX !== undefined) {
      const rect = $('field').getBoundingClientRect();
      pos = { x: ((ev.clientX - rect.left) / rect.width) * 100, y: ((ev.clientY - rect.top) / rect.height) * 100 - 6 };
    }
    // タップのダメージ表示は、押した位置に出す
    const handler = (type, d) => { if (type === 'hit' && d.source === 'tap') damagePopup(d.amount, 'tap', d.crit, pos); };
    game.listeners.push(handler);
    game.tap();
    game.listeners.splice(game.listeners.indexOf(handler), 1);
  }

  function selectTab(name) {
    currentTab = name;
    storageSet(TAB_KEY, name);
    for (const t of ['equip', 'party', 'soul', 'record']) {
      $('tab-' + t).setAttribute('aria-selected', String(t === name));
      $('panel-' + t).hidden = t !== name;
    }
    $('buyAmount').hidden = !(name === 'equip' || name === 'party');
    renderSlow();
  }

  function renderBuyAmount() {
    document.querySelectorAll('#buyAmount [data-amount]').forEach((b) => {
      const v = b.dataset.amount === 'max' ? 'max' : Number(b.dataset.amount);
      b.setAttribute('aria-checked', String(v === game.state.settings.buyAmount));
    });
  }

  function bindControls() {
    const enemyBtn = $('enemy');
    enemyBtn.addEventListener('pointerdown', (ev) => { ev.preventDefault(); doTap(ev); });
    enemyBtn.addEventListener('click', (ev) => { if (ev.detail === 0) doTap(null); }); // キーボード操作

    $('prevArea').addEventListener('click', () => game.goToArea(game.state.area - 1));
    $('nextArea').addEventListener('click', () => game.goToArea(game.state.area + 1));
    $('autoAdv').addEventListener('click', () => game.setAutoAdvance(!game.state.autoAdvance));

    for (const t of ['equip', 'party', 'soul', 'record']) {
      $('tab-' + t).addEventListener('click', () => selectTab(t));
    }
    $('buyAmount').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-amount]');
      if (!b) return;
      game.state.settings.buyAmount = b.dataset.amount === 'max' ? 'max' : Number(b.dataset.amount);
      renderBuyAmount();
      renderSlow();
    });
    document.querySelectorAll('[data-notation]').forEach((b) => {
      b.addEventListener('click', () => {
        game.state.settings.notation = b.dataset.notation;
        ladderReached = -2;
        renderSlow();
      });
    });

    $('prestigeBtn').addEventListener('click', () => {
      const gain = game.soulsOnPrestige();
      if (gain.lt(1)) return;
      openModal('転生しますか？', `
        <p>レベル・ゴールド・装備・仲間・到達エリアがリセットされ、エリア1からやり直しになる。</p>
        <p>かわりに魂を <b>+${fmt(gain)}</b> 得て、攻撃力と仲間DPSが <b>×${fmtMult(game.soulPassiveMult())} → ×${fmtMult(game.state.souls.add(gain).mul(Game.CONFIG.soulPassiveBonus).add(1))}</b> になる。</p>
        <p>神々の加護・記録・スキルの解放状況は引き継がれる。</p>`,
      [
        { label: 'やめる' },
        {
          label: '転生する',
          cls: 'primary',
          onClick: () => {
            if (game.prestige()) {
              banner('転生', `魂 +${fmt(gain)}`, 'soul');
              log(`<span class="s">勇者は 生まれ変わった！</span> 魂を ${fmt(gain)} 手に入れた`);
              buildParty();
              save();
              renderSlow();
            }
          },
        },
      ]);
    });

    $('saveBtn').addEventListener('click', () => {
      $('saveNote').textContent = save() ? `セーブした（${new Date().toLocaleTimeString()}）。` : 'このブラウザではセーブできなかった。「書き出す」で控えを取っておこう。';
    });

    $('exportBtn').addEventListener('click', () => {
      const code = encodeSave();
      openModal('セーブデータを書き出す', `
        <p>この文字列を控えておけば、別のブラウザでも続きから遊べる。</p>
        <textarea id="exportText" readonly>${escapeHtml(code)}</textarea>`,
      [
        {
          label: 'コピー',
          onClick: () => {
            const ta = $('exportText');
            const done = () => { $('modalTitle').textContent = 'コピーした'; };
            try {
              navigator.clipboard.writeText(code).then(done, () => { ta.select(); });
            } catch (e) {
              ta.select();
            }
            return false;
          },
        },
        { label: '閉じる', cls: 'primary' },
      ]);
    });

    $('importBtn').addEventListener('click', () => {
      openModal('セーブデータを読み込む', `
        <p>書き出した文字列を貼り付けてください。いまの進行状況は上書きされる。</p>
        <textarea id="importText" placeholder="ここに貼り付け"></textarea>
        <p id="importError" class="r" hidden>読み込めなかった。書き出した文字列をそのまま貼り付けてください。</p>`,
      [
        { label: 'やめる' },
        {
          label: '読み込む',
          cls: 'primary',
          onClick: () => {
            try {
              const data = decodeSave($('importText').value);
              startGame(data);
              save();
              log('セーブデータを読み込んだ');
              return true;
            } catch (e) {
              $('importError').hidden = false;
              return false;
            }
          },
        },
      ]);
    });

    $('resetBtn').addEventListener('click', () => {
      openModal('最初からやり直しますか？', '<p>魂や記録も含めて、すべてのデータが消える。この操作は取り消せない。</p>', [
        { label: 'やめる', cls: 'primary' },
        {
          label: 'すべて消して始める',
          cls: 'danger',
          onClick: () => {
            storageRemove(SAVE_KEY);
            startGame(null);
            log('新しい冒険が はじまった！');
          },
        },
      ]);
    });

    $('modal').addEventListener('click', (ev) => { if (ev.target === $('modal')) closeModal(); });

    document.addEventListener('keydown', (ev) => {
      if (!$('modal').hidden) {
        if (ev.key === 'Escape') closeModal();
        return;
      }
      if (ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement) return;
      if (ev.key === 'a' || ev.key === 'A') doTap(null);
      const n = Number(ev.key);
      if (n >= 1 && n <= D.SKILLS.length) game.useSkill(D.SKILLS[n - 1].id);
    });

    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    window.addEventListener('pagehide', save);
  }

  // ---------------------------------------------------------------------------
  // ループ
  // ---------------------------------------------------------------------------
  function frame(now) {
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 5) {
      // タブが裏にあった間は放置報酬として計算する
      showOffline(game.applyOffline(dt));
      dt = 0;
    }
    acc += Math.min(dt, 1);
    let steps = 0;
    while (acc >= STEP && steps < 40) {
      game.tick(STEP);
      acc -= STEP;
      steps++;
    }
    renderFast();
    slowTimer += dt;
    if (slowTimer >= 0.25) {
      slowTimer = 0;
      renderSlow();
    }
    flushBatched(now);
    autosaveTimer += dt;
    if (autosaveTimer >= AUTOSAVE_SEC) {
      autosaveTimer = 0;
      save();
    }
    requestAnimationFrame(frame);
  }

  function startGame(saved) {
    game = new Game(saved);
    game.on(onGameEvent);
    lastEnemyRef = null;
    lastHeroTitle = '';
    ladderReached = -1;
    buildParty();
    renderBuyAmount();
    renderSlow();
    renderFast();
    if (saved && saved.savedAt) {
      const away = (Date.now() - saved.savedAt) / 1000;
      showOffline(game.applyOffline(away));
    }
  }

  function boot(hotData) {
    const saved = (hotData && hotData.save) || loadSaved();
    buildEquip();
    buildSoul();
    buildSkills();
    bindControls();
    startGame(saved);
    const tab = storageGet(TAB_KEY);
    selectTab(['equip', 'party', 'soul', 'record'].includes(tab) ? tab : 'equip');
    if (!saved) {
      log('インフレクエストの世界へ ようこそ！');
      log('敵をタップして攻撃。ゴールドで装備を強化し、仲間を雇おう');
    } else {
      log('冒険を再開した');
    }
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }

  // 公開ページの更新時に進行状況を引き継ぐ
  const hot = window.claude && window.claude.hot;
  if (hot && typeof hot.snapshot === 'function') hot.snapshot(() => ({ save: game ? snapshot() : null }));
  if (hot && typeof hot.ready === 'function') hot.ready(boot);
  else boot((hot && hot.data) || {});
})();
