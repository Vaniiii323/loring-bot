// index.js — النسخة الكاملة مع نظام الصلاحيات ولوحة التحكم

const {
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ChannelType, PermissionsBitField, ModalBuilder, TextInputBuilder,
    TextInputStyle, ActivityType, MessageFlags
} = require('discord.js');
const express = require('express');
const fs = require('fs');

// ===============================================
// 1. الثوابت والتهيئة
// ===============================================

const BOT_TOKEN       = process.env.BOT_TOKEN;
const MANAGER_ROLE_ID = process.env.MANAGER_ROLE_ID;
const PREFIX          = '-';

const LOGS_CHANNEL_ID     = '1449444036824797334';
const ARCHIVE_CATEGORY_ID = '1449459496144470056';
const REQUESTS_CHANNEL_ID = '1477338804502266079';
const STATS_CHANNEL_ID    = '1477339013663822037';
const TICKET_IMAGE_URL    = 'https://d.top4top.io/p_3710jchmp1.png';
const DATA_FILE           = './data.json';

// ───── تحميل / حفظ البيانات ─────
function loadData() {
    if (!fs.existsSync(DATA_FILE))
        return { ratings: {}, points: {}, absents: [], botUsers: {}, settings: {}, controlChannelId: null };
    try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (!raw.botUsers)         raw.botUsers         = {};
        if (!raw.settings)         raw.settings         = {};
        if (!raw.controlChannelId) raw.controlChannelId = null;
        return raw;
    } catch { return { ratings: {}, points: {}, absents: [], botUsers: {}, settings: {}, controlChannelId: null }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8'); }
let db = loadData();

// ─── نظام الصلاحيات ───
// المستويات: owner(3) > supervisor(2) > admin(1)
function getBotRole(uid)      { return db.botUsers[uid]?.role || 0; }
function isBotOwner(uid)      { return getBotRole(uid) >= 3; }
function isBotSupervisor(uid) { return getBotRole(uid) >= 2; }
function isBotAdmin(uid)      { return getBotRole(uid) >= 1; }
function hasPermission(member, level = 1) {
    if (member.guild.ownerId === member.id) return true;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    return getBotRole(member.id) >= level;
}

// ─── الإعدادات ───
function getSetting(k, def) { return db.settings[k] !== undefined ? db.settings[k] : def; }
function setSetting(k, v)   { db.settings[k] = v; saveData(db); }

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ]
});

// ─── خيارات الخدمة ───
const SERVICE_OPTIONS = {
    programming_services: { label: 'طلب خدمات برمجية',    description: 'تطوير بوتات، مواقع، سكربتات.', emoji: '💻', categoryName: 'خدمات-برمجية',  color: '#5865F2' },
    account_installation: { label: 'تثبيت حسابات ديسكورد', description: 'تثبيت حسابك في ديسكورد.',      emoji: '✅', categoryName: 'تثبيت-حسابات', color: '#57F287' },
    general_ticket:       { label: 'تكت عام/استفسار',       description: 'للاستفسارات غير المدرجة.',     emoji: '🎫', categoryName: 'تكت-عام',       color: '#FEE75C' }
};
const PRIORITY_OPTIONS = {
    normal:   { label: 'عادي', emoji: '🟢', color: '#57F287' },
    urgent:   { label: 'عاجل', emoji: '🟡', color: '#FEE75C' },
    critical: { label: 'حرج',  emoji: '🔴', color: '#ED4245' }
};

// ─── Maps ───
const ticketOpenTime    = new Map();
const ticketClaimer     = new Map();
const pendingTickets    = new Map();
const ticketOwnerMap    = new Map();
const firstTicketSet    = new Set();
const lastMemberMessage = new Map();
const reminderSent      = new Set();

// ===============================================
// 2. الدوال المساعدة
// ===============================================

function createSetupComponents() {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('open_ticket_menu').setLabel('فتح تكت').setStyle(ButtonStyle.Primary).setEmoji('🎫')
    )];
}
function createSelectMenuComponents() {
    return [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('service_select_menu').setPlaceholder('اختر نوع الخدمة...')
            .addOptions(Object.keys(SERVICE_OPTIONS).map(k => ({
                label: SERVICE_OPTIONS[k].label, description: SERVICE_OPTIONS[k].description,
                value: k, emoji: SERVICE_OPTIONS[k].emoji
            })))
    )];
}
function createPriorityComponents() {
    return [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('priority_select_menu').setPlaceholder('اختر مستوى الأهمية...')
            .addOptions([
                { label: 'عادي', value: 'normal',   emoji: '🟢', description: 'طلب عادي' },
                { label: 'عاجل', value: 'urgent',   emoji: '🟡', description: 'يحتاج رد سريع' },
                { label: 'حرج',  value: 'critical', emoji: '🔴', description: 'مستعجل جداً' }
            ])
    )];
}
function createTicketComponents() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket').setLabel('إغلاق التكت').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );
}
function createRatingComponents() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('rate_1').setLabel('⭐').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('rate_2').setLabel('⭐⭐').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('rate_3').setLabel('⭐⭐⭐').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('rate_4').setLabel('⭐⭐⭐⭐').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('rate_5').setLabel('⭐⭐⭐⭐⭐').setStyle(ButtonStyle.Success)
    );
}
function formatDuration(ms) {
    const m = Math.floor(ms/60000), h = Math.floor(m/60), d = Math.floor(h/24);
    if (d > 0) return `${d} يوم و ${h%24} ساعة`;
    if (h > 0) return `${h} ساعة و ${m%60} دقيقة`;
    return `${m} دقيقة`;
}
function storeRating(adminId, adminTag, stars, ticketName, memberTag) {
    if (!db.ratings[adminId]) db.ratings[adminId] = { tag: adminTag, total: 0, count: 0, history: [] };
    const d = db.ratings[adminId];
    d.total += stars; d.count++;
    d.history.push({ stars, ticketName, memberTag, time: Date.now() });
    if (d.history.length > 20) d.history.shift();
    saveData(db);
}
function addPoint(adminId, adminTag) {
    if (!db.points[adminId]) db.points[adminId] = { tag: adminTag, count: 0 };
    db.points[adminId].count++;
    db.points[adminId].tag = adminTag;
    saveData(db);
}
function isAbsent(id) { return db.absents?.includes(id); }
async function sendLog(guild, embed) {
    const ch = guild?.channels?.cache?.get(LOGS_CHANNEL_ID);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}
async function auditLog(guild, action, byId, details) {
    await sendLog(guild, new EmbedBuilder().setColor('#747F8D').setTitle(`🔍 سجل التدقيق — ${action}`)
        .addFields(
            { name: '👤 بواسطة', value: `<@${byId}>`, inline: true },
            { name: '📋 التفاصيل', value: details || '—', inline: false }
        ).setTimestamp()
    );
}

