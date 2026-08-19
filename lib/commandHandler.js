import { fileURLToPath, pathToFileURL } from 'url';
import path, { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import fs from 'fs';

class CommandHandler {
    constructor() {
        this.commands = new Map();
        this.aliases = new Map();
        this.categories = new Map();
        this.stats = new Map();
        this.cooldowns = new Map();
        this.disabledCommands = new Set();
        this.prefixlessCommands = new Map();
        this.watchPlugins();
    }

    async watchPlugins() {
        const pluginsPath = path.join(process.cwd(), 'plugins');
        if (!fs.existsSync(pluginsPath)) return;
        fs.watch(pluginsPath, async (_eventType, filename) => {
            if (filename && filename.endsWith('.js')) {
                const filePath = path.join(pluginsPath, filename);
                try {
                    if (fs.existsSync(filePath)) {
                        const plugin = (await import(pathToFileURL(filePath).href)).default || (await import(pathToFileURL(filePath).href));
                        if (plugin.command) {
                            this.registerCommand(plugin);
                            if (plugin.isPrefixless === true) {
                                const cmdKey = plugin.command.toLowerCase();
                                this.prefixlessCommands.set(cmdKey, cmdKey);
                                if (plugin.aliases && Array.isArray(plugin.aliases)) {
                                    plugin.aliases.forEach((alias) => {
                                        this.prefixlessCommands.set(alias.toLowerCase(), cmdKey);
                                    });
                                }
                            }
                            console.log(`[WATCHER] Hot-reloaded: ${filename}`);
                        }
                    }
                } catch (error) {
                    console.error(`[WATCHER] Error reloading ${filename}:`, error.message);
                }
            }
        });
    }

    async loadCommands() {
        const pluginsPath = path.join(process.cwd(), 'plugins');
        const files = fs.readdirSync(pluginsPath).filter(f => f.endsWith('.js'));
        for (const file of files) {
            try {
                const filePath = path.join(pluginsPath, file);
                const plugin = (await import(pathToFileURL(filePath).href)).default || (await import(pathToFileURL(filePath).href));
                if (plugin.command) {
                    this.registerCommand(plugin);
                    if (plugin.isPrefixless === true) {
                        const cmdKey = plugin.command.toLowerCase();
                        this.prefixlessCommands.set(cmdKey, cmdKey);
                        if (plugin.aliases && Array.isArray(plugin.aliases)) {
                            plugin.aliases.forEach((alias) => {
                                this.prefixlessCommands.set(alias.toLowerCase(), cmdKey);
                            });
                        }
                    }
                }
            } catch (error) {
                console.error(`Error loading ${file}:`, error.message);
            }
        }
    }

    registerCommand(plugin) {
        const { command, aliases = [], category = 'misc', handler } = plugin;
        if (!command || typeof handler !== 'function') {
            console.error(`[SKIP] Plugin at ${command || 'unknown'} is missing a valid command name or handler function.`);
            return;
        }
        const cmdKey = command.toLowerCase();
        
        // Cek collision
        if (this.commands.has(cmdKey)) {
            console.warn(`[COMMAND COLLISION] Command "${cmdKey}" already exists, overwriting.`);
        }
        for (const alias of aliases) {
            const aliasKey = alias.toLowerCase();
            if (this.commands.has(aliasKey) || this.aliases.has(aliasKey)) {
                console.warn(`[COMMAND COLLISION] Alias "${aliasKey}" conflicts with existing command/alias.`);
            }
        }

        this.stats.set(cmdKey, { calls: 0, errors: 0, totalTime: 0n, avgMs: 0 });
        
        const monitoredHandler = async (sock, message, ...args) => {
            const s = this.stats.get(cmdKey);
            if (this.disabledCommands.has(cmdKey)) {
                return await sock.sendMessage(message.key.remoteJid, {
                    text: `🚫 The command *${cmdKey}* is currently disabled.`
                }, { quoted: message });
            }
            const userId = message.key.participant || message.key.remoteJid;
            const now = Date.now();
            const cooldownKey = `${userId}_${cmdKey}`;
            if (this.cooldowns.has(cooldownKey)) {
                const expirationTime = this.cooldowns.get(cooldownKey) + (plugin.cooldown || 3000);
                if (now < expirationTime) return;
            }
            this.cooldowns.set(cooldownKey, now);
            const start = process.hrtime.bigint();
            try {
                s.calls++;
                return await handler(sock, message, ...args);
            } catch (err) {
                s.errors++;
                throw err;
            } finally {
                const end = process.hrtime.bigint();
                s.totalTime += (end - start);
                s.avgMs = Number(s.totalTime / BigInt(s.calls || 1)) / 1000000;
            }
        };
        
        this.commands.set(cmdKey, {
            ...plugin,
            command,
            handler: monitoredHandler,
            category: category.toLowerCase(),
            aliases
        });
        
        for (const alias of aliases) {
            this.aliases.set(alias.toLowerCase(), cmdKey);
        }
        
        if (!this.categories.has(category.toLowerCase())) {
            this.categories.set(category.toLowerCase(), []);
        }
        if (!this.categories.get(category.toLowerCase()).includes(command)) {
            this.categories.get(category.toLowerCase()).push(command);
        }
    }

    toggleCommand(name) {
        const cmd = name.toLowerCase();
        if (this.disabledCommands.has(cmd)) {
            this.disabledCommands.delete(cmd);
            return 'enabled';
        } else {
            this.disabledCommands.add(cmd);
            return 'disabled';
        }
    }

    _levenshtein(a, b) {
        const tmp = [];
        for (let i = 0; i <= a.length; i++) tmp[i] = [i];
        for (let j = 0; j <= b.length; j++) tmp[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                tmp[i][j] = Math.min(
                    tmp[i - 1][j] + 1, 
                    tmp[i][j - 1] + 1, 
                    tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
                );
            }
        }
        return tmp[a.length][b.length];
    }

    // PERBAIKAN: Logika saran command dibuat lebih pintar berdasarkan panjang kata
    findSuggestion(cmd) {
        // Jangan beri saran jika input terlalu pendek (mencegah spam saran)
        if (!cmd || cmd.length < 2) return null;

        const allNames = [...this.commands.keys(), ...this.aliases.keys()];
        let bestMatch = null;
        
        // Toleransi pintar: 
        // Command 2-3 huruf = maksimal salah 1 huruf (minDistance = 2)
        // Command > 3 huruf = maksimal salah 2 huruf (minDistance = 3)
        let minDistance = cmd.length <= 3 ? 2 : 3;

        for (const name of allNames) {
            // Skip jika beda panjang karakter saja sudah melewati toleransi
            if (Math.abs(cmd.length - name.length) >= minDistance) continue;

            const distance = this._levenshtein(cmd, name);
            if (distance < minDistance) {
                minDistance = distance;
                bestMatch = name;
            }
        }
        return bestMatch;
    }

    getDiagnostics() {
        return Array.from(this.stats.entries()).map(([name, data]) => ({
            command: name,
            usage: data.calls,
            errors: data.errors,
            average_speed: `${data.avgMs.toFixed(3)}ms`,
            status: this.disabledCommands.has(name) ? 'OFF' : 'ON'
        })).sort((a, b) => b.usage - a.usage);
    }

    resetStats() {
        this.stats.clear();
        this.cooldowns.clear();
        for (const cmd of this.commands.keys()) {
            this.stats.set(cmd, { calls: 0, errors: 0, totalTime: 0n, avgMs: 0 });
        }
    }

    async reloadCommands() {
        this.commands.clear();
        this.aliases.clear();
        this.categories.clear();
        this.stats.clear();
        this.cooldowns.clear();
        this.disabledCommands.clear();
        this.prefixlessCommands.clear();
        await this.loadCommands();
    }

    getCommand(text, prefixes) {
        const usedPrefix = prefixes.find(p => text.startsWith(p));
        const words = text.trim().split(/ +/);
        const firstWord = words[0].toLowerCase();

        // 1. Exact Match Check (Prefix & Prefixless)
        if (usedPrefix) {
            const fullCommand = text.slice(usedPrefix.length).trim().split(/ +/)[0].toLowerCase();
            if (this.commands.has(fullCommand)) return this.commands.get(fullCommand);
            if (this.aliases.has(fullCommand)) return this.commands.get(this.aliases.get(fullCommand));
        } else {
            return
        }

        // 2. Fuzzy Suggestion Flow
        const cmdToSuggest = usedPrefix ? text.slice(usedPrefix.length).trim().split(/ +/)[0].toLowerCase() : firstWord;
        const suggestion = this.findSuggestion(cmdToSuggest);

        if (suggestion) {
            const targetCmdName = this.aliases.has(suggestion) ? this.aliases.get(suggestion) : suggestion;
            const suggestionPrefix = usedPrefix || "";
            
            return {
                isSuggestion: true,
                command: targetCmdName,
                handler: async (sock, message) => {
                    const chatId = message.key.remoteJid;
                    await sock.sendMessage(chatId, {
                        text: `❓ Did you mean *${suggestionPrefix}${suggestion}*?`
                    }, { quoted: message });
                }
            };
        }

        return null;
    }

    getCommandsByCategory(category) {
        return this.categories.get(category.toLowerCase()) || [];
    }
}
export default new CommandHandler();