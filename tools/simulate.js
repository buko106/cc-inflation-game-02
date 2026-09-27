#!/usr/bin/env node
/*
 * バランス確認用のシミュレーター。貪欲に買い物をする Bot で数時間分プレイし、
 * 到達エリアや数値の大きさの推移を出力する。
 *
 *   node tools/simulate.js [時間(h)=3] [タップ/秒=4]
 */
const Game = require('../js/game.js');
const D = require('../js/data.js');
const BigNum = require('../js/bignum.js');

// 例: SIM_CONFIG='{"enemyHpGrowth":10}' SIM_EQUIP='{"weapon":{"costGrowth":1.3}}' node tools/simulate.js
Object.assign(Game.CONFIG, JSON.parse(process.env.SIM_CONFIG || '{}'));
const equipOverrides = JSON.parse(process.env.SIM_EQUIP || '{}');
for (const e of D.EQUIPMENT) Object.assign(e, equipOverrides[e.id] || {});
Object.assign(D, JSON.parse(process.env.SIM_DATA || '{}'));

const hours = Number(process.argv[2] || 3);
const tapsPerSec = Number(process.argv[3] || 4);
const DT = 0.1;

let seed = 12345;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const game = new Game(null, { random });
let lastProgressAt = 0;
let lastMaxArea = 1;
let farmSince = null;
let deathsWindow = [];

game.on((type) => {
  if (type === 'bossFail') farmSince = game.state.stats.playTime;
  if (type === 'death') {
    farmSince = game.state.stats.playTime;
    deathsWindow.push(game.state.stats.playTime);
  }
});

function effectiveDps(g) {
  const st = g.getStats();
  return st.heroDps.mul(1 + tapsPerSec * Game.CONFIG.tapRatio * st.attackInterval).add(st.partyDps.mul(1 + tapsPerSec * Game.CONFIG.tapPartyRatio));
}

// 攻撃系の買い物候補を DPS 上昇率/コスト で評価し、最も効率の良いものを返す
function bestDamagePurchase() {
  const s = game.state;
  const st = game.getStats();
  const base = effectiveDps(game);
  let best = null;
  const pick = (kind, id, cost, gain) => {
    if (s.gold.lt(cost)) return;
    const score = gain / Math.max(1e-300, cost.div(s.gold).toNumber());
    if (!best || score > best.score) best = { kind, id, score };
  };
  // 武器は実際に1レベル上げて比べる
  s.equip.weapon += 1;
  game.invalidate();
  const weaponGain = effectiveDps(game).div(base).toNumber() - 1;
  s.equip.weapon -= 1;
  game.invalidate();
  pick('equip', 'weapon', game.equipCost('weapon', 1).cost, weaponGain);
  // 仲間のDPSは「攻撃力 × 倍率の合計」なので、倍率の増分から直接計算する（仲間が多くても速い）
  const partyMult = st.baseAtk.mul(game.skillActive('rally') ? 20 : 1).mul(1 + tapsPerSec * Game.CONFIG.tapPartyRatio).div(base);
  for (let i = 0; i <= game.partyHiredCount(); i++) {
    if (!game.partyUnlocked(i)) continue;
    const n = game.partyLevel(i);
    const dRatio = game.partyMemberRatio(i, n + 1).sub(game.partyMemberRatio(i, n));
    pick('party', i, game.partyCost(i, 1).cost, partyMult.mul(dRatio).toNumber());
  }
  return best;
}

// 何にゴールドを使ったかをチェックポイントごとに集計する
let spent = { equip: BigNum.ZERO, party: BigNum.ZERO };
const rawBuyEquip = game.buyEquip.bind(game);
const rawBuyParty = game.buyParty.bind(game);
game.buyEquip = (id, amount) => {
  const { cost } = game.equipCost(id, amount);
  const ok = rawBuyEquip(id, amount);
  if (ok) spent.equip = spent.equip.add(cost);
  return ok;
};
game.buyParty = (idx, amount) => {
  const { cost } = game.partyCost(idx, amount);
  const ok = rawBuyParty(idx, amount);
  if (ok) spent.party = spent.party.add(cost);
  return ok;
};

function spendReport() {
  const total = spent.equip.add(spent.party);
  const share = total.isZero() ? 0 : spent.equip.div(total).toNumber() * 100;
  const st = game.getStats();
  const weapon = game.equipMult('weapon').log10();
  const party = st.partyRatio.isZero() ? 0 : st.partyRatio.log10();
  spent = { equip: BigNum.ZERO, party: BigNum.ZERO };
  return `装備への支出 ${share.toFixed(1)}% | 倍率の桁 武器 ${weapon.toFixed(0)} / 仲間 ${party.toFixed(0)}`;
}