// ─── لوحة التحكم ───
function buildControlEmbed(guild) {
    const open   = guild.channels.cache.filter(c => c.topic && !c.name.startsWith('closed-')).size;
    const closed = guild.channels.cache.filter(c => c.name.startsWith('closed-')).size;
    const sorted = Object.entries(db.points).sort((a, b) => b[1].count - a[1].count);
    const top    = sorted[0] ? `<@${sorted[0][0]}> — ${sorted[0][1].count} تكت` : 'لا يوجد';
    const admins = Object.entries(db.botUsers)
        .map(([id, v]) => `<@${id}> — ${v.role===3?'👑 مالك':v.role===2?'🔱 مشرف':'🛡️ إداري'}`)
        .join('\n') || 'لا يوجد مسجلون';
    return new EmbedBuilder().setColor('#5865F2').setTitle('🎛️ لوحة تحكم البوت الكاملة')
        .setDescription('تحكم بكل إعدادات البوت من هنا مباشرة')
        .addFields(
            { name: '─── 🤖 البوت ───', value: '\u200b', inline: false },
            { name: '📛 الاسم', value: `\`${guild.client.user.username}\``, inline: true },
            { name: '🔵 الحالة', value: `\`${getSetting('status','online')}\``, inline: true },
            { name: '🎮 النشاط', value: `\`${getSetting('activityText','فتح التكتات')}\``, inline: true },
            { name: '─── 🎫 النظام ───', value: '\u200b', inline: false },
            { name: '🔐 حالة النظام', value: getSetting('locked',false) ? '🔴 مقفل' : '🟢 مفتوح', inline: true },
            { name: '⏰ وقت التذكير', value: `${getSetting('reminderHours',2)} ساعة`, inline: true },
            { name: '📂 مفتوحة', value: `\`${open}\``, inline: true },
            { name: '📁 مؤرشفة', value: `\`${closed}\``, inline: true },
            { name: '🏆 أفضل إداري', value: top, inline: false },
            { name: '─── 👥 الإداريون ───', value: admins, inline: false }
        ).setFooter({ text: 'آخر تحديث' }).setTimestamp();
}
function buildControlRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ctrl_rename').setLabel('تغيير الاسم').setStyle(ButtonStyle.Primary).setEmoji('📛'),
            new ButtonBuilder().setCustomId('ctrl_avatar').setLabel('الأفاتار').setStyle(ButtonStyle.Primary).setEmoji('🖼️'),
            new ButtonBuilder().setCustomId('ctrl_status').setLabel('الحالة').setStyle(ButtonStyle.Secondary).setEmoji('🔵'),
            new ButtonBuilder().setCustomId('ctrl_activity').setLabel('النشاط').setStyle(ButtonStyle.Secondary).setEmoji('🎮')
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ctrl_lock')
                .setLabel(getSetting('locked',false)?'فتح النظام':'قفل النظام')
                .setStyle(getSetting('locked',false)?ButtonStyle.Success:ButtonStyle.Danger)
                .setEmoji(getSetting('locked',false)?'🔓':'🔒'),
            new ButtonBuilder().setCustomId('ctrl_reminder').setLabel('وقت التذكير').setStyle(ButtonStyle.Secondary).setEmoji('⏰'),
            new ButtonBuilder().setCustomId('ctrl_refresh').setLabel('تحديث اللوحة').setStyle(ButtonStyle.Secondary).setEmoji('🔄')
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ctrl_add_admin').setLabel('إضافة إداري').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('ctrl_remove_admin').setLabel('إزالة إداري').setStyle(ButtonStyle.Danger).setEmoji('➖'),
            new ButtonBuilder().setCustomId('ctrl_clear_points').setLabel('مسح نقاط').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
            new ButtonBuilder().setCustomId('ctrl_view_stats').setLabel('الإحصائيات').setStyle(ButtonStyle.Secondary).setEmoji('📊')
        )
    ];
}
async function refreshControlPanel(guild) {
    if (!db.controlChannelId) return;
    const ch = guild.channels.cache.get(db.controlChannelId);
    if (!ch) return;
    try {
        const msgs  = await ch.messages.fetch({ limit: 10 });
        const panel = msgs.find(m => m.author.id === client.user.id && m.embeds.length > 0);
        if (panel) await panel.edit({ embeds: [buildControlEmbed(guild)], components: buildControlRows() });
    } catch {}
}

// ===============================================
// 3. الجدولة التلقائية
// ===============================================

function scheduleDailyStats() {
    const now = new Date(), next = new Date();
    next.setHours(24, 0, 0, 0);
    setTimeout(async () => { await sendDailyReport(); setInterval(sendDailyReport, 86400000); }, next - now);
}
async function sendDailyReport() {
    const guild = client.guilds.cache.first(); if (!guild) return;
    const ch    = guild.channels.cache.get(LOGS_CHANNEL_ID); if (!ch) return;
    const open  = guild.channels.cache.filter(c => c.topic && !c.name.startsWith('closed-')).size;
    const arc   = guild.channels.cache.filter(c => c.name.startsWith('closed-')).size;
    const top   = Object.entries(db.points).sort((a,b)=>b[1].count-a[1].count)[0];
    await ch.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('📊 التقرير اليومي')
        .addFields(
            { name: '📂 مفتوحة', value: `\`${open}\``, inline: true },
            { name: '📁 مؤرشفة', value: `\`${arc}\``, inline: true },
            { name: '🏆 أفضل إداري', value: top ? `<@${top[0]}> — ${top[1].count}` : 'لا يوجد', inline: false }
        ).setFooter({ text: 'تقرير يومي تلقائي' }).setTimestamp()
    ]}).catch(()=>{});
}
function scheduleWeeklyReport() {
    const now = new Date(), day = now.getDay(), d = (5-day+7)%7||7;
    const next = new Date(now); next.setDate(now.getDate()+d); next.setHours(20,0,0,0);
    setTimeout(async () => { await sendWeeklyReport(); setInterval(sendWeeklyReport, 604800000); }, next-now);
}
async function sendWeeklyReport() {
    const guild = client.guilds.cache.first(); if (!guild) return;
    const ch    = guild.channels.cache.get(LOGS_CHANNEL_ID); if (!ch) return;
    const sorted = Object.entries(db.points).sort((a,b)=>b[1].count-a[1].count);
    const list   = sorted.slice(0,5).map((e,i)=>{
        const m = i===0?'🥇':i===1?'🥈':i===2?'🥉':`**${i+1}.**`;
        return `${m} <@${e[0]}> — \`${e[1].count}\``;
    }).join('\n')||'لا بيانات';
    const avgR = Object.entries(db.ratings).map(([id,d])=>({id,avg:d.total/d.count})).sort((a,b)=>b.avg-a.avg);
    const topR = avgR[0]?`<@${avgR[0].id}> — ${'⭐'.repeat(Math.round(avgR[0].avg))} (${avgR[0].avg.toFixed(1)})`:'لا يوجد';
    await ch.send({ embeds: [new EmbedBuilder().setColor('#FEE75C').setTitle('📅 التقرير الأسبوعي')
        .addFields(
            { name: '🏆 أكثر نشاطاً', value: list, inline: false },
            { name: '⭐ أعلى تقييم',   value: topR, inline: false }
        ).setFooter({ text: 'تقرير أسبوعي — كل جمعة' }).setTimestamp()
    ]}).catch(()=>{});
}

let statsMessageId = null;
async function updateLiveStats() {
    const guild = client.guilds.cache.first(); if (!guild) return;
    const ch    = guild.channels.cache.get(STATS_CHANNEL_ID); if (!ch) return;
    const open  = guild.channels.cache.filter(c => c.topic && !c.name.startsWith('closed-')).size;
    const arc   = guild.channels.cache.filter(c => c.name.startsWith('closed-')).size;
    const top   = Object.entries(db.points).sort((a,b)=>b[1].count-a[1].count)[0];
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('📊 إحصائيات السيرفر الحية')
        .addFields(
            { name: '📂 مفتوحة', value: `\`${open}\``, inline: true },
            { name: '📁 مؤرشفة', value: `\`${arc}\``, inline: true },
            { name: '👥 إداريون', value: `\`${Object.keys(db.botUsers).length}\``, inline: true },
            { name: '🏆 أفضل إداري', value: top?`<@${top[0]}> — ${top[1].count}`:'لا يوجد', inline: false }
        ).setFooter({ text: 'يتحدث كل ساعة' }).setTimestamp();
    try {
        if (statsMessageId) {
            const msg = await ch.messages.fetch(statsMessageId).catch(()=>null);
            if (msg) { await msg.edit({ embeds: [embed] }); return; }
        }
        const s = await ch.send({ embeds: [embed] });
        statsMessageId = s.id;
    } catch {}
}

async function checkAbandonedTickets() {
    const guild = client.guilds.cache.first(); if (!guild) return;
    const logs  = guild.channels.cache.get(LOGS_CHANNEL_ID);
    for (const [cid, t] of ticketOpenTime.entries()) {
        if (Date.now() - t > 6*3600000) {
            const ch = guild.channels.cache.get(cid);
            if (!ch || ch.name.startsWith('closed-')) { ticketOpenTime.delete(cid); continue; }
            if (logs) await logs.send({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('⚠️ تكت مهجور!')
                .setDescription(`التكت ${ch} مفتوح منذ أكثر من **6 ساعات**!`)
                .addFields({ name: '⏱️ المدة', value: formatDuration(Date.now()-t), inline: true }).setTimestamp()
            ]}).catch(()=>{});
        }
    }
}

async function checkMemberReminders() {
    const guild = client.guilds.cache.first(); if (!guild) return;
    const hours = getSetting('reminderHours', 2);
    for (const [cid, lastTime] of lastMemberMessage.entries()) {
        if (reminderSent.has(cid)) continue;
        if (Date.now() - lastTime < hours*3600000) continue;
        const ch = guild.channels.cache.get(cid);
        if (!ch || ch.name.startsWith('closed-')) { lastMemberMessage.delete(cid); continue; }
        const ownerId = ch.topic; if (!ownerId) continue;
        const owner = await guild.members.fetch(ownerId).catch(()=>null); if (!owner) continue;
        reminderSent.add(cid);
        await owner.send({ embeds: [new EmbedBuilder().setColor('#FEE75C').setTitle('⏰ تذكير — لديك تكت مفتوح!')
            .setDescription(`مرحباً **${owner.user.username}**،\n\nلم يتم الرد على تكتك منذ **${hours} ساعة**.\nالرجاء التفاعل وإلا قد يُغلق.`)
            .addFields({ name: '📋 التكت', value: `\`${ch.name}\``, inline: true }).setTimestamp()
        ]}).catch(()=>{});
        await ch.send({ embeds: [new EmbedBuilder().setColor('#FEE75C')
            .setDescription(`⏰ **تم إرسال تذكير لـ <@${ownerId}> بعد ${hours} ساعة بدون رد.**`).setTimestamp()
        ]}).catch(()=>{});
    }
}

