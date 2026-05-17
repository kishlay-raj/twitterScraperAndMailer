#!/usr/bin/env node
/**
 * push-project-update.js — CLI to push a project update to the GAS dashboard.
 *
 * Usage:
 *   node scripts/push-project-update.js \
 *     --version "v2.1.0" \
 *     --title   "System tray & auto-launch" \
 *     --summary "App now runs in the background even when the window is closed." \
 *     --changes "feat:System tray background mode,feat:Auto-launch at macOS login,fix:Missing tray icons"
 *
 * Or interactively (no args): run with no flags and it will prompt.
 */

const https  = require('https');
const http   = require('http');
const url    = require('url');
const readline = require('readline');
const path   = require('path');
const fs     = require('fs');

// ── Load dashboard URL from Electron store (data.json) ──────────────────────
function loadDashboardUrl() {
    const candidates = [
        path.join(process.env.HOME || '', 'Library/Application Support/dailyupdates-desktop/data.json'),
        path.join(process.env.HOME || '', '.config/dailyupdates-desktop/data.json'),
    ];
    for (const p of candidates) {
        try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (data?.settings?.dashboardUrl) return data.settings.dashboardUrl;
        } catch (_) {}
    }
    return process.env.DASHBOARD_URL || '';
}

function ask(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}

function postJson(targetUrl, payload) {
    return new Promise((resolve, reject) => {
        const body   = JSON.stringify(payload);
        const parsed = url.parse(targetUrl);
        const opts   = {
            hostname: parsed.hostname,
            port:     parsed.port,
            path:     parsed.path,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request(opts, res => {
            let raw = '';
            res.on('data', d => raw += d);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch (_) { resolve({ raw }); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function parseArgs() {
    const args = process.argv.slice(2);
    const out  = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) out[args[i].slice(2)] = args[i + 1];
    }
    return out;
}

function parseChanges(str) {
    // "feat:text,fix:other text" → [{type, text}]
    return (str || '').split(',').map(s => {
        const [type, ...rest] = s.trim().split(':');
        return { type: type.trim(), text: rest.join(':').trim() };
    }).filter(c => c.text);
}

async function main() {
    const a = parseArgs();
    let dashboardUrl = a.url || loadDashboardUrl();

    if (!dashboardUrl) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        dashboardUrl = await ask(rl, 'Dashboard GAS URL: ');
        rl.close();
    }

    let version  = a.version;
    let title    = a.title;
    let summary  = a.summary;
    let changes  = a.changes;
    let tags     = a.tags;

    if (!version || !title) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        version  = version  || await ask(rl, 'Version (e.g. v2.1.0): ');
        title    = title    || await ask(rl, 'Title: ');
        summary  = summary  || await ask(rl, 'Summary (one paragraph): ');
        changes  = changes  || await ask(rl, 'Changes (type:text,type:text): ');
        tags     = tags     || await ask(rl, 'Tags (comma-separated, optional): ');
        rl.close();
    }

    const payload = {
        type:      'project_update',
        updateId:  `${version}_${new Date().toISOString().slice(0,10)}`,
        version:   version.trim(),
        title:     title.trim(),
        summary:   (summary || '').trim(),
        changes:   parseChanges(changes),
        tags:      (tags || '').split(',').map(t => t.trim()).filter(Boolean),
        timestamp: Date.now()
    };

    console.log('\nPushing project update:', JSON.stringify(payload, null, 2));
    try {
        const res = await postJson(dashboardUrl, payload);
        if (res.ok)      console.log('✅ Pushed successfully', res.skipped ? '(already existed, skipped)' : '');
        else if (res.error) console.error('❌ Server error:', res.error);
        else                console.log('Response:', res);
    } catch (err) {
        console.error('❌ Push failed:', err.message);
        process.exit(1);
    }
}

main();
