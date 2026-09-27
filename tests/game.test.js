const test = require('node:test');
const assert = require('node:assert/strict');
const Game = require('../js/game.js');
const D = require('../js/data.js');
const BigNum = require('../js/bignum.js');

// 会心が出ない固定の乱数
const noCrit = () => 0.99;

function run(game, seconds, dt = 0.05) {
  for (let t = 0; t < seconds; t += dt) game.tick(dt);
}

test('a fresh game spawns an enemy and auto-battle defeats it', () => {
  const g = new Game(null, { random: noCrit });
  assert.ok(g.enemy);
  assert.equal(g.state.area, 1);
  run(g, 30);
  assert.ok(g.state.stats.kills > 0);
  assert.ok(g.state.gold.gt(0));
  assert.ok(g.level().gte(2));
});

test('clearing the boss advances to the next area', () => {
  const g = new Game(null, { random: noCrit });
  const events = [];
  g.on((type) => events.push(type));
  run(g, 60);
  assert.ok(events.includes('areaClear'));
  assert.ok(g.state.maxArea >= 2);
});

test('bulk cost equals the sum of single purchases', () => {
  const def = D.EQUIPMENT[0];
  let sum = BigNum.ZERO;
  for (let i = 0; i < 10; i++) sum = sum.add(Game.bulkCost(def.baseCost, def.costGrowth, 5 + i, 1));
  const bulk = Game.bulkCost(def.baseCost, def.costGrowth, 5, 10);
  assert.ok(Math.abs(bulk.div(sum).toNumber() - 1) < 0.01);
});

test('maxAffordable never exceeds the available gold', () => {
  for (const gold of ['1e3', '1e50', '3.3e400']) {
    const g = BigNum.from(gold);
    const k = Game.maxAffordable(10, 1.37, 7, g);
    assert.ok(Game.bulkCost(10, 1.37, 7, k).lte(g));
    assert.ok(Game.bulkCost(10, 1.37, 7, k + 1).gt(g));
  }
});

test('buying equipment spends gold and raises attack', () => {
  const g = new Game(null, { random: noCrit });
  g.state.gold = BigNum.from(1e6);
  const atkBefore = g.getStats().atk;
  assert.ok(g.buyEquip('weapon', 'max'));
  assert.ok(g.state.equip.weapon > 1);
  assert.ok(g.state.gold.lt(1e6));
  assert.ok(g.getStats().atk.gt(atkBefore));
  g.state.gold = BigNum.ZERO;
  assert.equal(g.buyEquip('weapon', 1), false);
});

test('party members unlock in order and add DPS', () => {
  const g = new Game(null, { random: noCrit });
  g.state.gold = BigNum.from(1e9);
  assert.equal(g.buyParty(1, 1), false, 'second member is locked until the first joins');
  assert.ok(g.buyParty(0, 1));
  g.state.maxArea = Game.partyUnlockArea(1);
  assert.ok(g.buyParty(1, 1));
  assert.ok(g.getStats().partyDps.gt(0));
});

test('overkill damage pierces through several enemies at once', () => {
  const g = new Game(null, { random: noCrit });
  let chain = null;
  g.on((type, d) => { if (type === 'chain') chain = d; });
  g.damageEnemy(BigNum.from('1e30'), 'tap', false);
  assert.ok(chain, 'chain event emitted');
  assert.ok(chain.kills >= 50);
  assert.ok(g.state.area > 1);
});

test('failing the boss timer switches to training mode', () => {
  const g = new Game(null, { random: noCrit });
  g.state.kills = Game.CONFIG.enemiesPerArea - 1;
  g.state.area = 5;
  g.state.maxArea = 5;
  // 倒されないが、ボスを時間内に倒せるほどは強くない勇者
  g.state.soulUpgrades.vitality = 40;
  g.invalidate();
  g.heroHp = g.getStats().maxHp;
  g.enemy = null;
  g.spawnEnemy();
  assert.ok(g.enemy.isBoss);
  let failed = false;
  g.on((type) => { if (type === 'bossFail') failed = true; });
  run(g, Game.CONFIG.bossTime + 1);
  assert.ok(failed);
  assert.equal(g.state.autoAdvance, false);
  g.setAutoAdvance(true);
  run(g, 1);
  assert.ok(g.enemy && g.enemy.isBoss, 'boss is challenged again right away');
});