// ===============================================
// 4. الجاهزية
// ===============================================

client.on('ready', () => {
    console.log(`✅ البوت جاهز: ${client.user.tag}`);
    const typeMap = { playing: ActivityType.Playing, watching: ActivityType.Watching, listening: ActivityType.Listening, competing: ActivityType.Competing };
    client.user.setPresence({
        status: getSetting('status','online'),
        activities: [{ name: getSetting('activityText',`فتح التكتات | ${PREFIX}setup`), type: typeMap[getSetting('activityType','watching')]||ActivityType.Watching }]
    });
    scheduleDailyStats();
    scheduleWeeklyReport();
    setInterval(updateLiveStats,    3600000);
    setInterval(checkAbandonedTickets, 3600000);
    setInterval(checkMemberReminders,  1800000);
    setTimeout(updateLiveStats, 5000);
});

// ===============================================
// 5. الأوامر
// ===============================================

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // تتبع آخر رسالة للعضو داخل تكته
    if (message.guild && message.channel.topic === message.author.id) {
        lastMemberMessage.set(message.channel.id, Date.now());
        reminderSent.delete(message.channel.id);
    }

    if (!message.guild || !message.content.startsWith(PREFIX)) return;

    const args   = message.content.slice(PREFIX.length).trim().split(/ +/);
    const cmd    = args.shift();
    const isMgr  = message.member.roles.cache.has(MANAGER_ROLE_ID) || isBotAdmin(message.author.id);
    const isAdm  = message.member.permissions.has(PermissionsBitField.Flags.Administrator) || isBotSupervisor(message.author.id);
    const isOwn  = message.member.permissions.has(PermissionsBitField.Flags.Administrator) || isBotOwner(message.author.id) || message.guild.ownerId === message.author.id;

    // ─── setup ───
    if (cmd === 'setup') {
        if (!isAdm) return message.reply({ content: '❌ لا تملك صلاحية.' });
        try { await message.channel.send({ content: TICKET_IMAGE_URL, components: createSetupComponents() }); await message.delete().catch(()=>{}); }
        catch { await message.reply({ content: '❌ حدث خطأ.' }); }
    }

    // ─── إعداد_تحكم ───
    if (cmd === 'إعداد_تحكم') {
        if (!isOwn) return message.reply({ content: '❌ للمالكين والأدمن فقط.' });
        try {
            const ctrlCh = await message.guild.channels.create({
                name: '🎛️-لوحة-التحكم', type: ChannelType.GuildText,
                permissionOverwrites: [
                    { id: message.guild.id,   deny:  [PermissionsBitField.Flags.ViewChannel] },
                    { id: client.user.id,     allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages] },
                    { id: message.author.id,  allow: [PermissionsBitField.Flags.ViewChannel], deny: [PermissionsBitField.Flags.SendMessages] }
                ]
            });
            await ctrlCh.send({ embeds: [buildControlEmbed(message.guild)], components: buildControlRows() });
            db.controlChannelId = ctrlCh.id; saveData(db);
            await message.reply({ content: `✅ تم إنشاء لوحة التحكم في ${ctrlCh}` });
            await auditLog(message.guild, 'إنشاء لوحة التحكم', message.author.id, `القناة: ${ctrlCh.name}`);
        } catch (e) { console.error(e); await message.reply({ content: '❌ فشل إنشاء لوحة التحكم.' }); }
    }

    // ─── إحصائيات ───
    if (cmd === 'إحصائيات') {
        if (!isAdm) return message.reply({ content: '❌ للمسؤولين فقط.' });
        const tid = message.mentions.users.first()?.id ?? (args[0]&&/^\d+$/.test(args[0])?args[0]:null);
        if (!tid) return message.reply({ content: '❌ الاستخدام: `-إحصائيات @الاداري` أو بالـ ID' });
        let u; try { u = await client.users.fetch(tid); } catch { return message.reply({ content: '❌ المستخدم غير موجود.' }); }
        const d = db.ratings[tid];
        if (!d||!d.count) return message.reply({ embeds: [new EmbedBuilder().setColor('#ED4245').setDescription(`❌ لا توجد تقييمات لـ **${u.tag}**`)] });
        const avg  = (d.total/d.count).toFixed(1);
        const hist = d.history.slice(-5).reverse().map((r,i)=>
            `**${i+1}.** ${'⭐'.repeat(r.stars)} — \`${r.ticketName}\` | ${r.memberTag} | <t:${Math.floor(r.time/1000)}:R>`
        ).join('\n');
        await message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2')
            .setAuthor({ name: `إحصائيات ${u.tag}`, iconURL: u.displayAvatarURL({dynamic:true}) })
            .setThumbnail(u.displayAvatarURL({dynamic:true,size:256})).setTitle('📊 إحصائيات الإداري')
            .addFields(
                { name: '👤 الإداري',     value: `<@${tid}>`, inline: true },
                { name: '🎫 التقييمات',  value: `\`${d.count}\``, inline: true },
                { name: '⭐ المتوسط',     value: `\`${avg}/5\``, inline: true },
                { name: '🕐 آخر 5 تقييمات', value: hist||'لا يوجد', inline: false }
            ).setTimestamp()
        ]});
    }

    // ─── نقاطي ───
    if (cmd === 'نقاطي') {
        if (!isMgr) return message.reply({ content: '❌ للإداريين فقط.' });
        const p = db.points[message.author.id];
        if (!p) return message.reply({ embeds: [new EmbedBuilder().setColor('#ED4245').setDescription('❌ لا توجد نقاط مسجلة لك بعد.')] });
        const rank = Object.entries(db.points).sort((a,b)=>b[1].count-a[1].count).findIndex(([id])=>id===message.author.id)+1;
        await message.reply({ embeds: [new EmbedBuilder().setColor('#FEE75C').setTitle('🏅 نقاطك')
            .setThumbnail(message.author.displayAvatarURL({dynamic:true}))
            .addFields(
                { name: '🎫 إجمالي التكتات', value: `\`${p.count}\``, inline: true },
                { name: '🏆 ترتيبك',          value: `\`#${rank}\``, inline: true }
            ).setTimestamp()
        ]});
    }

    // ─── نقاط ───
    if (cmd === 'نقاط') {
        if (!isMgr) return message.reply({ content: '❌ للإداريين فقط.' });
        const sorted = Object.entries(db.points).sort((a,b)=>b[1].count-a[1].count);
        if (!sorted.length) return message.reply({ content: '❌ لا توجد نقاط بعد.' });
        const list = sorted.map((e,i)=>{
            const m = i===0?'🥇':i===1?'🥈':i===2?'🥉':`**${i+1}.**`;
            return `${m} <@${e[0]}> — \`${e[1].count}\` تكت`;
        }).join('\n');
        await message.reply({ embeds: [new EmbedBuilder().setColor('#FEE75C').setTitle('🏆 لوحة النقاط').setDescription(list).setTimestamp()] });
    }

    // ─── تكتي ───
    if (cmd === 'تكتي') {
        const t = message.guild.channels.cache.find(c=>c.topic===message.author.id&&!c.name.startsWith('closed-'));
        if (!t) return message.reply({ embeds: [new EmbedBuilder().setColor('#ED4245').setDescription('❌ ليس لديك تكت مفتوح.')] });
        const ot = ticketOpenTime.get(t.id), cl = ticketClaimer.get(t.id);
        await message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('🎫 تكتك الحالي')
            .addFields(
                { name: '📋 القناة', value: `${t}`, inline: true },
                { name: '⏱️ المدة',  value: ot?formatDuration(Date.now()-ot):'غير معروف', inline: true },
                { name: '🛡️ الإداري', value: cl?`<@${cl.adminId}>`:'لم يُتولى بعد', inline: true }
            ).setTimestamp()
        ]});
    }

    // ─── إلغاء ───
    if (cmd === 'إلغاء') {
        const entry = [...pendingTickets.entries()].find(([,v])=>v.userId===message.author.id);
        if (!entry) return message.reply({ content: '❌ ليس لديك طلب معلق.' });
        const [msgId] = entry; pendingTickets.delete(msgId);
        const rc = message.guild.channels.cache.get(REQUESTS_CHANNEL_ID);
        if (rc) { const m = await rc.messages.fetch(msgId).catch(()=>null); if (m) await m.edit({ embeds: [new EmbedBuilder().setColor('#747F8D').setTitle('🚫 ألغى العضو طلبه').setDescription(`${message.author} ألغى طلبه.`).setTimestamp()], components: [] }).catch(()=>{}); }
        await message.reply({ embeds: [new EmbedBuilder().setColor('#57F287').setDescription('✅ تم إلغاء طلبك.')] });
    }

    // ─── ترك ───
    if (cmd === 'ترك') {
        if (!isMgr) return message.reply({ content: '❌ للإداريين فقط.' });
        const ch = message.channel, oid = ch.topic, cl = ticketClaimer.get(ch.id);
        if (!oid||!cl||cl.adminId!==message.author.id) return message.reply({ content: '❌ لا يمكنك استخدام هذا الأمر هنا.' });
        ticketClaimer.delete(ch.id);
        await ch.permissionOverwrites.edit(message.guild.roles.cache.get(MANAGER_ROLE_ID), { ViewChannel:true, SendMessages:true }).catch(()=>{});
        await ch.permissionOverwrites.delete(message.author.id).catch(()=>{});
        await ch.send({ embeds: [new EmbedBuilder().setColor('#FEE75C').setDescription(`⚠️ **${message.author} ترك هذا التكت.** سيُعاد للإداريين.`)] });
        await sendLog(message.guild, new EmbedBuilder().setColor('#FEE75C').setTitle('↩️ إداري ترك تكتاً')
            .addFields({ name: '🛡️ الإداري', value: `${message.author}`, inline:true }, { name: '📋 التكت', value: `${ch}`, inline:true }, { name: '👤 صاحب التكت', value: `<@${oid}>`, inline:true }).setTimestamp()
        );
        const rc = message.guild.channels.cache.get(REQUESTS_CHANNEL_ID);
        if (rc) await rc.send({ embeds: [new EmbedBuilder().setColor('#FEE75C').setTitle('🔁 تكت يحتاج إداري جديد').setDescription(`التكت ${ch} تُرك ويحتاج من يتولاه.`).addFields({ name: '👤 صاحب التكت', value: `<@${oid}>`, inline:true }).setTimestamp()],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`accept_ticket_${ch.id}_${oid}`).setLabel('تولي التكت').setStyle(ButtonStyle.Success).setEmoji('✋'))] });
        await message.delete().catch(()=>{});
    }

    // ─── إضافة ───
    if (cmd === 'إضافة') {
        if (!isMgr) return message.reply({ content: '❌ للإداريين فقط.' });
        if (!message.channel.topic) return message.reply({ content: '❌ هذه القناة ليست تكت.' });
        const target = message.mentions.members.first();
        if (!target) return message.reply({ content: '❌ الاستخدام: `-إضافة @شخص`' });
        await message.channel.permissionOverwrites.edit(target.id, { ViewChannel:true, SendMessages:true });
        await message.channel.send({ embeds: [new EmbedBuilder().setColor('#57F287').setDescription(`✅ تمت إضافة ${target} بواسطة ${message.author}.`)] });
        await sendLog(message.guild, new EmbedBuilder().setColor('#57F287').setTitle('➕ إضافة عضو')
            .addFields({ name: '🛡️ الإداري', value: `${message.author}`, inline:true }, { name: '👤 المضاف', value: `${target}`, inline:true }, { name: '📋 التكت', value: `${message.channel}`, inline:true }).setTimestamp()
        );
        await message.delete().catch(()=>{});
    }

    // ─── نقل ───
    if (cmd === 'نقل') {
        if (!isMgr) return message.reply({ content: '❌ للإداريين فقط.' });
        const ch = message.channel; if (!ch.topic) return message.reply({ content: '❌ هذه القناة ليست تكت.' });
        const target = message.mentions.members.first();
        if (!target) return message.reply({ content: '❌ الاستخدام: `-نقل @إداري`' });
        if (!target.roles.cache.has(MANAGER_ROLE_ID) && !isBotAdmin(target.id)) return message.reply({ content: '❌ الشخص المذكور ليس إدارياً.' });
        const old = ticketClaimer.get(ch.id);
        ticketClaimer.set(ch.id, { adminId: target.id, adminTag: target.user.tag });
        if (old) await ch.permissionOverwrites.delete(old.adminId).catch(()=>{});
        await ch.permissionOverwrites.edit(target.id, { ViewChannel:true, SendMessages:true });
        await ch.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setDescription(`🔄 **نُقل التكت من ${message.author} إلى ${target}.**`)] });
        await sendLog(message.guild, new EmbedBuilder().setColor('#5865F2').setTitle('🔄 نقل تكت')
            .addFields({ name: '↩️ من', value: `${message.author}`, inline:true }, { name: '➡️ إلى', value: `${target}`, inline:true }, { name: '📋 التكت', value: `${ch}`, inline:true }).setTimestamp()
        );
        await message.delete().catch(()=>{});
    }

    // ─── تعليق ───
    if (cmd === 'تعليق') {
        if (!isMgr) return message.reply({ content: '❌ للإداريين فقط.' });
        if (!message.channel.topic) return message.reply({ content: '❌ هذه القناة ليست تكت.' });
        const text = args.join(' '); if (!text) return message.reply({ content: '❌ الاستخدام: `-تعليق النص`' });
        await message.delete().catch(()=>{});
        await message.channel.send({ embeds: [new EmbedBuilder().setColor('#747F8D').setTitle('📝 ملاحظة داخلية').setDescription(text).setFooter({ text: `بواسطة ${message.author.tag} — مرئي للإداريين فقط` }).setTimestamp()] });
    }

    // ─── قفل ───
    if (cmd === 'قفل') {
        if (!isAdm) return message.reply({ content: '❌ للمسؤولين فقط.' });
        const reason = args.join(' ')||'لا يوجد سبب'; setSetting('locked', true);
        await message.reply({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('🔒 تم قفل النظام').addFields({ name: '💬 السبب', value: reason }).setTimestamp()] });
        await sendLog(message.guild, new EmbedBuilder().setColor('#ED4245').setTitle('🔒 النظام مُقفل').addFields({ name: '👤 بواسطة', value: `${message.author}`, inline:true }, { name: '💬 السبب', value: reason }).setTimestamp());
        await refreshControlPanel(message.guild);
    }

    // ─── فتح ───
    if (cmd === 'فتح') {
        if (!isAdm) return message.reply({ content: '❌ للمسؤولين فقط.' });
        setSetting('locked', false);
        await message.reply({ embeds: [new EmbedBuilder().setColor('#57F287').setTitle('🔓 تم فتح النظام').setTimestamp()] });
        await sendLog(message.guild, new EmbedBuilder().setColor('#57F287').setTitle('🔓 النظام مفتوح').addFields({ name: '👤 بواسطة', value: `${message.author}`, inline:true }).setTimestamp());
        await refreshControlPanel(message.guild);
    }

    // ─── تذكير ───
    if (cmd === 'تذكير') {
        if (!isMgr) return message.reply({ content: '❌ للإداريين فقط.' });
        const h = parseInt(args[0]);
        if (!h||h<1||h>72) return message.reply({ content: '❌ الاستخدام: `-تذكير 2` (من 1 إلى 72)' });
        setSetting('reminderHours', h);
        await message.reply({ embeds: [new EmbedBuilder().setColor('#57F287').setDescription(`✅ وقت التذكير → **${h} ساعة**`)] });
    }

    // ─── غائب / متاح ───
    if (cmd === 'غائب') {
        if (!isMgr) return message.reply({ content: '❌ للإداريين فقط.' });
        if (!db.absents) db.absents = [];
        if (!db.absents.includes(message.author.id)) { db.absents.push(message.author.id); saveData(db); }
        await message.reply({ embeds: [new EmbedBuilder().setColor('#ED4245').setDescription(`🔴 **${message.author.username}** في وضع **غائب**.`)] });
    }
    if (cmd === 'متاح') {
        if (!isMgr) return message.reply({ content: '❌ للإداريين فقط.' });
        if (db.absents) { db.absents = db.absents.filter(id=>id!==message.author.id); saveData(db); }
        await message.reply({ embeds: [new EmbedBuilder().setColor('#57F287').setDescription(`🟢 **${message.author.username}** الآن **متاح**.`)] });
    }

    // ─── حالة ───
    if (cmd === 'حالة') {
        if (!isMgr) return message.reply({ content: '❌ للإداريين فقط.' });
        const sub = args[0]?.toLowerCase(), text = args.slice(1).join(' ');
        const SM  = { online:'online', idle:'idle', dnd:'dnd', invisible:'invisible', offline:'invisible' };
        const AM  = { playing:ActivityType.Playing, watching:ActivityType.Watching, listening:ActivityType.Listening, competing:ActivityType.Competing };
        if (SM[sub]) {
            setSetting('status', SM[sub]); await client.user.setStatus(SM[sub]);
            return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setDescription(`✅ الحالة → \`${sub}\``)] });
        }
        if (AM[sub]) {
            if (!text) return message.reply({ content: '❌ أدخل نص النشاط.' });
            setSetting('activityType', sub); setSetting('activityText', text);
            await client.user.setActivity(text, { type: AM[sub] });
            return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setDescription(`✅ النشاط → **${sub}** | \`${text}\``)] });
        }
        return message.reply({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('📖 -حالة')
            .addFields(
                { name: '🟢 الحالات', value: '`online` `idle` `dnd` `invisible`', inline: true },
                { name: '🎮 الأنشطة', value: '`playing` `watching` `listening` `competing` + نص', inline: true }
            )
        ]});
    }

    // ─── مساعدة ───
    if (cmd === 'مساعدة') {
        const f = [];
        f.push({ name: '👤 أوامر الأعضاء', value: '`-تكتي` — حالة تكتك\n`-إلغاء` — إلغاء طلب معلق', inline: false });
        if (isMgr) f.push({ name: '🛡️ أوامر الإداريين', value: '`-ترك` `-إضافة @شخص` `-نقل @إداري` `-تعليق نص`\n`-تذكير X` `-غائب` `-متاح` `-نقاط` `-نقاطي`\n`-حالة [نوع] [نص]`', inline: false });
        if (isAdm) f.push({ name: '👑 أوامر المسؤولين', value: '`-setup` `-قفل سبب` `-فتح`\n`-إحصائيات @إداري` `-إعداد_تحكم`', inline: false });
        await message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('📖 قائمة الأوامر').addFields(...f).setFooter({ text: 'الأوامر المتاحة حسب صلاحياتك' }).setTimestamp()] });
    }
});

