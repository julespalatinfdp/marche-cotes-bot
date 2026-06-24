const {
  Client, GatewayIntentBits, EmbedBuilder,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, REST, Routes,
  ComponentType
} = require('discord.js');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const DB_PATH      = process.env.DB_PATH      || './markets-test-db.json';
const MARKETS_PATH = process.env.MARKETS_PATH || './markets.json';
const ADMIN_LOG_CHANNEL = process.env.ADMIN_LOG_CHANNEL || null;
const COTE_MIN = 1.05;
const COTE_MAX = 15.0;
const RAKE    = 0.85;

// ─────────────────────────────────────────
// DB HELPERS — partagé avec Matchday
// ─────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return {}; }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function getBalance(userId) {
  const db = loadDB();
  return db[userId]?.points ?? 0;
}

function deductPoints(userId, amount) {
  const db = loadDB();
  if (!db[userId]) db[userId] = { points: 0 };
  db[userId].points -= amount;
  saveDB(db);
}

function creditPoints(userId, amount) {
  const db = loadDB();
  if (!db[userId]) db[userId] = { points: 0 };
  db[userId].points += amount;
  saveDB(db);
}

// ─────────────────────────────────────────
// MARKETS HELPERS
// ─────────────────────────────────────────
function loadMarkets() {
  if (!fs.existsSync(MARKETS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(MARKETS_PATH, 'utf8')); } catch { return {}; }
}

function saveMarkets(markets) {
  fs.writeFileSync(MARKETS_PATH, JSON.stringify(markets, null, 2));
}

// ─────────────────────────────────────────
// CALCUL DES COTES
// ─────────────────────────────────────────
function computeOdds(market) {
  const totalBettors = Object.values(market.bets).flat().length;
  return market.choices.map((_, i) => {
    const betOnThis = (market.bets[i] || []).length;
    if (totalBettors === 0 || betOnThis === 0) return COTE_MAX;
    const raw = (totalBettors / betOnThis) * RAKE;
    return Math.min(COTE_MAX, Math.max(COTE_MIN, Math.round(raw * 100) / 100));
  });
}

// ─────────────────────────────────────────
// BARRE DE PROGRESSION VISUELLE
// ─────────────────────────────────────────
function buildProgressBar(ratio, length = 12) {
  const filled = Math.round(ratio * length);
  const empty  = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// ─────────────────────────────────────────
// EMBED DU MARCHÉ
// ─────────────────────────────────────────
function buildMarketEmbed(market, odds, closed = false) {
  const totalBets   = Object.values(market.bets).flat().reduce((s, b) => s + b.amount, 0);
  const totalBettors = Object.values(market.bets).flat().length;

  const choiceLines = market.choices.map((choice, i) => {
    const bettors  = (market.bets[i] || []).length;
    const amount   = (market.bets[i] || []).reduce((s, b) => s + b.amount, 0);
    const ratio    = totalBettors > 0 ? bettors / totalBettors : 0;
    const bar      = buildProgressBar(ratio);
    const pct      = Math.round(ratio * 100);
    return `**${choice}**\n\`${bar}\` ${pct}% — cote **×${odds[i]}**\n📊 ${bettors} parieurs · ${amount} pts misés`;
  });

  const closeDate = new Date(market.closeAt);
  const embed = new EmbedBuilder()
    .setTitle(closed ? `🔴 ${market.title} — FERMÉ` : `📈 ${market.title}`)
    .setDescription(choiceLines.join('\n\n'))
    .setColor(closed ? '#e74c3c' : '#2ecc71')
    .addFields({ name: '📦 Total misé', value: `${totalBets} pts par ${totalBettors} parieurs`, inline: true })
    .addFields({ name: '⏰ Fermeture', value: `<t:${Math.floor(closeDate.getTime() / 1000)}:R>`, inline: true });

  if (market.image) embed.setImage(market.image);
  return embed;
}

// ─────────────────────────────────────────
// BOUTONS DU MARCHÉ
// ─────────────────────────────────────────
function buildMarketButtons(marketId, market, odds, disabled = false) {
  const row = new ActionRowBuilder();
  market.choices.forEach((choice, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`bet:${marketId}:${i}`)
        .setLabel(`${choice} ×${odds[i]}`)
        .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(disabled)
    );
  });
  return row;
}