test('prestige grants souls, resets the run and keeps permanent progress', () => {
  const g = new Game(null, { random: noCrit });
  assert.equal(g.prestige(), false, 'cannot prestige before the minimum area');
  g.state.maxArea = 40;
  g.state.area = 40;
  g.state.gold = BigNum.from('1e40');
  g.state.equip.weapon = 200;
  g.state.soulUpgrades.power = 3;
  const expected = g.soulsOnPrestige();
  assert.ok(expected.gte(1));
  assert.ok(g.prestige());
  assert.ok(g.state.souls.eq(expected));
  assert.equal(g.state.area, 1);
  assert.equal(g.state.equip.weapon, 0);
  assert.ok(g.state.gold.isZero());
  assert.equal(g.state.soulUpgrades.power, 3);
  assert.equal(g.state.stats.prestiges, 1);
  assert.ok(g.soulPassiveMult().gt(1));
});

test('save data survives a JSON round trip', () => {
  const g = new Game(null, { random: noCrit });
  g.state.gold = BigNum.from('4.2e777');
  g.state.maxArea = 12;
  g.state.area = 7;
  g.state.party[0] = 33;
  g.state.settings.notation = 'sci';
  run(g, 5);
  const json = JSON.parse(JSON.stringify(g.serialize()));
  const h = new Game(json, { random: noCrit });
  assert.ok(h.state.gold.gte(g.state.gold.mul(0.999)));
  assert.equal(h.state.area, g.state.area);
  assert.equal(h.state.party[0], 33);
  assert.equal(h.state.settings.notation, 'sci');
  assert.ok(h.state.totalExp.eq(g.state.totalExp));
});

test('broken save data falls back to safe defaults', () => {
  const g = new Game({ gold: 'nonsense', area: -5, equip: { weapon: 'x' }, party: null }, { random: noCrit });
  assert.equal(g.state.area, 1);
  assert.equal(g.state.equip.weapon, 0);
  assert.ok(g.state.gold.isZero());
  run(g, 2);
});

test('offline progress rewards gold and experience', () => {
  const g = new Game(null, { random: noCrit });
  assert.equal(g.applyOffline(5), null, 'short absences give nothing');
  const r = g.applyOffline(3600);
  assert.ok(r.kills > 0);
  assert.ok(g.state.gold.gt(0));
  assert.ok(r.levelTo.gt(r.levelFrom));
});

test('names keep evolving past the end of the material list', () => {
  const weapon = D.EQUIPMENT[0];
  assert.equal(Game.equipName(weapon, 0), '木の剣');
  assert.equal(Game.equipName(weapon, 13), '銅の剣 +3');
  assert.match(Game.equipName(weapon, 10 * (D.EQUIP_MATERIALS.length + 4)), /・改\d+$/);
  assert.equal(Game.areaInfo(1).name, 'はじまりの草原');
  assert.equal(Game.areaInfo(D.AREAS.length + 1).name, '真・はじまりの草原');
  assert.match(Game.areaInfo(D.AREAS.length * 20 + 1).name, /^無限\d+・/);
});

test('party members continue past the hand-made list and keep getting stronger', () => {
  const named = D.PARTY.length + D.PARTY_EXTRA.length;
  assert.equal(Game.partyDef(0).name, '村人A');
  assert.equal(Game.partyDef(D.PARTY.length).name, D.PARTY_EXTRA[0].name);
  assert.equal(Game.partyDef(named).name, '真・村人A');
  assert.match(Game.partyDef(named * 10 + 3).name, /^無限\d+・/);
  for (let i = 1; i < named * 3; i++) {
    const prev = Game.partyDef(i - 1);
    const cur = Game.partyDef(i);
    assert.ok(BigNum.from(cur.baseCost).gt(prev.baseCost), `cost grows at ${i}`);
    assert.ok(BigNum.from(cur.ratio).gt(prev.ratio), `ratio grows at ${i}`);
  }
});