// ===============================================
// 6. التفاعلات
// ===============================================

client.on('interactionCreate', async interaction => {
  try {

    // ── فتح القائمة ──
    if (interaction.isButton() && interaction.customId === 'open_ticket_menu') {
        if (getSetting('locked', false))
            return interaction.reply({ content: '🔒 نظام التكتات مغلق مؤقتاً.', flags: MessageFlags.Ephemeral });
        if (!firstTicketSet.has(interaction.user.id)) {
            firstTicketSet.add(interaction.user.id);
            await interaction.user.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('👋 مرحباً في نظام التكتات!')
                .setDescription(`أهلاً **${interaction.user.username}**!\n\n1️⃣ اختر نوع الخدمة\n2️⃣ حدد مستوى الأهمية\n3️⃣ املأ التفاصيل\n4️⃣ انتظر القبول\n\n📌 \`-تكتي\` لحالة تكتك`)
            ]}).catch(()=>{});
        }
        return interaction.reply({ content: '👇 اختر نوع الخدمة:', components: createSelectMenuComponents(), flags: MessageFlags.Ephemeral });
    }

    // ── اختيار الخدمة ──
    if (interaction.isStringSelectMenu() && interaction.customId === 'service_select_menu') {
        return interaction.update({
            content: `✅ اخترت: **${SERVICE_OPTIONS[interaction.values[0]].label}**\n\n👇 حدد مستوى الأهمية:`,
            components: [
                ...createPriorityComponents(),
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`back_service_${interaction.values[0]}`).setLabel('تغيير الخدمة').setStyle(ButtonStyle.Secondary).setEmoji('↩️')
                )
            ]
        });
    }

    // ── اختيار الأولوية → Modal ──
    if (interaction.isStringSelectMenu() && interaction.customId === 'priority_select_menu') {
        const backBtn    = interaction.message.components[1]?.components[0];
        const serviceKey = backBtn?.customId?.replace('back_service_','') || 'general_ticket';
        const sInfo      = SERVICE_OPTIONS[serviceKey];
        return interaction.showModal(new ModalBuilder()
            .setCustomId(`ticket_modal_${serviceKey}_${interaction.values[0]}`)
            .setTitle(`${sInfo.emoji} ${sInfo.label}`)
            .addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_title').setLabel('عنوان الطلب').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_description').setLabel('وصف الطلب').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000))
            )
        );
    }

    // ── رجوع ──
    if (interaction.isButton() && interaction.customId.startsWith('back_service_'))
        return interaction.update({ content: '👇 اختر نوع الخدمة:', components: createSelectMenuComponents() });

    // ── Modal التكت ──
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_modal_')) {
        const parts = interaction.customId.replace('ticket_modal_','').split('_');
        const pKey  = parts.pop(), sKey = parts.join('_');
        return sendTicketRequest(interaction, sKey, pKey,
            interaction.fields.getTextInputValue('ticket_title'),
            interaction.fields.getTextInputValue('ticket_description')
        );
    }

    // ── قبول التكت ──
    if (interaction.isButton() && interaction.customId.startsWith('accept_ticket_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!interaction.member.roles.cache.has(MANAGER_ROLE_ID) && !isBotAdmin(interaction.user.id) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return interaction.editReply({ content: '❌ للإداريين فقط.' });
        if (isAbsent(interaction.user.id))
            return interaction.editReply({ content: '❌ أنت في وضع غائب! اكتب `-متاح` أولاً.' });
        const parts  = interaction.customId.split('_');
        const msgId  = parts[2], userId = parts[3];
        const data   = pendingTickets.get(msgId);
        if (!data) {
            const ch = interaction.guild.channels.cache.get(msgId);
            if (!ch) return interaction.editReply({ content: '❌ القناة غير موجودة.' });
            ticketClaimer.set(ch.id, { adminId: interaction.user.id, adminTag: interaction.user.tag });
            await ch.permissionOverwrites.edit(interaction.guild.roles.cache.get(MANAGER_ROLE_ID), { ViewChannel: false });
            await ch.permissionOverwrites.edit(interaction.user.id, { ViewChannel: true, SendMessages: true });
            await ch.send({ embeds: [new EmbedBuilder().setColor('#57F287').setDescription(`✋ **تم التولي بواسطة ${interaction.user}**`)] });
            await interaction.message.edit({ components: [] }).catch(()=>{});
            return interaction.editReply({ content: '✅ تم التولي.' });
        }
        pendingTickets.delete(msgId);
        await interaction.message.edit({ embeds: [new EmbedBuilder().setColor('#57F287').setTitle('✅ تم القبول').setDescription(`قبل ${interaction.user} الطلب.`).setTimestamp()], components: [] }).catch(()=>{});
        await openTicket(interaction, data, interaction.user);
    }

    // ── رفض التكت ──
    if (interaction.isButton() && interaction.customId.startsWith('reject_ticket_')) {
        const msgId = interaction.customId.split('_')[2];
        if (!pendingTickets.has(msgId)) return interaction.reply({ content: '❌ الطلب لم يعد متاحاً.', flags: MessageFlags.Ephemeral });
        return interaction.showModal(new ModalBuilder().setCustomId(`reject_modal_${msgId}`).setTitle('سبب الرفض')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reject_reason').setLabel('سبب الرفض').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(300)))
        );
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('reject_modal_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msgId  = interaction.customId.replace('reject_modal_','');
        const reason = interaction.fields.getTextInputValue('reject_reason');
        const data   = pendingTickets.get(msgId);
        if (!data) return interaction.editReply({ content: '❌ انتهت صلاحية الطلب.' });
        pendingTickets.delete(msgId);
        await interaction.message.edit({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('❌ مرفوض').setDescription(`رفض ${interaction.user}.\n**السبب:** ${reason}`).setTimestamp()], components: [] }).catch(()=>{});
        const member = await interaction.guild.members.fetch(data.userId).catch(()=>null);
        if (member) await member.send({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('❌ تم رفض طلبك')
            .setDescription(`مرحباً **${member.user.username}**،\nتم رفض طلبك.`)
            .addFields({ name: '📌 العنوان', value: data.title }, { name: '💬 السبب', value: reason }).setTimestamp()
        ]}).catch(()=>{});
        await sendLog(interaction.guild, new EmbedBuilder().setColor('#ED4245').setTitle('❌ طلب مرفوض')
            .addFields({ name: '👤 العضو', value: `<@${data.userId}>`, inline:true }, { name: '🛡️ بواسطة', value: `${interaction.user}`, inline:true }, { name: '💬 السبب', value: reason }).setTimestamp()
        );
        await interaction.editReply({ content: '✅ تم الرفض وإبلاغ العضو.' });
    }

    // ── إغلاق ──
    if (interaction.isButton() && interaction.customId === 'close_ticket') return handleTicketClose(interaction);

    // ── التقييم ──
    if (interaction.isButton() && interaction.customId.startsWith('rate_')) return handleRating(interaction);

    // ── ملاحظة DM ──
    if (interaction.isButton() && interaction.customId.startsWith('dm_note_')) {
        return interaction.showModal(new ModalBuilder().setCustomId(`note_modal_${interaction.customId.split('_').pop()}`).setTitle('📝 ملاحظة للإدارة')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('note_text').setLabel('ملاحظتك').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)))
        );
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('note_modal_')) {
        const cid  = interaction.customId.replace('note_modal_','');
        const note = interaction.fields.getTextInputValue('note_text');
        await interaction.reply({ embeds: [new EmbedBuilder().setColor('#57F287').setDescription('✅ تم إرسال ملاحظتك! شكراً 😊')], flags: MessageFlags.Ephemeral });
        await sendLog(client.guilds.cache.first(), new EmbedBuilder().setColor('#5865F2').setTitle('📝 ملاحظة عضو')
            .addFields({ name: '👤 العضو', value: `${interaction.user}`, inline:true }, { name: '📋 التكت', value: `\`${cid}\``, inline:true }, { name: '💬 الملاحظة', value: note }).setTimestamp()
        );
    }

    // ════════════════════════════════════
    // لوحة التحكم — أزرار
    // ════════════════════════════════════

    if (interaction.isButton() && interaction.customId.startsWith('ctrl_')) {
        if (!hasPermission(interaction.member, 2))
            return interaction.reply({ content: '❌ لا تملك صلاحية استخدام لوحة التحكم.', flags: MessageFlags.Ephemeral });
        const id = interaction.customId;

        if (id === 'ctrl_rename')
            return interaction.showModal(new ModalBuilder().setCustomId('ctrl_modal_rename').setTitle('تغيير اسم البوت')
                .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('new_name').setLabel('الاسم الجديد').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32)))
            );

        if (id === 'ctrl_avatar')
            return interaction.showModal(new ModalBuilder().setCustomId('ctrl_modal_avatar').setTitle('تغيير أفاتار البوت')
                .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('avatar_url').setLabel('رابط الصورة (PNG/JPG/WebP)').setStyle(TextInputStyle.Short).setRequired(true)))
            );

        if (id === 'ctrl_status')
            return interaction.reply({ content: '🔵 اختر الحالة:', flags: MessageFlags.Ephemeral, components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ctrl_set_status_online').setLabel('أونلاين').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('ctrl_set_status_idle').setLabel('غير نشط').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('ctrl_set_status_dnd').setLabel('لا تزعج').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('ctrl_set_status_invisible').setLabel('مخفي').setStyle(ButtonStyle.Secondary)
            )]});

        if (id.startsWith('ctrl_set_status_')) {
            const st = id.replace('ctrl_set_status_','');
            setSetting('status', st); await client.user.setStatus(st);
            await interaction.update({ content: `✅ الحالة → \`${st}\``, components: [] });
            await refreshControlPanel(interaction.guild);
            await auditLog(interaction.guild, 'تغيير الحالة', interaction.user.id, `الحالة: ${st}`);
            return;
        }

        if (id === 'ctrl_activity')
            return interaction.showModal(new ModalBuilder().setCustomId('ctrl_modal_activity').setTitle('تغيير نشاط البوت')
                .addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('activity_type').setLabel('النوع: playing/watching/listening').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('activity_text').setLabel('النص').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(128))
                )
            );

        if (id === 'ctrl_lock') {
            const locked = getSetting('locked', false); setSetting('locked', !locked);
            await interaction.reply({ content: `✅ النظام: ${!locked?'🔒 مقفل':'🔓 مفتوح'}`, flags: MessageFlags.Ephemeral });
            await refreshControlPanel(interaction.guild);
            await auditLog(interaction.guild, locked?'فتح النظام':'قفل النظام', interaction.user.id, '');
            return;
        }

        if (id === 'ctrl_reminder')
            return interaction.showModal(new ModalBuilder().setCustomId('ctrl_modal_reminder').setTitle('وقت التذكير')
                .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hours').setLabel('عدد الساعات (1-72)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)))
            );

        if (id === 'ctrl_refresh') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await refreshControlPanel(interaction.guild);
            return interaction.editReply({ content: '✅ تم تحديث اللوحة.' });
        }

        if (id === 'ctrl_add_admin')
            return interaction.showModal(new ModalBuilder().setCustomId('ctrl_modal_add_admin').setTitle('إضافة إداري للبوت')
                .addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('admin_id').setLabel('ID العضو').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('admin_role').setLabel('المستوى: 1=إداري / 2=مشرف / 3=مالك').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1))
                )
            );

        if (id === 'ctrl_remove_admin')
            return interaction.showModal(new ModalBuilder().setCustomId('ctrl_modal_remove_admin').setTitle('إزالة إداري')
                .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('admin_id').setLabel('ID العضو').setStyle(TextInputStyle.Short).setRequired(true)))
            );

        if (id === 'ctrl_clear_points')
            return interaction.showModal(new ModalBuilder().setCustomId('ctrl_modal_clear_points').setTitle('مسح نقاط')
                .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('admin_id').setLabel('ID الإداري أو "all" للكل').setStyle(TextInputStyle.Short).setRequired(true)))
            );

        if (id === 'ctrl_view_stats') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const g    = interaction.guild;
            const open = g.channels.cache.filter(c=>c.topic&&!c.name.startsWith('closed-')).size;
            const arc  = g.channels.cache.filter(c=>c.name.startsWith('closed-')).size;
            const tot  = Object.values(db.points).reduce((s,d)=>s+d.count, 0);
            const rats = Object.values(db.ratings).reduce((s,d)=>s+d.count, 0);
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('📊 إحصائيات كاملة')
                .addFields(
                    { name: '📂 مفتوحة', value: `\`${open}\``, inline:true },
                    { name: '📁 مؤرشفة', value: `\`${arc}\``, inline:true },
                    { name: '🎫 إجمالي التكتات', value: `\`${tot}\``, inline:true },
                    { name: '⭐ إجمالي التقييمات', value: `\`${rats}\``, inline:true }
                ).setTimestamp()
            ]});
        }
    }

    // ════════════════════════════════════
    // لوحة التحكم — Modals
    // ════════════════════════════════════

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ctrl_modal_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const mid = interaction.customId.replace('ctrl_modal_','');

        if (mid === 'rename') {
            const name = interaction.fields.getTextInputValue('new_name');
            await client.user.setUsername(name).catch(e=>{ return interaction.editReply({ content: `❌ فشل: ${e.message}` }); });
            await interaction.editReply({ content: `✅ الاسم → \`${name}\`` });
            await auditLog(interaction.guild, 'تغيير الاسم', interaction.user.id, `الاسم: ${name}`);
            await refreshControlPanel(interaction.guild);
        }

        if (mid === 'avatar') {
            const url = interaction.fields.getTextInputValue('avatar_url');
            await client.user.setAvatar(url).catch(()=>{ return interaction.editReply({ content: '❌ فشل. تأكد من صحة الرابط.' }); });
            await interaction.editReply({ content: '✅ تم تغيير الأفاتار.' });
            await auditLog(interaction.guild, 'تغيير الأفاتار', interaction.user.id, url);
        }

        if (mid === 'activity') {
            const type = interaction.fields.getTextInputValue('activity_type').toLowerCase();
            const text = interaction.fields.getTextInputValue('activity_text');
            const map  = { playing:ActivityType.Playing, watching:ActivityType.Watching, listening:ActivityType.Listening, competing:ActivityType.Competing };
            if (!map[type]) return interaction.editReply({ content: '❌ نوع غير صحيح: playing/watching/listening/competing' });
            setSetting('activityType', type); setSetting('activityText', text);
            await client.user.setActivity(text, { type: map[type] });
            await interaction.editReply({ content: `✅ النشاط → **${type}** | \`${text}\`` });
            await refreshControlPanel(interaction.guild);
            await auditLog(interaction.guild, 'تغيير النشاط', interaction.user.id, `${type}: ${text}`);
        }

        if (mid === 'reminder') {
            const h = parseInt(interaction.fields.getTextInputValue('hours'));
            if (!h||h<1||h>72) return interaction.editReply({ content: '❌ أدخل رقماً من 1 إلى 72.' });
            setSetting('reminderHours', h);
            await interaction.editReply({ content: `✅ وقت التذكير → **${h} ساعة**` });
            await refreshControlPanel(interaction.guild);
        }

        if (mid === 'add_admin') {
            const rawId = interaction.fields.getTextInputValue('admin_id').replace(/[<@!>]/g,'');
            const level = parseInt(interaction.fields.getTextInputValue('admin_role'));
            if (![1,2,3].includes(level)) return interaction.editReply({ content: '❌ المستوى يجب أن يكون 1 أو 2 أو 3.' });
            let u; try { u = await client.users.fetch(rawId); } catch { return interaction.editReply({ content: '❌ المستخدم غير موجود.' }); }
            db.botUsers[u.id] = { tag: u.tag, role: level }; saveData(db);
            const lbl = level===3?'👑 مالك':level===2?'🔱 مشرف':'🛡️ إداري';
            if (db.controlChannelId) {
                const cc = interaction.guild.channels.cache.get(db.controlChannelId);
                if (cc) await cc.permissionOverwrites.edit(u.id, { ViewChannel:true, SendMessages:false }).catch(()=>{});
            }
            await interaction.editReply({ content: `✅ تم تسجيل **${u.tag}** كـ ${lbl}` });
            await auditLog(interaction.guild, 'إضافة إداري', interaction.user.id, `${u.tag} — ${lbl}`);
            await refreshControlPanel(interaction.guild);
        }

        if (mid === 'remove_admin') {
            const rawId = interaction.fields.getTextInputValue('admin_id').replace(/[<@!>]/g,'');
            if (!db.botUsers[rawId]) return interaction.editReply({ content: '❌ هذا الشخص غير مسجل.' });
            const tag = db.botUsers[rawId].tag; delete db.botUsers[rawId]; saveData(db);
            if (db.controlChannelId) {
                const cc = interaction.guild.channels.cache.get(db.controlChannelId);
                if (cc) await cc.permissionOverwrites.delete(rawId).catch(()=>{});
            }
            await interaction.editReply({ content: `✅ تم إزالة **${tag}** من البوت.` });
            await auditLog(interaction.guild, 'إزالة إداري', interaction.user.id, `المُزال: ${tag}`);
            await refreshControlPanel(interaction.guild);
        }

        if (mid === 'clear_points') {
            const raw = interaction.fields.getTextInputValue('admin_id').replace(/[<@!>]/g,'');
            if (raw === 'all') {
                db.points = {}; saveData(db);
                await interaction.editReply({ content: '✅ تم مسح نقاط الجميع.' });
                await auditLog(interaction.guild, 'مسح كل النقاط', interaction.user.id, 'الكل');
            } else {
                if (!db.points[raw]) return interaction.editReply({ content: '❌ لا توجد نقاط لهذا الإداري.' });
                const tag = db.points[raw].tag; delete db.points[raw]; saveData(db);
                await interaction.editReply({ content: `✅ تم مسح نقاط **${tag}**` });
                await auditLog(interaction.guild, 'مسح نقاط', interaction.user.id, `الإداري: ${tag}`);
            }
            await refreshControlPanel(interaction.guild);
        }
    }

  } catch (err) {
    if (err?.code === 10062) return;
    console.error('Interaction error:', err);
  }
});

