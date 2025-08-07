require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionsBitField } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// Setup
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('add-currency')
    .setDescription('Admin: Add a currency with optional metric')
    .addStringOption(opt => opt.setName('name').setDescription('Currency name').setRequired(true))
    .addNumberOption(opt => opt.setName('metric').setDescription('Metric (default 1)')),

  new SlashCommandBuilder()
    .setName('set-metric')
    .setDescription('Admin: Update metric of a currency')
    .addStringOption(opt => opt.setName('name').setDescription('Currency').setRequired(true))
    .addNumberOption(opt => opt.setName('metric').setDescription('New metric').setRequired(true)),

  new SlashCommandBuilder()
    .setName('list-currencies')
    .setDescription('List all available currencies'),

  new SlashCommandBuilder()
    .setName('trade-request')
    .setDescription('Request a trade')
    .addStringOption(opt => 
      opt.setName('from_currency')
        .setDescription('From currency')
        .setRequired(true)
        .setAutocomplete(true) // 🔥 Enable autocomplete
    )
    .addStringOption(opt => 
      opt.setName('to_currency')
        .setDescription('To currency')
        .setRequired(true)
        .setAutocomplete(true) // 🔥 Enable autocomplete
    )
    .addNumberOption(opt => 
      opt.setName('amount')
        .setDescription('Amount')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('my-request')
    .setDescription('Check your trade request'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Admin: View trade queue'),

  new SlashCommandBuilder()
    .setName('prioritize')
    .setDescription('Admin: Prioritize a user trade')
    .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true)),

  new SlashCommandBuilder()
    .setName('remove-request')
    .setDescription('Admin: Remove a user trade')
    .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
].map(cmd => cmd.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

// Register commands
(async () => {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Slash commands registered');
  } catch (err) {
    console.error('Command registration failed:', err);
  }
})();

// Bot ready
client.once('ready', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

// Helper: check if user is admin
const isAdmin = (member) =>
  member.permissions.has(PermissionsBitField.Flags.Administrator);

// Slash command handler
client.on('interactionCreate', async (interaction) => {
   if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused();
    const fromCurrency = interaction.options.getString('from_currency');
    const name = interaction.options.getFocused(true).name;

    const { data: currencies, error } = await supabase.from('Currencies').select('name');
    if (error || !currencies) return;

    let filtered = currencies.map(c => c.name);

    // If autocompleting 'to_currency', exclude selected from_currency
    if (name === 'to_currency' && fromCurrency) {
      filtered = filtered.filter(c => c !== fromCurrency);
    }

    const choices = filtered
      .filter(c => c.toLowerCase().startsWith(focused.toLowerCase()))
      .slice(0, 25) // Discord limit
      .map(c => ({ name: c, value: c }));

    return interaction.respond(choices);
  }

  if (!interaction.isChatInputCommand()) return;
  
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, member, user } = interaction;

  // /add-currency
  if (commandName === 'add-currency') {
    if (!isAdmin(member)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

    const name = options.getString('name').toLowerCase();
    const metric = options.getNumber('metric') ?? 1;

    const { error } = await supabase.from('Currencies').insert({ name, metric });
    if (error) return interaction.reply({ content: 'Error: ' + error.message, ephemeral: true });

    return interaction.reply(`✅ Currency \`${name}\` added with metric \`${metric}\``);
  }

  // /set-metric
  if (commandName === 'set-metric') {
    if (!isAdmin(member)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

    const name = options.getString('name').toLowerCase();
    const metric = options.getNumber('metric');

    const { data, error } = await supabase.from('Currencies').update({ metric }).eq('name', name).select();
    if (error || !data.length) return interaction.reply({ content: 'Currency not found or error.', ephemeral: true });

    return interaction.reply(`🛠 Metric for \`${name}\` updated to \`${metric}\``);
  }

  // /list-currencies
  if (commandName === 'list-currencies') {
    const { data, error } = await supabase.from('Currencies').select();
    if (error || !data.length) return interaction.reply('No currencies found.');

    const msg = data.map(c => `• **${c.name}** (metric: ${c.metric})`).join('\n');
    return interaction.reply({ content: `📦 Available Currencies:\n${msg}`, ephemeral: true });
  }

  // /trade-request
  if (commandName === 'trade-request') {
    const from = options.getString('from_currency').toLowerCase();
    const to = options.getString('to_currency').toLowerCase();
    const amount = options.getNumber('amount');

    const existing = await supabase.from('TradeQueue').select().eq('user_id', user.id).eq('status', 'queued');
    if (existing.data.length) return interaction.reply({ content: 'You already have a pending request.', ephemeral: true });

    const { data: fromCurrency } = await supabase.from('Currencies').select('metric').eq('name', from).single();
    const { data: toCurrency } = await supabase.from('Currencies').select('metric').eq('name', to).single();

    if (!fromCurrency || !toCurrency) return interaction.reply({ content: 'Invalid currency.', ephemeral: true });

    await supabase.from('TradeQueue').insert({
      user_id: user.id,
      from_currency: from,
      to_currency: to,
      amount,
      from_metric: fromCurrency.metric,
      to_metric: toCurrency.metric,
      status: 'queued'
    });

    return interaction.reply(`💱 Trade request submitted: ${amount} ${from} → ${to}`);
  }

  // /my-request
  if (commandName === 'my-request') {
    const { data } = await supabase.from('TradeQueue').select().eq('user_id', user.id).eq('status', 'queued');
    if (!data.length) return interaction.reply({ content: 'You have no pending requests.', ephemeral: true });

    const req = data[0];
    return interaction.reply(`🔄 You requested: ${req.amount} ${req.from_currency} → ${req.to_currency}`);
  }

  // /queue
  if (commandName === 'queue') {
    if (!isAdmin(member)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

    const { data } = await supabase.from('TradeQueue').select().eq('status', 'queued').order('created_at');
    if (!data.length) return interaction.reply('📭 No trades in queue.');

    const queueList = data.map((t, i) => `${i + 1}. <@${t.user_id}> ${t.amount} ${t.from_currency} → ${t.to_currency}`).join('\n');
    return interaction.reply(`📋 Trade Queue:\n${queueList}`);
  }

  // /prioritize
  if (commandName === 'prioritize') {
    if (!isAdmin(member)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

    const target = options.getUser('user');
    const { data } = await supabase.from('TradeQueue').select().eq('user_id', target.id).eq('status', 'queued');
    if (!data.length) return interaction.reply('User has no queued request.');

    const id = data[0].id;
    await supabase.rpc('move_to_top', { row_id: id }); // You can make a Supabase function to reorder

    return interaction.reply(`⬆️ Prioritized <@${target.id}>'s request.`);
  }

  // /remove-request
  if (commandName === 'remove-request') {
    if (!isAdmin(member)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

    const target = options.getUser('user');
    await supabase.from('TradeQueue').delete().eq('user_id', target.id).eq('status', 'queued');
    return interaction.reply(`🗑️ Removed <@${target.id}>'s trade request.`);
  }
});

client.login(process.env.DISCORD_TOKEN);

