const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('give-points')
    .setDescription('Crédite des points de test à un membre (phase de test uniquement)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('Membre à créditer').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Nombre de points').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setDescription('Crée un marché des cotes')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('titre').setDescription('Titre du marché').setRequired(true))
    .addStringOption(o => o.setName('fermeture').setDescription('Date/heure de fermeture (ISO : 2026-06-24T21:00:00)').setRequired(true))
    .addStringOption(o => o.setName('choix1').setDescription('Choix 1').setRequired(true))
    .addStringOption(o => o.setName('choix2').setDescription('Choix 2').setRequired(true))
    .addStringOption(o => o.setName('choix3').setDescription('Choix 3').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Channel cible (défaut : channel actuel)').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addStringOption(o => o.setName('image').setDescription('URL d\'une image à afficher dans l\'embed').setRequired(false)),

  new SlashCommandBuilder()
    .setName('set-market-result')
    .setDescription('Déclare le résultat d\'un marché et crédite les gagnants')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('market_id').setDescription('ID du marché (fourni à la création)').setRequired(true))
    .addIntegerOption(o => o.setName('gagnant').setDescription('Numéro du choix gagnant (1, 2 ou 3)').setRequired(true).addChoices(
      { name: 'Choix 1', value: 1 },
      { name: 'Choix 2', value: 2 },
      { name: 'Choix 3', value: 3 },
    )),

  new SlashCommandBuilder()
    .setName('close-market')
    .setDescription('Ferme manuellement un marché')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('market_id').setDescription('ID du marché').setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 Déploiement des slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands déployées !');
  } catch (err) {
    console.error('❌ Erreur :', err);
    process.exit(1);
  }
})();