// ===============================================
// 7. إرسال طلب التكت
// ===============================================

async function sendTicketRequest(interaction, serviceKey, priorityKey, title, description) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild  = interaction.guild, member = interaction.member;
    const sInfo  = SERVICE_OPTIONS[serviceKey]  || SERVICE_OPTIONS.general_ticket;
    const pInfo  = PRIORITY_OPTIONS[priorityKey] || PRIORITY_OPTIONS.normal;

    const existing   = guild.channels.cache.find(c=>c.topic===member.user.id&&!c.name.startsWith('closed-'));
    if (existing)    return interaction.editReply({ content: `❌ لديك تكت مفتوح: ${existing}` });
    const hasPending = [...pendingTickets.values()].some(v=>v.userId===member.user.id);
    if (hasPending)  return interaction.editReply({ content: '❌ لديك طلب معلق. اكتب `-إلغاء` لإلغائه.' });

    const reqCh = guild.channels.cache.get(REQUESTS_CHANNEL_ID);
    if (!reqCh)  return interaction.editReply({ content: '❌ روم الطلبات غير موجود.' });

    try {
        const reqMsg = await reqCh.send({
            content: `<@&${MANAGER_ROLE_ID}>`,
            embeds: [new EmbedBuilder().setColor(pInfo.color)
                .setAuthor({ name: `طلب جديد — ${member.user.tag}`, iconURL: member.user.displayAvatarURL({dynamic:true}) })
                .setTitle(`${sInfo.emoji} ${sInfo.label}`)
                .setThumbnail(member.user.displayAvatarURL({dynamic:true,size:256}))
                .addFields(
                    { name: '👤 العضو', value: `${member}`, inline:true },
                    { name: `${pInfo.emoji} الأولوية`, value: pInfo.label, inline:true },
                    { name: '🕐 وقت الطلب', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline:true },
                    { name: '📌 العنوان', value: title, inline:false },
                    { name: '📝 التفاصيل', value: description, inline:false }
                ).setFooter({ text: 'استخدم الأزرار للقبول أو الرفض' }).setTimestamp()
            ]
        });
        await reqMsg.edit({ components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`accept_ticket_${reqMsg.id}_${member.user.id}`).setLabel('قبول').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId(`reject_ticket_${reqMsg.id}_${member.user.id}`).setLabel('رفض').setStyle(ButtonStyle.Danger).setEmoji('❌')
        )]});
        pendingTickets.set(reqMsg.id, { userId: member.user.id, serviceKey, priorityKey, title, description, guildId: guild.id, requestedAt: Date.now() });

        // تنبيه 15 دقيقة
        setTimeout(async () => {
            if (!pendingTickets.has(reqMsg.id)) return;
            const logs = guild.channels.cache.get(LOGS_CHANNEL_ID);
            if (logs) await logs.send({ content: `<@&${MANAGER_ROLE_ID}>`, embeds: [new EmbedBuilder().setColor('#ED4245')
                .setTitle('⏰ طلب لم يُقبل!').setDescription(`طلب ${member} لم يُقبل منذ **15 دقيقة**!`)
                .addFields({ name: '📌 العنوان', value: title }).setTimestamp()
            ]}).catch(()=>{});
        }, 15*60*1000);

        await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#57F287').setTitle('✅ تم إرسال طلبك!')
            .setDescription(`طلبك وصل للإدارة.\n\n⏱️ متوسط الرد: دقائق معدودة\n📌 \`-تكتي\` لمعرفة الحالة\n🚫 \`-إلغاء\` لإلغاء الطلب`)
        ]});
        await sendLog(guild, new EmbedBuilder().setColor(pInfo.color).setTitle('📥 طلب تكت جديد')
            .addFields(
                { name: '👤 العضو', value: `${member}`, inline:true },
                { name: '🛎️ الخدمة', value: sInfo.label, inline:true },
                { name: `${pInfo.emoji} الأولوية`, value: pInfo.label, inline:true },
                { name: '📌 العنوان', value: title }
            ).setTimestamp()
        );
    } catch (e) { console.error('فشل إرسال طلب التكت:', e); await interaction.editReply({ content: '❌ حدث خطأ.' }); }
}