// ─────────────────────────────────────────
// MISE À JOUR DE L'EMBED EN DIRECT
// ─────────────────────────────────────────
async function refreshMarketMessage(client, marketId) {
  const markets = loadMarkets();
  const market  = markets[marketId];
  if (!market || !market.messageId || !market.channelId) return;

  try {
    const channel = await client.channels.fetch(market.channelId);
    const message = await channel.messages.fetch(market.messageId);
    const odds    = computeOdds(market);
    const closed  = market.closed || Date.now() >= new Date(market.closeAt).getTime();
    await message.edit({
      embeds: [buildMarketEmbed(market, odds, closed)],
      components: [buildMarketButtons(marketId, market, odds, closed)],
    });
  } catch (err) {
    console.error('❌ Erreur refresh embed :', err.message);
  }
}

// ─────────────────────────────────────────
// FERMETURE AUTOMATIQUE
// ─────────────────────────────────────────
function scheduleAutoClose(client, marketId) {
  const markets = loadMarkets();
  const market  = markets[marketId];
  if (!market) return;

  const delay = new Date(market.closeAt).getTime() - Date.now();
  if (delay <= 0) return;

  setTimeout(async () => {
    const mkts = loadMarkets();
    if (!mkts[marketId] || mkts[marketId].closed) return;
    mkts[marketId].closed = true;
    saveMarkets(mkts);
    await refreshMarketMessage(client, marketId);
    console.log(`🔴 Marché ${marketId} fermé automatiquement.`);
  }, delay);
}

