/*
 * ゲームの静的データ（エリア、敵、装備、仲間、スキル、転生ボーナス）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameData = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // hue は戦闘画面の背景色に使う
  const AREAS = [
    { name: 'はじまりの草原', hue: 110, enemies: [['🟢', 'スライム'], ['🐀', 'おおネズミ'], ['🐝', 'キラービー']], boss: ['👑', 'キングスライム'] },
    { name: 'ささやきの森', hue: 140, enemies: [['🐺', 'ワーウルフ'], ['🍄', 'おばけキノコ'], ['🕷️', 'ジャイアントスパイダー']], boss: ['🌳', 'エルダートレント'] },
    { name: 'ゴブリンの洞窟', hue: 30, enemies: [['👺', 'ゴブリン'], ['🦇', 'ドラキー'], ['🪨', 'ロックゴーレム']], boss: ['👹', 'ゴブリンキング'] },
    { name: '砂塵の砂漠', hue: 45, enemies: [['🦂', 'デスサソリ'], ['🐍', 'サンドスネーク'], ['🧟', 'ミイラ男']], boss: ['🪱', 'サンドワーム'] },
    { name: '氷結の雪原', hue: 195, enemies: [['⛄', 'スノーマン'], ['🐧', 'ペンギン兵'], ['🐻‍❄️', 'アイスベア']], boss: ['❄️', '氷帝フリーズ'] },
    { name: '灼熱の火山', hue: 10, enemies: [['🔥', 'ファイアスピリット'], ['🦎', 'サラマンダー'], ['🌋', '溶岩魔人']], boss: ['🐉', 'レッドドラゴン'] },
    { name: '深海神殿', hue: 215, enemies: [['🦑', 'クラーケンの子'], ['🦈', 'メガロドン'], ['🐙', 'ダゴン']], boss: ['🐋', 'リヴァイアサン'] },
    { name: '天空の城', hue: 190, enemies: [['🦅', 'グリフォン'], ['👼', '堕天使'], ['⚡', 'サンダーバード']], boss: ['🌩️', '雷神トール'] },
    { name: '魔王城', hue: 280, enemies: [['😈', 'アークデーモン'], ['🧛', 'ヴァンパイア'], ['💀', 'デスナイト']], boss: ['👿', '魔王'] },
    { name: '冥界', hue: 260, enemies: [['👻', '亡霊'], ['🐕', 'ケルベロス'], ['☠️', '死神']], boss: ['⚰️', '冥王ハデス'] },
    { name: '神界', hue: 50, enemies: [['😇', '大天使'], ['🦄', '聖獣ユニコーン'], ['🗿', '守護神像']], boss: ['☀️', '太陽神'] },
    { name: '星の海', hue: 235, enemies: [['☄️', '彗星獣'], ['🌟', '星霊'], ['👽', '宇宙人']], boss: ['🪐', '惑星喰らい'] },
    { name: '銀河の中心', hue: 300, enemies: [['🌌', '星雲竜'], ['🛸', 'インベーダー'], ['🌠', '流星王']], boss: ['🕳️', 'ブラックホール'] },
    { name: '多元宇宙', hue: 320, enemies: [['🪞', '鏡像の勇者'], ['🌀', '次元獣'], ['🎭', '並行世界の魔王']], boss: ['🌐', 'マルチバース'] },
    { name: '虚数空間', hue: 170, enemies: [['🔢', '虚数兵'], ['➗', 'ゼロ除算の悪魔'], ['♾️', '無限ループ']], boss: ['🧮', '計算不能体'] },
    { name: '概念の彼方', hue: 0, enemies: [['📜', '概念獣'], ['💭', '夢喰い'], ['🔣', '記号の王']], boss: ['👁️', '全知の眼'] },
    { name: 'インフレの特異点', hue: 90, enemies: [['📈', 'インフレ獣'], ['💹', 'ハイパーインフレ'], ['💸', '通貨崩壊']], boss: ['🏦', '中央銀行'] },
  ];

  // エリア一覧を一周するごとに付く接頭辞
  const LOOP_PREFIXES = ['', '真・', '超・', '極・', '神・', '究極・', '無限・'];

  // 装備は強化レベル EQUIP_EVOLVE_EVERY ごとに名前が進化する
  const EQUIP_MATERIALS = ['木の', '銅の', '鉄の', '鋼の', '銀の', 'ミスリルの', 'オリハルコンの', 'アダマンの',
    '竜鱗の', '星屑の', '神鉄の', '虚無の', '時空の', '因果律の', '概念の', '無量大数の'];
  const EQUIP_EVOLVE_EVERY = 10;

  const EQUIPMENT = [
    { id: 'weapon', slot: '武器', icon: '🗡️', item: '剣', effect: '攻撃力', baseCost: 10, costGrowth: 1.37, perLevel: 0.25, milestoneMult: 2 },
    { id: 'armor', slot: '防具', icon: '🛡️', item: '鎧', effect: '最大HP・防御力', baseCost: 15, costGrowth: 1.37, perLevel: 0.25, milestoneMult: 2 },
    { id: 'accessory', slot: '装飾品', icon: '💍', item: '指輪', effect: 'ゴールド・経験値', baseCost: 50, costGrowth: 1.4, perLevel: 0.15, milestoneMult: 1.5 },
  ];

  // 仲間: 勇者の攻撃力 × (ratio × レベル) のダメージを毎秒自動で与える。
  // PARTY_MILESTONE_EVERY レベルごとに PARTY_MILESTONE_MULT 倍
  const PARTY = [
    { id: 'villager', icon: '🧑‍🌾', name: '村人A', baseCost: 20, ratio: 0.05 },
    { id: 'warrior', icon: '🪓', name: '戦士', baseCost: 500, ratio: 0.4 },
    { id: 'mage', icon: '🧙', name: '魔法使い', baseCost: 2e4, ratio: 3 },
    { id: 'priest', icon: '⛪', name: '僧侶', baseCost: 1e6, ratio: 25 },
    { id: 'ninja', icon: '🥷', name: '忍者', baseCost: 8e7, ratio: 200 },
    { id: 'dragoon', icon: '🐲', name: '竜騎士', baseCost: 1e10, ratio: 1800 },
    { id: 'sage', icon: '📖', name: '賢者', baseCost: 2e12, ratio: 1.6e4 },
    { id: 'robot', icon: '🤖', name: '古代兵器', baseCost: 5e14, ratio: 1.5e5 },
    { id: 'hero', icon: '🦸', name: '伝説の勇者', baseCost: 2e17, ratio: 1.5e6 },
    { id: 'god', icon: '🧞', name: '神', baseCost: 1e20, ratio: 1.6e7 },
    { id: 'universe', icon: '🌌', name: '宇宙の意思', baseCost: 1e23, ratio: 1.8e8 },
    { id: 'author', icon: '✍️', name: 'このゲームの作者', baseCost: 1e27, ratio: 2e9 },
  ];
  // PARTY の後に続く仲間。雇用コストと倍率は最後の仲間から一定の比率で伸びる。
  // この一覧も尽きたら、エリアと同じ接頭辞（真・超・極…）を付けて最初から無限に繰り返す
  const PARTY_EXTRA = [
    { icon: '🎮', name: 'このゲームのプレイヤー' },
    { icon: '🐉', name: '始祖竜' },
    { icon: '⏳', name: '時の番人' },
    { icon: '🌀', name: '次元の旅人' },
    { icon: '🧮', name: '巨大数学者' },
    { icon: '📈', name: 'インフレ魔神' },
    { icon: '🏦', name: '中央銀行総裁' },
    { icon: '♾️', name: '無限の化身' },
    { icon: '🌠', name: '創世神' },
    { icon: '🪐', name: '多元宇宙の王' },
    { icon: '👁️', name: '全知の観測者' },
    { icon: '🔣', name: '概念そのもの' },
  ];
  const PARTY_GEN_COST_STEP = 1e4;
  const PARTY_GEN_RATIO_STEP = 16;
  const PARTY_COST_GROWTH = 1.22;
  const PARTY_MILESTONE_EVERY = 25;
  const PARTY_MILESTONE_MULT = 4;

  const SKILLS = [
    { id: 'berserk', icon: '💢', name: 'バーサーク', desc: '30秒間 攻撃力 ×10', duration: 30, cooldown: 120, unlockArea: 3 },
    { id: 'goldrush', icon: '💰', name: 'ゴールドラッシュ', desc: '30秒間 獲得ゴールド ×10', duration: 30, cooldown: 180, unlockArea: 6 },
    { id: 'haste', icon: '⏩', name: '時間加速', desc: '20秒間 攻撃速度 ×4', duration: 20, cooldown: 150, unlockArea: 10 },
    { id: 'meteor', icon: '☄️', name: 'インフレメテオ', desc: '敵の最大HPの50%(ボスは10%)ダメージ', duration: 0, cooldown: 90, unlockArea: 15 },
    { id: 'rally', icon: '📣', name: '総力戦', desc: '30秒間 仲間のDPS ×20', duration: 30, cooldown: 240, unlockArea: 20 },
  ];

  // 転生で得た魂を消費して買う永続ボーナス
  const SOUL_UPGRADES = [
    { id: 'power', icon: '⚔️', name: '軍神の加護', desc: '攻撃力と仲間DPS ×2', baseCost: 1, costGrowth: 2.2 },
    { id: 'wealth', icon: '🪙', name: '富神の加護', desc: '獲得ゴールド ×2', baseCost: 1, costGrowth: 2.2 },
    { id: 'wisdom', icon: '📚', name: '知神の加護', desc: '獲得経験値 ×3', baseCost: 2, costGrowth: 2.5 },
    { id: 'vitality', icon: '❤️', name: '命神の加護', desc: '最大HPと防御力 ×3', baseCost: 2, costGrowth: 2.5 },
    { id: 'time', icon: '⏳', name: '時神の加護', desc: 'ボス制限時間 +5秒 (最大10回)', baseCost: 5, costGrowth: 3, max: 10 },
    { id: 'soul', icon: '👻', name: '冥神の加護', desc: '転生で得る魂 ×1.5', baseCost: 10, costGrowth: 4 },
  ];

  return {
    AREAS, LOOP_PREFIXES, EQUIP_MATERIALS, EQUIP_EVOLVE_EVERY, EQUIPMENT,
    PARTY, PARTY_EXTRA, PARTY_GEN_COST_STEP, PARTY_GEN_RATIO_STEP,
    PARTY_COST_GROWTH, PARTY_MILESTONE_EVERY, PARTY_MILESTONE_MULT,
    SKILLS, SOUL_UPGRADES,
  };
});