// ===============================================
// 8. فتح التكت
// ===============================================

async function openTicket(interaction, data, adminUser) {
    const guild  = interaction.guild;
    const sInfo  = SERVICE_OPTIONS[data.serviceKey]  || SERVICE_OPTIONS.general_ticket;
    const pInfo  = PRIORITY_OPTIONS[data.priorityKey] || PRIORITY_OPTIONS.normal;
    let member; try { member = await guild.members.fetch(data.userId); } catch { return interaction.editReply({ content: '❌ العضو غير موجود.' }); }
    try {
        const chName = `${pInfo.emoji}${sInfo.categoryName}-${member.user.username.toLowerCase().replace(/[^a-z0-9]/g,'')}`.substring(0,100);
        const ch = await guild.channels.create({
            name: chName, type: ChannelType.GuildText, topic: member.user.id,
            permissionOverwrites: [
                { id: guild.id,       deny:  [PermissionsBitField.Flags.ViewChannel] },
                { id: member.id,      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                { id: adminUser.id,   allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
            ]
        });
        ticketOpenTime.set(ch.id, Date.now());
        ticketClaimer.set(ch.id, { adminId: adminUser.id, adminTag: adminUser.tag });
        ticketOwnerMap.set(ch.id, member.user.id);
        lastMemberMessage.set(ch.id, Date.now());
        addPoint(adminUser.id, adminUser.tag);

        await ch.send({
            content: `${member} | ${adminUser}`,
            embeds: [new EmbedBuilder().setColor(pInfo.color).setTitle(`${sInfo.emoji} ${sInfo.label}`)
                .setThumbnail(member.user.displayAvatarURL({dynamic:true}))
                .addFields(
                    { name: '👤 صاحب الطلب', value: `${member}`, inline:true },
                    { name: '🛡️ الإداري',    value: `${adminUser}`, inline:true },
                    { name: `${pInfo.emoji} الأولوية`, value: pInfo.label, inline:true },
                    { name: '📌 العنوان',     value: data.title, inline:false },
                    { name: '📝 التفاصيل',   value: data.description, inline:false },
                    { name: '🕐 وقت الفتح',  value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline:false }
                ).setFooter({ text: 'أوامر: -ترك | -إضافة @شخص | -نقل @إداري | -تعليق نص' }).setTimestamp()
            ],
            components: [createTicketComponents()]
        });
        await interaction.editReply({ content: `✅ فُتح التكت! ${ch}` });
        await sendLog(guild, new EmbedBuilder().setColor('#57F287').setTitle('✅ تكت مفتوح')
            .addFields(
                { name: '👤 العضو', value: `${member}`, inline:true },
                { name: '🛡️ الإداري', value: `${adminUser}`, inline:true },
                { name: `${pInfo.emoji} الأولوية`, value: pInfo.label, inline:true },
                { name: '📋 القناة', value: `${ch}`, inline:false }
            ).setTimestamp()
        );
    } catch (e) { console.error('فشل فتح التكت:', e); await interaction.editReply({ content: '❌ حدث خطأ.' }); }
}

// ===============================================
// 9. إغلاق التكت
// ===============================================

async function handleTicketClose(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.member.roles.cache.has(MANAGER_ROLE_ID) && !isBotAdmin(interaction.user.id) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
        return interaction.editReply({ content: '❌ للإداريين فقط.' });
    const ch = interaction.channel, oid = ch.topic;
    if (!oid) return interaction.editReply({ content: '❌ هذه القناة ليست تكت.' });
    const cl   = ticketClaimer.get(ch.id);
    const ot   = ticketOpenTime.get(ch.id);
    const dur  = ot ? formatDuration(Date.now()-ot) : 'غير معروف';
    try {
        const owner = await interaction.guild.members.fetch(oid).catch(()=>null);
        let dmSent  = false;
        if (owner) {
            await owner.send({ embeds: [new EmbedBuilder().setColor('#5865F2')
                .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL({dynamic:true}) })
                .setTitle('🔒 تم إغلاق تكتك')
                .setDescription(`مرحباً **${owner.user.username}** 👋\n\nتم إغلاق تكتك. شكراً على تواصلك!`)
                .addFields(
                    { name: '📋 التكت', value: `\`${ch.name}\``, inline:true },
                    { name: '🔒 بواسطة', value: `\`${interaction.user.tag}\``, inline:true },
                    { name: '⏱️ المدة', value: dur, inline:true }
                ).setTimestamp()
            ]}).then(()=>{ dmSent=true; }).catch(()=>{});
            setTimeout(async () => {
                await owner.send({ embeds: [new EmbedBuilder().setColor('#FEE75C').setTitle('⭐ كيف كانت تجربتك؟')
                    .setDescription(`${cl?`🛡️ الإداري: \`${cl.adminTag}\`\n\n`:''}اختر تقييمك:`)
                    .setFooter({ text: 'يمكنك إضافة ملاحظة بالضغط أدناه' })
                ], components: [
                    createRatingComponents(),
                    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dm_note_${oid}_${ch.id}`).setLabel('إضافة ملاحظة').setStyle(ButtonStyle.Secondary).setEmoji('📝'))
                ]}).catch(()=>{});
            }, 30*60*1000);
        }
        await sendLog(interaction.guild, new EmbedBuilder().setColor(dmSent?'#57F287':'#ED4245').setTitle('🔒 تكت مُغلق')
            .addFields(
                { name: '👤 صاحب التكت', value: `<@${oid}>`, inline:true },
                { name: '🔒 بواسطة',     value: `\`${interaction.user.tag}\``, inline:true },
                { name: '⏱️ المدة',       value: dur, inline:true },
                { name: '📋 القناة',      value: `\`${ch.name}\``, inline:true },
                { name: '🛡️ الإداري',    value: cl?`\`${cl.adminTag}\``:'لم يُتولى', inline:true },
                { name: '📨 DM',           value: dmSent?'✅':'❌', inline:true }
            ).setTimestamp()
        );
        setTimeout(async () => {
            await ch.permissionOverwrites.edit(oid, { ViewChannel: false }).catch(()=>{});
            await archiveChannel(ch, interaction, oid, dur);
        }, 30000);
        await interaction.editReply({ content: `✅ سيُغلق خلال 30 ثانية.\n${dmSent?'📨 تم إرسال DM.':'⚠️ الخاص مغلق.'}` });
    } catch (e) { console.error('فشل إغلاق التكت:', e); await interaction.editReply({ content: '❌ حدث خطأ.' }); }
}