// ─────────────────────────────────────────
// CLIENT
// ─────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ─────────────────────────────────────────
// INTERACTIONS
// ─────────────────────────────────────────
client.on('interactionCreate', async interaction => {

  // ── SLASH COMMANDS ───────────────────────
  if (interaction.isChatInputCommand()) {

    // /give-points
    if (interaction.commandName === 'give-points') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Réservé aux admins.', ephemeral: true });
      }
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      creditPoints(target.id, amount);
      const newBalance = getBalance(target.id);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setDescription(`✅ **${amount} pts** crédités à <@${target.id}>. Nouveau solde : **${newBalance} pts**`)
          .setColor('#3498db')],
        ephemeral: true,
      });
    }

    // /create-market
    if (interaction.commandName === 'create-market') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Réservé aux admins.', ephemeral: true });
      }

      const title   = interaction.options.getString('titre');
      const closeAt = interaction.options.getString('fermeture'); // format ISO ou timestamp
      const c1      = interaction.options.getString('choix1');
      const c2      = interaction.options.getString('choix2');
      const c3      = interaction.options.getString('choix3');
      const image   = interaction.options.getString('image') || null;
      const channel = interaction.options.getChannel('channel') || interaction.channel;

      // Valider la date
      const closeDate = new Date(closeAt);
      if (isNaN(closeDate.getTime()) || closeDate <= new Date()) {
        return interaction.reply({ content: '❌ Date de fermeture invalide. Format : `2026-06-24T21:00:00`', ephemeral: true });
      }

      const marketId = `mkt_${Date.now()}`;
      const market = {
        id: marketId,
        title,
        choices: [c1, c2, c3],
        closeAt: closeDate.toISOString(),
        closed: false,
        image,
        channelId: channel.id,
        messageId: null,
        bets: { 0: [], 1: [], 2: [] },
      };

      const odds = computeOdds(market);
      const msg  = await channel.send({
        embeds: [buildMarketEmbed(market, odds)],
        components: [buildMarketButtons(marketId, market, odds)],
      });

      market.messageId = msg.id;
      const markets = loadMarkets();
      markets[marketId] = market;
      saveMarkets(markets);

      scheduleAutoClose(client, marketId);

      // Log dans channel admin
      if (ADMIN_LOG_CHANNEL) {
        try {
          const logCh = await client.channels.fetch(ADMIN_LOG_CHANNEL);
          await logCh.send({
            embeds: [new EmbedBuilder()
              .setTitle('📋 Nouveau marché créé')
              .setDescription(`**Titre :** ${title}\n**ID :** \`${marketId}\`\n**Fermeture :** <t:${Math.floor(closeDate.getTime() / 1000)}:F>\n**Channel :** <#${channel.id}>`)
              .setColor('#3498db')]
          });
        } catch {}
      }

      return interaction.reply({ content: `✅ Marché créé ! ID : \`${marketId}\``, ephemeral: true });
    }

    // /set-market-result
    if (interaction.commandName === 'set-market-result') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Réservé aux admins.', ephemeral: true });
      }

      const marketId    = interaction.options.getString('market_id');
      const winnerIndex = interaction.options.getInteger('gagnant') - 1; // 1-indexé → 0-indexé

      const markets = loadMarkets();
      const market  = markets[marketId];
      if (!market) return interaction.reply({ content: `❌ Marché \`${marketId}\` introuvable.`, ephemeral: true });
      if (market.result !== undefined) return interaction.reply({ content: '❌ Ce marché a déjà un résultat.', ephemeral: true });

      // Cotes figées à la fermeture
      const odds = computeOdds(market);
      const winnerOdd = odds[winnerIndex];

      // Créditer les gagnants
      const winners = market.bets[winnerIndex] || [];
      let totalCredited = 0;
      for (const bet of winners) {
        const gain = Math.floor(bet.amount * winnerOdd);
        creditPoints(bet.userId, gain);
        totalCredited += gain;
      }

      // Rembourser les perdants : ils ont déjà perdu leur mise (déduite au moment du pari)
      market.result = winnerIndex;
      market.closed = true;
      saveMarkets(markets);

      await refreshMarketMessage(client, marketId);

      // Annoncer dans le channel du marché
      try {
        const channel = await client.channels.fetch(market.channelId);
        const winnerChoice = market.choices[winnerIndex];
        const embed = new EmbedBuilder()
          .setTitle('🏆 Résultat du marché')
          .setDescription(
            `**${market.title}**\n\n` +
            `✅ Choix gagnant : **${winnerChoice}** (×${winnerOdd})\n\n` +
            `${winners.length} gagnant(s) — **${totalCredited} pts** crédités au total.`
          )
          .setColor('#f1c40f');
        await channel.send({ embeds: [embed] });
      } catch {}

      return interaction.reply({ content: `✅ Résultat enregistré. ${winners.length} gagnant(s) crédités.`, ephemeral: true });
    }

    // /close-market
    if (interaction.commandName === 'close-market') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Réservé aux admins.', ephemeral: true });
      }

      const marketId = interaction.options.getString('market_id');
      const markets  = loadMarkets();
      if (!markets[marketId]) return interaction.reply({ content: `❌ Marché \`${marketId}\` introuvable.`, ephemeral: true });

      markets[marketId].closed = true;
      saveMarkets(markets);
      await refreshMarketMessage(client, marketId);

      return interaction.reply({ content: `✅ Marché \`${marketId}\` fermé manuellement.`, ephemeral: true });
    }
  }

  // ── BOUTON BET ───────────────────────────
  if (interaction.isButton()) {
    const parts = interaction.customId.split(':');
    if (parts[0] !== 'bet') return;

    const [, marketId, choiceIdxStr] = parts;
    const choiceIdx = parseInt(choiceIdxStr);

    const markets = loadMarkets();
    const market  = markets[marketId];
    if (!market) return interaction.reply({ content: '❌ Marché introuvable.', ephemeral: true });
    if (market.closed || Date.now() >= new Date(market.closeAt).getTime()) {
      return interaction.reply({ content: '🔴 Ce marché est fermé.', ephemeral: true });
    }

    // Vérifier si déjà parié sur ce marché
    const alreadyBet = Object.values(market.bets).flat().find(b => b.userId === interaction.user.id);
    if (alreadyBet) {
      return interaction.reply({ content: '❌ Tu as déjà parié sur ce marché. Les paris sont irrévocables.', ephemeral: true });
    }

    const balance = getBalance(interaction.user.id);
    if (balance < 1) {
      return interaction.reply({ content: '❌ Tu n\'as pas assez de points Matchday pour parier.', ephemeral: true });
    }

    const odds       = computeOdds(market);
    const currentOdd = odds[choiceIdx];
    const choice     = market.choices[choiceIdx];

    // Ouvrir le modal
    const modal = new ModalBuilder()
      .setCustomId(`bet_modal:${marketId}:${choiceIdx}`)
      .setTitle(`Miser sur "${choice}"`);

    const input = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel(`Cote actuelle : ×${currentOdd} | Solde : ${balance} pts`)
      .setPlaceholder(`Entre 1 et ${balance}`)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(6);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // ── MODAL SUBMIT ─────────────────────────
  if (interaction.isModalSubmit()) {
    const parts = interaction.customId.split(':');
    if (parts[0] !== 'bet_modal') return;

    const [, marketId, choiceIdxStr] = parts;
    const choiceIdx = parseInt(choiceIdxStr);

    const markets = loadMarkets();
    const market  = markets[marketId];
    if (!market) return interaction.reply({ content: '❌ Marché introuvable.', ephemeral: true });
    if (market.closed || Date.now() >= new Date(market.closeAt).getTime()) {
      return interaction.reply({ content: '🔴 Ce marché est fermé entre le moment où tu as cliqué et maintenant.', ephemeral: true });
    }

    const amountStr = interaction.fields.getTextInputValue('amount');
    const amount    = parseInt(amountStr);
    const balance   = getBalance(interaction.user.id);

    if (isNaN(amount) || amount < 1) {
      return interaction.reply({ content: '❌ Mise invalide. Minimum : 1 pt.', ephemeral: true });
    }
    if (amount > balance) {
      return interaction.reply({ content: `❌ Solde insuffisant. Tu as **${balance} pts**.`, ephemeral: true });
    }

    // Vérifier si déjà parié (double-check)
    const alreadyBet = Object.values(market.bets).flat().find(b => b.userId === interaction.user.id);
    if (alreadyBet) {
      return interaction.reply({ content: '❌ Tu as déjà parié sur ce marché.', ephemeral: true });
    }

    // Cote figée au moment du clic (pas du submit)
    const odds       = computeOdds(market);
    const lockedOdd  = odds[choiceIdx];
    const choice     = market.choices[choiceIdx];
    const potentialGain = Math.floor(amount * lockedOdd);

    // Enregistrer le pari
    deductPoints(interaction.user.id, amount);
    markets[marketId].bets[choiceIdx].push({
      userId: interaction.user.id,
      amount,
      odd: lockedOdd,
    });
    saveMarkets(markets);

    // Refresh embed
    await refreshMarketMessage(client, marketId);

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('✅ Pari enregistré !')
        .setDescription(
          `**Choix :** ${choice}\n` +
          `**Mise :** ${amount} pts\n` +
          `**Cote :** ×${lockedOdd}\n` +
          `**Gain potentiel :** ${potentialGain} pts\n\n` +
          `*Le pari est irrévocable.*`
        )
        .setColor('#2ecc71')],
      ephemeral: true,
    });
  }
});

// ─────────────────────────────────────────
// READY — reprogramme les fermetures auto
// ─────────────────────────────────────────
client.once('ready', () => {
  console.log(`🤖 Bot connecté : ${client.user.tag}`);
  const markets = loadMarkets();
  for (const [id, market] of Object.entries(markets)) {
    if (!market.closed && new Date(market.closeAt) > new Date()) {
      scheduleAutoClose(client, id);
      console.log(`⏰ Fermeture auto reprogrammée : ${id}`);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