test('a rich hero can hire far beyond the first twelve members', () => {
  const g = new Game(null, { random: noCrit });
  g.state.gold = BigNum.from('1e600');
  g.state.maxArea = Game.partyUnlockArea(101);
  for (let i = 0; i < 100; i++) assert.ok(g.buyParty(i, 1), `hire member ${i}`);
  assert.equal(g.partyHiredCount(), 100);
  assert.equal(g.buyParty(101, 1), false, 'cannot skip a member');
  g.setFormation(Game.partyDef(99).attr);
  const before = g.getStats().partyDps;
  assert.ok(g.buyParty(99, 10));
  assert.ok(g.getStats().partyDps.gt(before));
  run(g, 1);
});

test('old saves with a fixed-size party array still load', () => {
  const old = { totalExp: 0, maxArea: 12, area: 12, party: [40, 25, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
  const g = new Game(old, { random: noCrit });
  assert.deepEqual(g.state.party, [40, 25, 3]);
  assert.equal(g.partyHiredCount(), 3);
  assert.ok(g.partyUnlocked(3));
  assert.equal(g.partyUnlocked(4), false);
});

test('new members can only be scouted after reaching their area', () => {
  const g = new Game(null, { random: noCrit });
  g.state.gold = BigNum.from('1e30');
  for (let i = 1; i < 40; i++) assert.ok(Game.partyUnlockArea(i) > Game.partyUnlockArea(i - 1));
  assert.equal(g.partyMetCount(), 1);
  assert.ok(g.buyParty(0, 1));
  assert.equal(g.buyParty(1, 1), false, 'area too low');
  g.state.maxArea = Game.partyUnlockArea(1);
  assert.equal(g.partyMetCount(), 2);
  assert.ok(g.buyParty(1, 1));
  assert.equal(g.buyParty(2, 1), false);
  g.state.maxArea = Game.partyUnlockArea(2) - 1;
  assert.equal(g.buyParty(2, 1), false);
  g.state.maxArea = Game.partyUnlockArea(2);
  assert.ok(g.buyParty(2, 1));
});

test('members hired before the area limit existed can still be upgraded', () => {
  const g = new Game({ totalExp: 0, gold: '1e40', party: [5, 5, 5, 5, 5] }, { random: noCrit });
  assert.equal(g.state.maxArea, 1);
  assert.ok(g.buyParty(4, 1));
  assert.equal(g.buyParty(5, 1), false, 'but no new scouting until the area is reached');
});

test('going back to an earlier area switches to training mode', () => {
  const g = new Game(null, { random: noCrit });
  g.state.maxArea = 10;
  g.state.area = 10;
  assert.equal(g.state.autoAdvance, true);
  let change = null;
  g.on((type, d) => { if (type === 'areaChange') change = d; });
  g.goToArea(8);
  assert.equal(g.state.area, 8);
  assert.equal(g.state.autoAdvance, false);
  assert.equal(change.training, true);
  // 修行中はボスが出ず、エリア8に留まる
  g.state.soulUpgrades.power = 60;
  g.invalidate();
  run(g, 20);
  assert.equal(g.state.area, 8);
  assert.ok(!(g.enemy && g.enemy.isBoss));
  // 先へ進むときは自動進行の設定を変えない
  g.setAutoAdvance(true);
  g.goToArea(9);
  assert.equal(g.state.autoAdvance, true);
  assert.equal(change.training, false);
});

test('area data uses known attributes and never resists the only attribute a new player has', () => {
  const attrs = new Set(D.ATTRS.map((a) => a.id));
  D.AREAS.forEach((a, i) => {
    for (const k of ['weak', 'resist']) if (a[k]) assert.ok(attrs.has(a[k]), `${a.name} ${k}`);
    if (a.special) assert.ok(D.AREA_SPECIALS[a.special], `${a.name} special`);
    assert.notEqual(a.weak || null, a.resist || 'none', `${a.name} is weak and resistant to the same attribute`);
    // 物理以外の仲間（魔法使い）に出会う前のエリアで、物理に耐性を持たせない
    if (a.resist === 'phys') assert.ok(i + 1 >= Game.partyUnlockArea(2), `${a.name} resists phys too early`);
  });
  for (let i = 0; i < 60; i++) assert.ok(attrs.has(Game.partyDef(i).attr), `member ${i} has an attribute`);
  const named = D.PARTY.length + D.PARTY_EXTRA.length;
  assert.equal(Game.partyDef(named).attr, D.PARTY[0].attr, 'generated members keep the attribute of their base name');
});

test('only members of the formation fight, and area weakness and resistance scale their damage', () => {
  const g = new Game(null, { random: noCrit });
  g.state.gold = BigNum.from('1e30');
  g.state.maxArea = 20;
  for (let i = 0; i < 4; i++) assert.ok(g.buyParty(i, 10));
  const by = g.partyRatioByAttr();
  const dps = (area, attr) => {
    g.state.area = area;
    g.setFormation(attr);
    g.invalidate();
    return g.getStats().partyDps.div(g.getStats().baseAtk);
  };
  const near = (a, b) => Math.abs(a.div(b).toNumber() - 1) < 1e-9;
  assert.equal(g.state.formation, 'phys');
  // エリア2（ささやきの森）は魔法が弱点、物理は等倍
  assert.ok(near(dps(2, 'phys'), by.phys));
  assert.ok(near(dps(2, 'magic'), by.magic.mul(10)));
  // エリア3（ゴブリンの洞窟）は物理が弱点、魔法に耐性
  assert.ok(near(dps(3, 'phys'), by.phys.mul(10)));
  assert.ok(near(dps(3, 'magic'), by.magic.div(10)));
  assert.ok(near(dps(3, 'holy'), by.holy));
  // 先のエリアほど相性の差が大きい
  assert.equal(Game.traitPower(1), Game.CONFIG.traitMinPower);
  assert.ok(Game.traitPower(1000) > Game.traitPower(100));
  const farWeak = D.AREAS.length * 30 + 3; // ゴブリンの洞窟が30周した先
  assert.ok(Game.attrMult(farWeak, 'phys').eq(BigNum.fromLog10(Game.traitPower(farWeak))));
  assert.ok(Game.attrMult(farWeak, 'magic').mul(Game.attrMult(farWeak, 'phys')).sub(1).abs().lt(1e-9));
  assert.equal(g.setFormation('nope'), false);
});

test('changing areas updates party damage right away', () => {
  const g = new Game(null, { random: noCrit });
  g.state.gold = BigNum.from('1e10');
  g.state.maxArea = 3;
  assert.ok(g.buyParty(0, 10));
  g.state.area = 2;
  g.invalidate();
  const neutral = g.getStats().partyDps;
  g.goToArea(3); // 物理が弱点
  assert.ok(g.getStats().partyDps.gt(neutral.mul(9)));
});

test('brute areas hit harder and regen areas heal their enemies', () => {
  const area = (special) => D.AREAS.findIndex((a) => a.special === special) + 1;
  const brute = area('brute');
  // 特性がなかった場合の攻撃力と比べる
  const plainAtk = BigNum.from(Game.CONFIG.enemyAtkGrowth).pow(brute - 1).mul(Game.CONFIG.enemyAtkBase);
  const ratio = Game.enemyStats(brute, 0, false).atk.div(plainAtk).toNumber();
  assert.ok(Math.abs(ratio - Game.CONFIG.bruteAtkMult) < 1e-9);
  const g = new Game(null, { random: noCrit });
  g.state.area = area('regen');
  g.state.maxArea = g.state.area;
  g.enemy = null;
  g.spawnEnemy();
  const e = g.enemy;
  assert.ok(e.regen > 0);
  e.hp = e.maxHp.div(2);
  run(g, 1);
  assert.ok(e.hp.gt(e.maxHp.mul(0.52)), 'healed by about 5% of max HP');
});

test('the formation is kept through prestige and saves, and old saves fight with their strongest attribute', () => {
  const g = new Game(null, { random: noCrit });
  assert.ok(g.setFormation('holy'));
  g.state.maxArea = 40;
  assert.ok(g.prestige());
  assert.equal(g.state.formation, 'holy');
  const h = new Game(JSON.parse(JSON.stringify(g.serialize())), { random: noCrit });
  assert.equal(h.state.formation, 'holy');
  // 陣形のなかった頃のセーブ: 魔法使い（3人目）がいちばん強い
  const old = new Game({ totalExp: 0, maxArea: 12, area: 12, party: [5, 5, 60] }, { random: noCrit });
  assert.equal(old.state.formation, 'magic');
  assert.ok(old.getStats().partyDps.gt(0));
});