// ===============================================
// 10. أرشفة التكت
// ===============================================

async function archiveChannel(ch, interaction, oid, duration) {
    try {
        ticketOpenTime.delete(ch.id); ticketClaimer.delete(ch.id);
        ticketOwnerMap.delete(ch.id); lastMemberMessage.delete(ch.id); reminderSent.delete(ch.id);
        await ch.setParent(ARCHIVE_CATEGORY_ID, { lockPermissions: false });
        await ch.setName(`closed-${ch.name.replace(/^[🟢🟡🔴]/,'')}`);
        await ch.permissionOverwrites.set([
            { id: ch.guild.id,   deny:  [PermissionsBitField.Flags.ViewChannel] },
            { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel] }
        ]);
        await sendLog(interaction.guild, new EmbedBuilder().setColor('#747F8D').setTitle('📁 تكت مؤرشف')
            .addFields(
                { name: '👤 صاحب التكت', value: `<@${oid}>`, inline:true },
                { name: '🔒 بواسطة',     value: `\`${interaction.user.tag}\``, inline:true },
                { name: '⏱️ المدة',       value: duration||'غير معروف', inline:true },
                { name: '📋 القناة',      value: `\`${ch.name}\``, inline:false }
            ).setTimestamp()
        );
    } catch (e) { console.error('فشل الأرشفة:', e); }
}