function shop() {
  const s = game.state;
  // 生存のための防具: 被ダメージが最大HPの8%を超えるなら優先
  for (let guard = 0; guard < 200; guard++) {
    const st = game.getStats();
    const e = Game.enemyStats(s.area + 1, 5, true);
    const hit = e.atk.mul(e.atk).div(e.atk.add(st.def));
    if (hit.div(st.maxHp).toNumber() < 0.08) break;
    if (!game.buyEquip('armor', 1)) break;
  }
  for (let guard = 0; guard < 500; guard++) {
    const accCost = game.equipCost('accessory', 1).cost;
    if (accCost.lt(s.gold.mul(0.15))) { game.buyEquip('accessory', bulkLevels('accessory', 0.15)); continue; }
    const best = bestDamagePurchase();
    if (!best) break;
    const ok = best.kind === 'equip' ? game.buyEquip(best.id, bulkLevels(best.id, 0.25)) : game.buyParty(best.id, bulkLevels(best.id, 0.25));
    if (!ok) break;
  }
}

// 人間が「MAX」を押すのに近づけるため、所持金の一定割合で買えるだけまとめ買いする
function bulkLevels(id, share) {
  const budget = game.state.gold.mul(share);
  if (typeof id === 'number') {
    const def = Game.partyDef(id);
    return Math.max(1, Game.maxAffordable(def.baseCost, D.PARTY_COST_GROWTH, game.partyLevel(id), budget));
  }
  const def = D.EQUIPMENT.find((e) => e.id === id);
  return Math.max(1, Game.maxAffordable(def.baseCost, def.costGrowth, game.state.equip[id], budget));
}

function spendSouls() {
  const order = ['time', 'soul', 'power', 'wisdom', 'vitality', 'wealth'];
  for (let guard = 0; guard < 10000; guard++) {
    let cheapest = null;
    for (const id of order) {
      if (game.soulUpgradeMaxed(id)) continue;
      const c = game.soulUpgradeCost(id);
      if (!cheapest || c.lt(cheapest.c)) cheapest = { id, c };
    }
    // 魂の半分は受動ボーナス用に残す
    if (!cheapest || cheapest.c.gt(game.state.souls.mul(0.5))) break;
    game.buySoulUpgrade(cheapest.id);
  }
}

const checkpoints = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720].map((m) => m * 60).filter((t) => t <= hours * 3600);
const areaMilestones = [5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 2000];
const fmt = (b) => BigNum.format(b);
const log = (msg) => console.log(`[${(game.state.stats.playTime / 60).toFixed(1).padStart(6)}m] ${msg}`);

let tapBudget = 0;
let shopTimer = 0;
const totalTicks = Math.round((hours * 3600) / DT);
for (let i = 0; i < totalTicks; i++) {
  const t = game.state.stats.playTime;
  tapBudget += tapsPerSec * DT;
  while (tapBudget >= 1) { tapBudget -= 1; game.tap(); }
  game.tick(DT);

  for (const sk of D.SKILLS) if (game.skillUnlocked(sk.id)) game.useSkill(sk.id);

  shopTimer += DT;
  if (shopTimer >= 2) { shopTimer = 0; shop(); }

  const s = game.state;
  if (s.maxArea > lastMaxArea) {
    for (const m of areaMilestones) if (lastMaxArea < m && s.maxArea >= m && s.bestArea === s.maxArea) {
      const e = Game.enemyStats(m, 0, false);
      log(`best area ${m} reached (enemy HP ${fmt(e.hp)}, Lv ${fmt(game.level())}, prestiges ${s.stats.prestiges})`);
    }
    lastMaxArea = s.maxArea;
    lastProgressAt = t;
  }

  // 修行モードで 20 秒経ったら再挑戦
  if (!s.autoAdvance && farmSince !== null && t - farmSince > 20) {
    farmSince = null;
    game.setAutoAdvance(true);
  }

  // 3分進展がなく、魂が倍以上になるなら転生
  const gain = game.soulsOnPrestige();
  if (t - lastProgressAt > 180 && gain.gte(1) && gain.gte(s.souls)) {
    log(`PRESTIGE at area ${s.maxArea}: +${fmt(gain)} souls (had ${fmt(s.souls)}), deaths ${s.stats.deaths}`);
    game.prestige();
    spendSouls();
    lastMaxArea = 1;
    lastProgressAt = t;
  }

  if (checkpoints.length && t >= checkpoints[0]) {
    checkpoints.shift();
    const st = game.getStats();
    log(`CHECK area ${s.area}/${s.maxArea} best ${s.bestArea} | Lv ${fmt(st.level)} ATK ${fmt(st.atk)} party ${fmt(st.partyDps)} | gold ${fmt(s.gold)} souls ${fmt(s.souls)} | equip ${JSON.stringify(s.equip)} party ${s.party.length}人 | ${spendReport()}`);
  }
}
