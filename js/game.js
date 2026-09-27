/*
 * ゲームエンジン。DOM には依存せず、tick(dt) で時間を進めてイベントを発行する。
 * ブラウザでは window.Game、Node では require('./game.js') で使う。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./bignum.js'), require('./data.js'));
  else root.Game = factory(root.BigNum, root.GameData);
})(typeof self !== 'undefined' ? self : this, function (BigNum, D) {
  'use strict';

  const B = (x) => BigNum.from(x);

  const CONFIG = {
    enemiesPerArea: 10, // 最後の1体がボス
    enemyHpBase: 20,
    enemyHpGrowth: 10,
    enemyAtkBase: 4,
    enemyAtkGrowth: 4,
    expBase: 5,
    expGrowth: 4.5,
    goldBase: 3,
    goldGrowth: 6.5,
    bossHpMult: 8,
    bossAtkMult: 2,
    bossRewardMult: 8,
    bossTime: 30,
    heroAttackInterval: 1.0,
    enemyAttackInterval: 1.6,
    tapRatio: 0.5,
    tapPartyRatio: 0.02,
    critChance: 0.1,
    critMult: 5,
    expPerLevel: 10, // 累計経験値 = expPerLevel * (Lv - 1)^2
    heroAtkPerLevel: 10,
    heroHpPerLevel: 100,
    heroDefPerLevel: 5,
    killHealRatio: 0.25,
    regenPerSec: 0.02,
    spawnDelay: 0.35,
    maxChain: 100,
    prestigeMinArea: 20,
    soulBase: 5,
    soulGrowth: 1.12,
    soulPassiveBonus: 0.1,
    offlineCapSec: 12 * 3600,
  };

  const SAVE_VERSION = 1;

  // 貫通攻撃で連続撃破している間は個別に通知しないイベント
  const MUTABLE_EVENTS = new Set(['kill', 'levelUp', 'areaClear', 'spawn']);

  // ---------------------------------------------------------------------------
  // 等比数列のまとめ買い計算
  // ---------------------------------------------------------------------------
  // 現在レベル n から k レベル分買うコスト = base * g^n * (g^k - 1) / (g - 1)
  function bulkCost(base, growth, n, k) {
    if (k <= 0) return BigNum.ZERO;
    const first = B(growth).pow(n).mul(base);
    return first.mul(B(growth).pow(k).sub(1)).div(growth - 1).floor().max(1);
  }

  // gold で買える最大レベル数
  function maxAffordable(base, growth, n, gold) {
    const first = B(growth).pow(n).mul(base);
    if (gold.lt(first)) return 0;
    const ratio = gold.mul(growth - 1).div(first).add(1);
    let k = Math.floor(ratio.log10() / Math.log10(growth));
    // 浮動小数点誤差の補正
    while (k > 0 && bulkCost(base, growth, n, k).gt(gold)) k--;
    while (bulkCost(base, growth, n, k + 1).lte(gold)) k++;
    return k;
  }

  function resolveAmount(amount, base, growth, n, gold) {
    if (amount === 'max') return Math.max(1, maxAffordable(base, growth, n, gold));
    return amount;
  }

  // ---------------------------------------------------------------------------
  // 名前の生成
  // ---------------------------------------------------------------------------
  function loopPrefix(loop) {
    if (loop < D.LOOP_PREFIXES.length) return D.LOOP_PREFIXES[loop];
    return '無限' + (loop - D.LOOP_PREFIXES.length + 2) + '・';
  }

  function areaInfo(area) {
    const base = D.AREAS[(area - 1) % D.AREAS.length];
    const loop = Math.floor((area - 1) / D.AREAS.length);
    return { name: loopPrefix(loop) + base.name, hue: base.hue, base, prefix: loopPrefix(loop) };
  }

  // i 番目の仲間の定義。PARTY → PARTY_EXTRA → 接頭辞付きで両方を繰り返す、の順に無限に続く
  const partyDefCache = [];
  function partyDef(i) {
    if (partyDefCache[i]) return partyDefCache[i];
    let def;
    if (i < D.PARTY.length) {
      def = D.PARTY[i];
    } else {
      const names = D.PARTY.concat(D.PARTY_EXTRA);
      const loop = Math.floor(i / names.length);
      const base = names[i % names.length];
      const last = D.PARTY[D.PARTY.length - 1];
      const steps = i - (D.PARTY.length - 1);
      def = {
        id: 'p' + i,
        icon: base.icon,
        name: loopPrefix(loop) + base.name,
        // 数値は巨大になるので BigNum で持つ
        baseCost: B(D.PARTY_GEN_COST_STEP).pow(steps).mul(last.baseCost),
        ratio: B(D.PARTY_GEN_RATIO_STEP).pow(steps).mul(last.ratio),
      };
    }
    partyDefCache[i] = def;
    return def;
  }

  // i 番目の仲間に出会えるエリア
  function partyUnlockArea(i) {
    const list = D.PARTY_UNLOCK_AREAS;
    if (i < list.length) return list[i];
    return list[list.length - 1] + (i - (list.length - 1)) * D.PARTY_UNLOCK_EVERY;
  }

  function equipName(def, level) {
    const tier = Math.floor(level / D.EQUIP_EVOLVE_EVERY);
    const plus = level % D.EQUIP_EVOLVE_EVERY;
    const mats = D.EQUIP_MATERIALS;
    let name;
    if (tier < mats.length) name = mats[tier] + def.item;
    else name = mats[mats.length - 1] + def.item + '・改' + (tier - mats.length + 2);
    return plus > 0 ? name + ' +' + plus : name;
  }

  // ---------------------------------------------------------------------------
  // 状態
  // ---------------------------------------------------------------------------
  function defaultRun() {
    return {
      gold: BigNum.ZERO,
      totalExp: BigNum.ZERO,
      area: 1,
      maxArea: 1,
      kills: 0,
      autoAdvance: true,
      equip: Object.fromEntries(D.EQUIPMENT.map((e) => [e.id, 0])),
      party: [], // 雇った順（= 仲間の番号順）のレベル
      skills: Object.fromEntries(D.SKILLS.map((s) => [s.id, { active: 0, cooldown: 0 }])),
    };
  }

  function defaultState() {
    return Object.assign(defaultRun(), {
      version: SAVE_VERSION,
      souls: BigNum.ZERO,
      soulUpgrades: Object.fromEntries(D.SOUL_UPGRADES.map((u) => [u.id, 0])),
      bestArea: 1,
      stats: {
        kills: 0,
        bossKills: 0,
        deaths: 0,
        prestiges: 0,
        playTime: 0,
        maxDamage: BigNum.ZERO,
        totalGold: BigNum.ZERO,
        totalSouls: BigNum.ZERO,
      },
      settings: { notation: 'jp', buyAmount: 1 },
    });
  }

  class Game {
    constructor(saved, opts) {
      opts = opts || {};
      this.random = opts.random || Math.random;
      this.listeners = [];
      this.state = defaultState();
      if (saved) this.loadState(saved);
      this.enemy = null;
      this.spawnTimer = 0;
      this.heroTimer = 0;
      this.enemyTimer = 0;
      this.bossTimeLeft = 0;
      this.partyAccum = BigNum.ZERO;
      this.partyEmitTimer = 0;
      this.statsCache = null;
      this.heroHp = this.getStats().maxHp;
      this.spawnEnemy();
    }

    on(fn) { this.listeners.push(fn); }
    emit(type, data) {
      if (this.muted && MUTABLE_EVENTS.has(type)) return;
      for (const fn of this.listeners) fn(type, data || {});
    }
    invalidate() { this.statsCache = null; }

    // -------------------------------------------------------------------------
    // 派生ステータス
    // -------------------------------------------------------------------------
    level() {
      return this.state.totalExp.div(CONFIG.expPerLevel).sqrt().floor().add(1);
    }

    // 次のレベルまでの進捗 (0..1)
    levelProgress() {
      const L = this.level();
      const cur = L.sub(1).pow(2).mul(CONFIG.expPerLevel);
      const next = L.pow(2).mul(CONFIG.expPerLevel);
      const span = next.sub(cur);
      if (span.isZero()) return 0;
      const p = this.state.totalExp.sub(cur).div(span).toNumber();
      return Math.min(1, Math.max(0, p));
    }

    expToNext() {
      const next = this.level().pow(2).mul(CONFIG.expPerLevel);
      return next.sub(this.state.totalExp).max(0);
    }

    equipMult(id, level) {
      const def = D.EQUIPMENT.find((e) => e.id === id);
      const n = level === undefined ? this.state.equip[id] : level;
      return B(1 + def.perLevel * n).mul(B(def.milestoneMult).pow(Math.floor(n / D.EQUIP_EVOLVE_EVERY)));
    }

    partyLevel(idx) {
      return this.state.party[idx] || 0;
    }

    // 仲間1人の DPS 倍率（勇者の攻撃力に対する倍率）
    partyMemberRatio(idx, level) {
      const def = partyDef(idx);
      const n = level === undefined ? this.partyLevel(idx) : level;
      if (n <= 0) return BigNum.ZERO;
      return B(def.ratio).mul(n).mul(B(D.PARTY_MILESTONE_MULT).pow(Math.floor(n / D.PARTY_MILESTONE_EVERY)));
    }

    // 雇った仲間の人数（仲間は番号順にしか雇えないので、先頭から連続している）
    partyHiredCount() {
      let n = 0;
      while (this.partyLevel(n) > 0) n++;
      return n;
    }

    soulPassiveMult() {
      return this.state.souls.mul(CONFIG.soulPassiveBonus).add(1);
    }

    skillActive(id) { return this.state.skills[id].active > 0; }

    getStats() {
      if (this.statsCache) return this.statsCache;
      const s = this.state;
      const su = s.soulUpgrades;
      const L = this.level();
      const soul = this.soulPassiveMult();
      const power = B(2).pow(su.power);
      const vit = B(3).pow(su.vitality);
      const armor = this.equipMult('armor');
      const acc = this.equipMult('accessory');

      const baseAtk = L.mul(CONFIG.heroAtkPerLevel).mul(this.equipMult('weapon')).mul(soul).mul(power);
      const atk = this.skillActive('berserk') ? baseAtk.mul(10) : baseAtk;

      let partyRatio = BigNum.ZERO;
      for (let i = 0; i < s.party.length; i++) partyRatio = partyRatio.add(this.partyMemberRatio(i));
      let partyDps = baseAtk.mul(partyRatio);
      if (this.skillActive('rally')) partyDps = partyDps.mul(20);

      let goldMult = acc.mul(B(2).pow(su.wealth));
      if (this.skillActive('goldrush')) goldMult = goldMult.mul(10);

      const interval = CONFIG.heroAttackInterval / (this.skillActive('haste') ? 4 : 1);

      this.statsCache = {
        level: L,
        baseAtk,
        atk,
        partyRatio,
        maxHp: L.mul(CONFIG.heroHpPerLevel).mul(armor).mul(vit),
        def: L.mul(CONFIG.heroDefPerLevel).mul(armor).mul(vit),
        partyDps,
        goldMult,
        expMult: acc.mul(B(3).pow(su.wisdom)),
        attackInterval: interval,
        // 通常攻撃の期待DPS（会心込み）
        heroDps: atk.mul(1 + CONFIG.critChance * (CONFIG.critMult - 1)).div(interval),
        critChance: CONFIG.critChance,
        critMult: CONFIG.critMult,
      };
      return this.statsCache;
    }

    bossTimeLimit() {
      return CONFIG.bossTime + 5 * this.state.soulUpgrades.time;
    }

    // -------------------------------------------------------------------------
    // 敵
    // -------------------------------------------------------------------------
    static enemyStats(area, index, isBoss) {
      const a = area - 1;
      let hp = B(CONFIG.enemyHpGrowth).pow(a).mul(CONFIG.enemyHpBase * (1 + 0.1 * index));
      let atk = B(CONFIG.enemyAtkGrowth).pow(a).mul(CONFIG.enemyAtkBase);
      let exp = B(CONFIG.expGrowth).pow(a).mul(CONFIG.expBase);
      let gold = B(CONFIG.goldGrowth).pow(a).mul(CONFIG.goldBase * (1 + 0.1 * index));
      if (isBoss) {
        hp = hp.mul(CONFIG.bossHpMult);
        atk = atk.mul(CONFIG.bossAtkMult);
        exp = exp.mul(CONFIG.bossRewardMult);
        gold = gold.mul(CONFIG.bossRewardMult);
      }
      return { hp, atk, exp, gold };
    }

    spawnEnemy() {
      const s = this.state;
      const isBoss = s.autoAdvance && s.kills >= CONFIG.enemiesPerArea - 1;
      const info = areaInfo(s.area);
      const idx = Math.min(s.kills, CONFIG.enemiesPerArea - 2);
      const st = Game.enemyStats(s.area, idx, isBoss);
      const pick = isBoss ? info.base.boss : info.base.enemies[Math.floor(this.random() * info.base.enemies.length)];
      this.enemy = {
        emoji: pick[0],
        name: info.prefix + pick[1],
        isBoss,
        hp: st.hp,
        maxHp: st.hp,
        atk: st.atk,
        exp: st.exp,
        gold: st.gold,
      };
      this.enemyTimer = 0;
      if (isBoss) this.bossTimeLeft = this.bossTimeLimit();
      this.emit('spawn', { enemy: this.enemy });
    }

    // -------------------------------------------------------------------------
    // 時間経過
    // -------------------------------------------------------------------------
    tick(dt) {
      const s = this.state;
      s.stats.playTime += dt;

      for (const def of D.SKILLS) {
        const sk = s.skills[def.id];
        if (sk.active > 0) {
          sk.active -= dt;
          if (sk.active <= 0) {
            sk.active = 0;
            this.invalidate();
            this.emit('skillEnd', { skill: def });
          }
        }
        if (sk.cooldown > 0) sk.cooldown = Math.max(0, sk.cooldown - dt);
      }

      let st = this.getStats();
      this.heroHp = this.heroHp.add(st.maxHp.mul(CONFIG.regenPerSec * dt)).min(st.maxHp);

      this.partyEmitTimer += dt;
      if (this.partyEmitTimer >= 1) {
        this.partyEmitTimer = 0;
        if (!this.partyAccum.isZero()) this.emit('partyHit', { amount: this.partyAccum });
        this.partyAccum = BigNum.ZERO;
      }

      if (!this.enemy) {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0) this.spawnEnemy();
        return;
      }

      if (this.enemy.isBoss) {
        this.bossTimeLeft -= dt;
        if (this.bossTimeLeft <= 0) {
          this.failBoss('timeout');
          return;
        }
      }

      if (!st.partyDps.isZero()) {
        const dmg = st.partyDps.mul(dt);
        this.partyAccum = this.partyAccum.add(dmg);
        if (this.damageEnemy(dmg, 'party', false)) return;
      }

      this.heroTimer += dt;
      while (this.heroTimer >= st.attackInterval) {
        this.heroTimer -= st.attackInterval;
        if (this.heroAttack(1, 'auto')) return;
      }

      this.enemyTimer += dt;
      if (this.enemyTimer >= CONFIG.enemyAttackInterval) {
        this.enemyTimer -= CONFIG.enemyAttackInterval;
        this.enemyAttack();
      }
    }

    // 戻り値: 敵を倒したら true
    heroAttack(ratio, source) {
      const st = this.getStats();
      const crit = this.random() < st.critChance;
      let dmg = st.atk.mul(ratio);
      if (crit) dmg = dmg.mul(st.critMult);
      return this.damageEnemy(dmg, source, crit);
    }

    // タップ攻撃: 攻撃力の tapRatio 倍 + 仲間DPSの tapPartyRatio 倍
    tap() {
      if (!this.enemy) return false;
      const st = this.getStats();
      const crit = this.random() < st.critChance;
      let dmg = st.atk.mul(CONFIG.tapRatio).add(st.partyDps.mul(CONFIG.tapPartyRatio));
      if (crit) dmg = dmg.mul(st.critMult);
      return this.damageEnemy(dmg, 'tap', crit);
    }

    // 戻り値: 敵を倒したら true。
    // 倒してもダメージが余れば次の敵へ貫通する（最大 maxChain 体）。
    damageEnemy(amount, source, crit) {
      if (!this.enemy) return false;
      const s = this.state;
      if (source !== 'party' && amount.gt(s.stats.maxDamage)) s.stats.maxDamage = amount;
      if (source !== 'party') this.emit('hit', { amount, source, crit });
      let left = amount;
      let kills = 0;
      let chain = null;
      while (this.enemy) {
        const e = this.enemy;
        if (left.lt(e.hp)) {
          e.hp = e.hp.sub(left);
          break;
        }
        left = left.sub(e.hp);
        e.hp = BigNum.ZERO;
        const r = this.killEnemy();
        kills++;
        if (kills === 1) {
          // 2体目以降はまとめて 'chain' イベントで通知する
          this.muted = true;
          chain = { kills: 0, gold: BigNum.ZERO, exp: BigNum.ZERO, areas: 0, levelFrom: this.level(), areaFrom: s.area };
        } else {
          chain.kills++;
          chain.gold = chain.gold.add(r.gold);
          chain.exp = chain.exp.add(r.exp);
          if (r.boss) chain.areas++;
        }
        if (left.lte(0) || kills >= CONFIG.maxChain) break;
        this.spawnEnemy();
      }
      this.muted = false;
      if (chain && chain.kills > 0) {
        chain.levelTo = this.level();
        chain.areaTo = s.area;
        this.emit('chain', chain);
        if (chain.levelTo.gt(chain.levelFrom)) this.emit('levelUp', { from: chain.levelFrom, to: chain.levelTo });
        if (this.enemy) this.emit('spawn', { enemy: this.enemy });
      }
      return kills > 0;
    }

    enemyAttack() {
      const e = this.enemy;
      const st = this.getStats();
      // 防御力が高いほど被ダメージが急激に減る
      const dmg = e.atk.mul(e.atk).div(e.atk.add(st.def));
      this.heroHp = this.heroHp.sub(dmg);
      this.emit('heroHit', { amount: dmg });
      if (this.heroHp.lte(0)) this.heroDeath();
    }

    heroDeath() {
      const s = this.state;
      s.stats.deaths++;
      this.heroHp = this.getStats().maxHp;
      if (this.enemy && this.enemy.isBoss) {
        this.failBoss('death');
        return;
      }
      // 通常の敵に負けたら1つ前のエリアへ撤退して修行モードに
      const from = s.area;
      if (s.area > 1) s.area -= 1;
      s.kills = 0;
      s.autoAdvance = false;
      this.enemy = null;
      this.spawnTimer = CONFIG.spawnDelay * 2;
      this.emit('death', { from, to: s.area });
    }

    failBoss(reason) {
      const s = this.state;
      s.autoAdvance = false;
      if (reason === 'death') this.heroHp = this.getStats().maxHp;
      const boss = this.enemy;
      this.enemy = null;
      this.spawnTimer = CONFIG.spawnDelay * 2;
      this.emit('bossFail', { reason, boss });
    }

    killEnemy() {
      const s = this.state;
      const e = this.enemy;
      const st = this.getStats();
      const gold = e.gold.mul(st.goldMult);
      const exp = e.exp.mul(st.expMult);
      s.gold = s.gold.add(gold);
      s.stats.totalGold = s.stats.totalGold.add(gold);
      s.stats.kills++;
      this.enemy = null;
      this.spawnTimer = CONFIG.spawnDelay;
      this.heroTimer = 0;
      this.emit('kill', { enemy: e, gold, exp });
      this.gainExp(exp);
      const maxHp = this.getStats().maxHp;
      this.heroHp = this.heroHp.add(maxHp.mul(CONFIG.killHealRatio)).min(maxHp);

      if (e.isBoss) {
        s.stats.bossKills++;
        const cleared = s.area;
        if (s.area >= s.maxArea) s.maxArea = s.area + 1;
        if (s.maxArea > s.bestArea) s.bestArea = s.maxArea;
        s.kills = 0;
        if (s.autoAdvance) s.area += 1;
        this.heroHp = maxHp;
        this.emit('areaClear', { cleared, area: s.area });
      } else {
        s.kills = Math.min(s.kills + 1, CONFIG.enemiesPerArea - 1);
      }
      return { gold, exp, boss: e.isBoss };
    }

    gainExp(exp) {
      const before = this.level();
      this.state.totalExp = this.state.totalExp.add(exp);
      const after = this.level();
      if (after.gt(before)) {
        this.invalidate();
        this.heroHp = this.getStats().maxHp;
        this.emit('levelUp', { from: before, to: after });
      }
    }

    // -------------------------------------------------------------------------
    // プレイヤー操作
    // -------------------------------------------------------------------------
    setAutoAdvance(on) {
      const s = this.state;
      if (s.autoAdvance === on) return;
      s.autoAdvance = on;
      const wantBoss = on && s.kills >= CONFIG.enemiesPerArea - 1;
      // ボス挑戦/中断をすぐ反映する
      if (this.enemy && this.enemy.isBoss !== wantBoss) {
        this.enemy = null;
        this.spawnTimer = CONFIG.spawnDelay;
      }
      this.emit('autoAdvance', { on });
    }

    goToArea(area) {
      const s = this.state;
      area = Math.max(1, Math.min(s.maxArea, Math.floor(area)));
      if (area === s.area) return;
      const from = s.area;
      s.area = area;
      s.kills = 0;
      // 前のエリアに戻ったら、すぐ先へ進んでしまわないように修行モードにする
      const training = area < from && s.autoAdvance;
      if (training) s.autoAdvance = false;
      this.enemy = null;
      this.spawnTimer = CONFIG.spawnDelay;
      this.emit('areaChange', { area, from, training });
    }

    equipCost(id, amount) {
      const def = D.EQUIPMENT.find((e) => e.id === id);
      const n = this.state.equip[id];
      const k = resolveAmount(amount, def.baseCost, def.costGrowth, n, this.state.gold);
      return { levels: k, cost: bulkCost(def.baseCost, def.costGrowth, n, k) };
    }

    buyEquip(id, amount) {
      const { levels, cost } = this.equipCost(id, amount);
      if (this.state.gold.lt(cost)) return false;
      const before = this.getStats().maxHp;
      this.state.gold = this.state.gold.sub(cost);
      this.state.equip[id] += levels;
      this.invalidate();
      this.keepHpRatio(before);
      this.emit('purchase', { kind: 'equip', id, levels });
      return true;
    }

    // スカウトできるのは、ひとつ前の仲間を雇っていて、今回の冒険でその仲間のエリアに到達しているとき。
    // すでに雇っている仲間はいつでも強化できる
    partyUnlocked(idx) {
      if (this.partyLevel(idx) > 0) return true;
      if (idx > 0 && this.partyLevel(idx - 1) === 0) return false;
      return this.state.maxArea >= partyUnlockArea(idx);
    }

    // 今回の冒険で出会えている仲間の人数
    partyMetCount() {
      let n = 0;
      while (partyUnlockArea(n) <= this.state.maxArea) n++;
      return n;
    }

    partyCost(idx, amount) {
      const def = partyDef(idx);
      const n = this.partyLevel(idx);
      const k = resolveAmount(amount, def.baseCost, D.PARTY_COST_GROWTH, n, this.state.gold);
      return { levels: k, cost: bulkCost(def.baseCost, D.PARTY_COST_GROWTH, n, k) };
    }

    buyParty(idx, amount) {
      if (!this.partyUnlocked(idx)) return false;
      const { levels, cost } = this.partyCost(idx, amount);
      if (this.state.gold.lt(cost)) return false;
      this.state.gold = this.state.gold.sub(cost);
      while (this.state.party.length <= idx) this.state.party.push(0);
      this.state.party[idx] += levels;
      this.invalidate();
      this.emit('purchase', { kind: 'party', idx, levels });
      return true;
    }

    // 最大HPが増えたとき、現在HPも同じ割合で増やす
    keepHpRatio(prevMax) {
      const max = this.getStats().maxHp;
      if (prevMax.isZero()) return;
      this.heroHp = this.heroHp.mul(max).div(prevMax).min(max);
    }

    skillUnlocked(id) {
      const def = D.SKILLS.find((s) => s.id === id);
      return this.state.bestArea >= def.unlockArea;
    }

    useSkill(id) {
      const def = D.SKILLS.find((s) => s.id === id);
      const sk = this.state.skills[id];
      if (!this.skillUnlocked(id) || sk.cooldown > 0) return false;
      sk.cooldown = def.cooldown;
      sk.active = def.duration;
      this.invalidate();
      this.emit('skill', { skill: def });
      if (id === 'meteor' && this.enemy) {
        const ratio = this.enemy.isBoss ? 0.1 : 0.5;
        this.damageEnemy(this.enemy.maxHp.mul(ratio), 'meteor', false);
      }
      return true;
    }

    soulUpgradeCost(id) {
      const def = D.SOUL_UPGRADES.find((u) => u.id === id);
      return B(def.costGrowth).pow(this.state.soulUpgrades[id]).mul(def.baseCost).floor();
    }

    soulUpgradeMaxed(id) {
      const def = D.SOUL_UPGRADES.find((u) => u.id === id);
      return def.max !== undefined && this.state.soulUpgrades[id] >= def.max;
    }

    buySoulUpgrade(id) {
      if (this.soulUpgradeMaxed(id)) return false;
      const cost = this.soulUpgradeCost(id);
      if (this.state.souls.lt(cost)) return false;
      this.state.souls = this.state.souls.sub(cost);
      this.state.soulUpgrades[id] += 1;
      this.invalidate();
      this.emit('purchase', { kind: 'soul', id });
      return true;
    }

    soulsOnPrestige(maxArea) {
      const a = maxArea === undefined ? this.state.maxArea : maxArea;
      if (a < CONFIG.prestigeMinArea) return BigNum.ZERO;
      return B(CONFIG.soulGrowth).pow(a - CONFIG.prestigeMinArea)
        .mul(CONFIG.soulBase)
        .mul(B(1.5).pow(this.state.soulUpgrades.soul))
        .floor();
    }

    prestige() {
      const gain = this.soulsOnPrestige();
      if (gain.lt(1)) return false;
      const s = this.state;
      s.souls = s.souls.add(gain);
      s.stats.totalSouls = s.stats.totalSouls.add(gain);
      s.stats.prestiges++;
      Object.assign(s, defaultRun());
      this.invalidate();
      this.heroHp = this.getStats().maxHp;
      this.enemy = null;
      this.spawnTimer = CONFIG.spawnDelay;
      this.emit('prestige', { gain });
      return true;
    }

    // 放置中の獲得量を、現在のエリアで通常の敵を狩り続けたとみなして計算する
    applyOffline(seconds) {
      seconds = Math.min(seconds, CONFIG.offlineCapSec);
      if (!(seconds > 10)) return null;
      const s = this.state;
      const st = this.getStats();
      const dps = st.heroDps.add(st.partyDps);
      const enemy = Game.enemyStats(s.area, 4, false);
      const killTime = Math.max(0.5, enemy.hp.div(dps).toNumber() + CONFIG.spawnDelay);
      const kills = Math.floor(seconds / killTime);
      if (kills <= 0) return null;
      const gold = enemy.gold.mul(st.goldMult).mul(kills);
      const exp = enemy.exp.mul(st.expMult).mul(kills);
      s.gold = s.gold.add(gold);
      s.stats.totalGold = s.stats.totalGold.add(gold);
      s.stats.kills += kills;
      const before = this.level();
      this.state.totalExp = this.state.totalExp.add(exp);
      this.invalidate();
      this.heroHp = this.getStats().maxHp;
      return { seconds, kills, gold, exp, levelFrom: before, levelTo: this.level() };
    }

    // -------------------------------------------------------------------------
    // セーブ / ロード
    // -------------------------------------------------------------------------
    serialize() {
      return JSON.parse(JSON.stringify(this.state));
    }

    loadState(data) {
      const def = defaultState();
      const s = def;
      const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
      s.gold = B(data.gold || 0);
      s.totalExp = B(data.totalExp || 0);
      s.souls = B(data.souls || 0);
      s.area = Math.max(1, num(data.area, 1));
      s.maxArea = Math.max(s.area, num(data.maxArea, 1));
      s.bestArea = Math.max(s.maxArea, num(data.bestArea, 1));
      s.kills = Math.min(CONFIG.enemiesPerArea - 1, Math.max(0, num(data.kills, 0)));
      s.autoAdvance = data.autoAdvance !== false;
      for (const e of D.EQUIPMENT) s.equip[e.id] = num(data.equip && data.equip[e.id], 0);
      // 旧バージョンのセーブは未加入の仲間を 0 で持っているので、末尾の 0 は落とす
      if (Array.isArray(data.party)) s.party = data.party.map((v) => Math.max(0, Math.floor(num(v, 0))));
      while (s.party.length && s.party[s.party.length - 1] === 0) s.party.pop();
      for (const sk of D.SKILLS) {
        const v = data.skills && data.skills[sk.id];
        if (v) s.skills[sk.id] = { active: num(v.active, 0), cooldown: num(v.cooldown, 0) };
      }
      for (const u of D.SOUL_UPGRADES) s.soulUpgrades[u.id] = num(data.soulUpgrades && data.soulUpgrades[u.id], 0);
      const st = data.stats || {};
      for (const k of ['kills', 'bossKills', 'deaths', 'prestiges', 'playTime']) s.stats[k] = num(st[k], 0);
      for (const k of ['maxDamage', 'totalGold', 'totalSouls']) s.stats[k] = B(st[k] || 0);
      if (data.settings) {
        if (data.settings.notation === 'sci') s.settings.notation = 'sci';
        if ([1, 10, 100, 'max'].includes(data.settings.buyAmount)) s.settings.buyAmount = data.settings.buyAmount;
      }
      this.state = s;
      this.invalidate();
    }
  }

  Game.CONFIG = CONFIG;
  Game.areaInfo = areaInfo;
  Game.equipName = equipName;
  Game.partyDef = partyDef;
  Game.partyUnlockArea = partyUnlockArea;
  Game.bulkCost = bulkCost;
  Game.maxAffordable = maxAffordable;
  return Game;
});