// ===============================================
// 11. التقييم
// ===============================================

async function handleRating(interaction) {
    const stars = parseInt(interaction.customId.replace('rate_',''));
    const txt   = '⭐'.repeat(stars);
    const match = interaction.message.embeds[0]?.description?.match(/`([^`]+)`/);
    const ctag  = match?.[1];
    const guild = client.guilds.cache.first();
    let aid     = null;
    if (ctag) { const m = guild?.members.cache.find(x=>x.user.tag===ctag); if (m) { aid=m.id; storeRating(aid,ctag,stars,'تكت',interaction.user.tag); } }
    const noteId = interaction.message.components[1]?.components[0]?.customId || 'dm_note_done';
    await interaction.update({
        embeds: [new EmbedBuilder().setColor('#57F287').setTitle('✅ تم تسجيل تقييمك').setDescription(`${txt}\n\n**شكراً!** رأيك يساعدنا. 😊`).setTimestamp()],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(noteId).setLabel('إضافة ملاحظة').setStyle(ButtonStyle.Secondary).setEmoji('📝'))]
    });
    await sendLog(guild, new EmbedBuilder().setColor('#FEE75C').setTitle('⭐ تقييم جديد')
        .addFields(
            { name: '👤 العضو', value: `\`${interaction.user.tag}\``, inline:true },
            { name: '⭐ التقييم', value: `${txt} (${stars}/5)`, inline:true },
            { name: '🛡️ الإداري', value: aid?`<@${aid}>`:`\`${ctag||'غير محدد'}\``, inline:true }
        ).setTimestamp()
    );
}

// ===============================================
// 12. المغادرة — تذكير العضو
// ===============================================

client.on('guildMemberRemove', async member => {
    const ot = member.guild.channels.cache.find(c=>c.topic===member.id&&!c.name.startsWith('closed-'));
    if (!ot) return;
    await member.send({ embeds: [new EmbedBuilder().setColor('#FEE75C').setTitle('⚠️ غادرت السيرفر ولديك تكت!')
        .setDescription(`مرحباً **${member.user.username}**،\n\nلاحظنا مغادرتك **${member.guild.name}** ولا يزال لديك تكت مفتوح:\n\`${ot.name}\`\n\nيمكنك العودة لمتابعة طلبك.`)
        .setTimestamp()
    ]}).catch(()=>{});
    await sendLog(member.guild, new EmbedBuilder().setColor('#FEE75C').setTitle('🚪 عضو غادر وله تكت مفتوح')
        .addFields({ name: '👤 العضو', value: `\`${member.user.tag}\``, inline:true }, { name: '📋 التكت', value: `${ot}`, inline:true }).setTimestamp()
    );
});

// ===============================================
// 13. الحماية والتشغيل
// ===============================================

process.on('unhandledRejection', err => {
    if (err?.code === 10062) return;
    console.error('Unhandled rejection:', err);
});

client.login(BOT_TOKEN);

const app  = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(port, () => console.log(`Web Server on port ${port}`));
