import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { Client, TextChannel, GatewayIntentBits } from 'discord.js';
import * as dotenv from 'dotenv';
import * as readline from 'readline';

dotenv.config();

interface Player {
    id: string;
    name: string;
    beGuid: string;
    voteYesCount: number;
    firstSeenDate?: string;
    lastSeenDate?: string;
}

interface VoteEvent {
    playerName: string;
    playerId: string;
    timestamp: string;
    totalVotes: number;
    date: string;
}

class LogParser {
    private playerMap: Map<string, Player> = new Map(); // For historical data
    private dailyPlayerMap: Map<string, Player> = new Map(); // For daily data
    private playerIdToGuid: Map<string, string> = new Map();
    private voteEvents: VoteEvent[] = [];
    private discordClient: Client;
    private dailyChannelId: string;
    private historicalChannelId: string;
    private baseLogDirectory: string = '';
    private isProcessing: boolean = false;
    private processedVotes: Set<string> = new Set();
    private currentLogDate: string = '';
    private processedFolders: Set<string> = new Set();
    private isUpdatingHistorical: boolean = false;
    private isUpdatingDaily: boolean = false;
    private processedConsoleLogs: Set<string> = new Set();

    constructor(discordToken: string, dailyChannelId: string, historicalChannelId: string) {
        this.discordClient = new Client({ 
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });
        this.dailyChannelId = dailyChannelId;
        this.historicalChannelId = historicalChannelId;
        this.setupDiscordClient(discordToken);
    }

    private setupDiscordClient(token: string) {
        this.discordClient.once('ready', async () => {
            await this.updateAllSummaries();
        });

        this.discordClient.login(token);
    }

    private getLogFolders(baseDir: string): string[] {
        try {
            const items = fs.readdirSync(baseDir);
            const folders = items
                .filter(item => {
                    const fullPath = path.join(baseDir, item);
                    return fs.statSync(fullPath).isDirectory() && 
                           /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(item);
                })
                .sort((a, b) => b.localeCompare(a));
            return folders;
        } catch (error) {
            return [];
        }
    }

    private getTodayLogFolder(baseDir: string): string | null {
        const folders = this.getLogFolders(baseDir);
        return folders.length > 0 ? folders[0] : null;
    }

    private getHistoricalLogFolders(baseDir: string, daysBack: number): string[] {
        const folders = this.getLogFolders(baseDir);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysBack);

        return folders.filter(folder => {
            const folderDate = new Date(folder.substring(0, 10));
            return folderDate >= cutoffDate;
        });
    }

    public async startWatching(baseLogDirectory: string) {
        this.baseLogDirectory = baseLogDirectory;
        
        // Initial processing
        await this.watchTodayFolder();

        // Check for new daily logs every minute
        setInterval(async () => {
            const todayFolder = this.getTodayLogFolder(this.baseLogDirectory);
            if (!todayFolder) return;

            // If it's a new day, reset and rewatch
            if (todayFolder !== this.currentLogDate) {
                console.log(`New day detected in interval: ${todayFolder} (was: ${this.currentLogDate})`);
                // Reset daily tracking
                this.dailyPlayerMap = new Map();
                this.playerIdToGuid = new Map();
                this.processedVotes.clear();
                this.voteEvents = [];
                this.currentLogDate = todayFolder;
                await this.watchTodayFolder();
            }
        }, 60 * 1000); // Check every minute for daily votes

        // Update historical summary every 12 hours
        setInterval(async () => {
            await this.updateHistoricalSummary();
        }, 12 * 60 * 60 * 1000);
    }

    private async watchTodayFolder() {
        if (this.isProcessing) {
            console.log('[DEBUG] Already processing today folder, skipping...');
            return;
        }
        this.isProcessing = true;

        try {
            const todayFolder = this.getTodayLogFolder(this.baseLogDirectory);
            if (!todayFolder) {
                console.log('[DEBUG] No today folder found');
                this.isProcessing = false;
                return;
            }

            // Reset daily tracking if it's a new day
            if (this.currentLogDate !== todayFolder) {
                console.log(`[DEBUG] New day detected: ${todayFolder} (was: ${this.currentLogDate})`);
                this.currentLogDate = todayFolder;
                this.dailyPlayerMap.clear();
                this.playerIdToGuid.clear();
                this.processedVotes.clear();
                this.processedConsoleLogs.clear();
                this.voteEvents = [];
                console.log('[DEBUG] Daily tracking reset complete');
            }

            const folderPath = path.join(this.baseLogDirectory, todayFolder);
            const consoleLogPath = path.join(folderPath, 'console.log');
            const scriptLogPath = path.join(folderPath, 'script.log');

            // Process console log first to get player information
            if (fs.existsSync(consoleLogPath)) {
                console.log(`[DEBUG] Initial processing of console log: ${consoleLogPath}`);
                await this.processConsoleLog(consoleLogPath, todayFolder);
            }

            // Then process script log for votes
            if (fs.existsSync(scriptLogPath)) {
                console.log(`[DEBUG] Initial processing of script log: ${scriptLogPath}`);
                await this.processScriptLog(scriptLogPath, todayFolder);
            }

            // Set up watchers for both files
            const watchConsole = chokidar.watch(consoleLogPath, {
                persistent: true,
                awaitWriteFinish: {
                    stabilityThreshold: 2000,
                    pollInterval: 100
                }
            });

            const watchScript = chokidar.watch(scriptLogPath, {
                persistent: true,
                awaitWriteFinish: {
                    stabilityThreshold: 2000,
                    pollInterval: 100
                }
            });

            // Watch for changes
            watchConsole.on('change', async (filePath: string) => {
                console.log('[DEBUG] Console log changed, processing...');
                await this.processConsoleLog(filePath, todayFolder);
            });

            watchScript.on('change', async (filePath: string) => {
                console.log('[DEBUG] Script log changed, processing...');
                await this.processScriptLog(filePath, todayFolder);
            });

        } catch (error) {
            console.error('[DEBUG] Error in watchTodayFolder:', error);
            console.error(error);
        } finally {
            this.isProcessing = false;
        }
    }

    private async processFileByLine(filePath: string, processLine: (line: string) => void): Promise<void> {
        const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            processLine(line);
        }
    }

    private async processConsoleLog(filePath: string, folderDate: string) {
        try {
            // Skip if not processing current day
            if (folderDate !== this.currentLogDate) {
                console.log(`[DEBUG] Skipping console log processing for non-current day: ${folderDate} (current: ${this.currentLogDate})`);
                return;
            }

            // Skip if we've already processed this exact log file
            const fileStats = fs.statSync(filePath);
            const logIdentifier = `${filePath}-${fileStats.size}-${fileStats.mtime.getTime()}`;
            if (this.processedConsoleLogs.has(logIdentifier)) {
                console.log(`[DEBUG] Skipping already processed console log: ${filePath}`);
                return;
            }

            console.log(`[DEBUG] Processing console log for date: ${folderDate}`);
            console.log(`[DEBUG] Before processing - Daily player map size: ${this.dailyPlayerMap.size}`);
            let playersProcessed = 0;
            let newPlayersAdded = 0;

            await this.processFileByLine(filePath, (line) => {
                if (line.includes('BattlEye Server:')) {
                    const match = line.match(/Player #(\d+) ([^-]+) - BE GUID: ([a-f0-9]+)/);
                    if (match) {
                        const [_, id, name, beGuid] = match;
                        const trimmedName = name.trim();
                        
                        // Check if this is a new player ID mapping
                        const existingGuid = this.playerIdToGuid.get(id);
                        if (!existingGuid || existingGuid !== beGuid) {
                            console.log(`[DEBUG] New/Updated player mapping - ID: ${id}, Name: ${trimmedName}, GUID: ${beGuid}`);
                            this.playerIdToGuid.set(id, beGuid);
                        }
                        
                        // Only update daily map for current day's players
                        const existingDailyPlayer = this.dailyPlayerMap.get(beGuid);
                        if (!existingDailyPlayer) {
                            newPlayersAdded++;
                            console.log(`[DEBUG] Adding new player to daily map - Name: ${trimmedName}, GUID: ${beGuid}`);
                        }

                        this.dailyPlayerMap.set(beGuid, {
                            id,
                            name: trimmedName,
                            beGuid,
                            voteYesCount: existingDailyPlayer?.voteYesCount || 0,
                            firstSeenDate: existingDailyPlayer?.firstSeenDate || folderDate,
                            lastSeenDate: folderDate
                        });
                        playersProcessed++;
                    }
                }
            });

            console.log(`[DEBUG] Console log processing complete:`);
            console.log(`[DEBUG] - Players processed: ${playersProcessed}`);
            console.log(`[DEBUG] - New players added: ${newPlayersAdded}`);
            console.log(`[DEBUG] - Current player ID to GUID map size: ${this.playerIdToGuid.size}`);
            console.log(`[DEBUG] - Current daily player map size: ${this.dailyPlayerMap.size}`);

            // Mark this log file as processed
            this.processedConsoleLogs.add(logIdentifier);

        } catch (error) {
            console.error('[DEBUG] Error processing console log:', error);
        }
    }

    private async processScriptLog(filePath: string, folderDate: string) {
        try {
            // Skip if not processing current day
            if (folderDate !== this.currentLogDate) {
                console.log(`[DEBUG] Skipping script log processing for non-current day: ${folderDate} (current: ${this.currentLogDate})`);
                return;
            }

            // Read the entire file content
            const fileContent = fs.readFileSync(filePath, 'utf8');
            console.log(`[DEBUG] Processing script log for date: ${folderDate}`);
            console.log(`[DEBUG] File size: ${fileContent.length} bytes`);
            console.log(`[DEBUG] Before processing - Vote counts per player:`);
            this.dailyPlayerMap.forEach((player, guid) => {
                if (player.voteYesCount > 0) {
                    console.log(`[DEBUG] ${player.name}: ${player.voteYesCount} votes`);
                }
            });

            let votesAdded = false;
            let votesProcessed = 0;
            let duplicateVotes = 0;
            let missingPlayerVotes = 0;

            // Process each line
            const lines = fileContent.split('\n');
            console.log(`[DEBUG] Processing ${lines.length} lines`);

            for (const line of lines) {
                if (!line.includes('approved vote | Vote Type: \'KICK\'')) continue;

                const match = line.match(/Player '(\d+)' approved vote \| Vote Type: 'KICK'/);
                if (!match) continue;

                const [_, playerId] = match;
                const playerGuid = this.playerIdToGuid.get(playerId);
                
                if (playerGuid) {
                    const timestampMatch = line.match(/^(\d{2}:\d{2}:\d{2})/);
                    const timestamp = timestampMatch ? timestampMatch[1] : '';
                    const voteId = `${folderDate}-${timestamp}-${playerId}`;
                    
                    console.log(`[DEBUG] Found vote - ID: ${voteId}, PlayerID: ${playerId}, GUID: ${playerGuid}, Line: ${line.substring(0, 100)}`);
                    
                    if (!this.processedVotes.has(voteId)) {
                        const dailyPlayer = this.dailyPlayerMap.get(playerGuid);
                        
                        if (dailyPlayer) {
                            const oldCount = dailyPlayer.voteYesCount;
                            dailyPlayer.voteYesCount++;
                            console.log(`[DEBUG] Vote counted - Player: ${dailyPlayer.name}, Old count: ${oldCount}, New count: ${dailyPlayer.voteYesCount}, VoteID: ${voteId}`);
                            this.dailyPlayerMap.set(playerGuid, dailyPlayer);
                            votesAdded = true;
                            votesProcessed++;

                            // Add vote event
                            const voteEvent: VoteEvent = {
                                playerId,
                                playerName: dailyPlayer.name,
                                timestamp: new Date().toISOString(),
                                totalVotes: dailyPlayer.voteYesCount,
                                date: folderDate
                            };
                            this.voteEvents.push(voteEvent);
                        } else {
                            console.log(`[DEBUG] Player not found in daily map - GUID: ${playerGuid}, ID: ${playerId}`);
                            missingPlayerVotes++;
                        }
                        
                        this.processedVotes.add(voteId);
                    } else {
                        console.log(`[DEBUG] Duplicate vote skipped - VoteID: ${voteId}`);
                        duplicateVotes++;
                    }
                } else {
                    console.log(`[DEBUG] No GUID found for player ID: ${playerId}`);
                    missingPlayerVotes++;
                }
            }

            console.log(`[DEBUG] Script log processing complete:`);
            console.log(`[DEBUG] - Votes processed: ${votesProcessed}`);
            console.log(`[DEBUG] - Duplicate votes: ${duplicateVotes}`);
            console.log(`[DEBUG] - Missing player votes: ${missingPlayerVotes}`);
            console.log(`[DEBUG] After processing - Vote counts per player:`);
            this.dailyPlayerMap.forEach((player, guid) => {
                if (player.voteYesCount > 0) {
                    console.log(`[DEBUG] ${player.name}: ${player.voteYesCount} votes`);
                }
            });

            if (votesAdded) {
                console.log(`[DEBUG] New votes added, updating daily summary...`);
                await this.sendDailySummary();
            } else {
                console.log(`[DEBUG] No new votes added, skipping daily summary update`);
            }
        } catch (error) {
            console.error('[DEBUG] Error processing script log:', error);
            console.error(error);
        }
    }

    private async processHistoricalLog(filePath: string, folderDate: string, historicalPlayerMap: Map<string, Player>, historicalProcessedVotes: Set<string>) {
        const dailyIdToGuid = new Map<string, string>();
        
        try {
            await this.processFileByLine(filePath, (line) => {
                if (line.includes('BattlEye Server:')) {
                    const match = line.match(/Player #(\d+) ([^-]+) - BE GUID: ([a-f0-9]+)/);
                    if (match) {
                        const [_, id, name, beGuid] = match;
                        const trimmedName = name.trim();
                        dailyIdToGuid.set(id, beGuid);
                        
                        const existingPlayer = historicalPlayerMap.get(beGuid);
                        const updatedPlayer = {
                            id,
                            name: trimmedName,
                            beGuid,
                            voteYesCount: existingPlayer?.voteYesCount || 0,
                            firstSeenDate: existingPlayer?.firstSeenDate || folderDate,
                            lastSeenDate: folderDate
                        };
                        
                        historicalPlayerMap.set(beGuid, updatedPlayer);
                    }
                }
                else if (line.includes('approved vote | Vote Type: \'KICK\'')) {
                    const match = line.match(/Player '(\d+)' approved vote \| Vote Type: 'KICK'/);
                    if (match) {
                        const [_, playerId] = match;
                        const playerGuid = dailyIdToGuid.get(playerId);
                        
                        if (playerGuid) {
                            const timestampMatch = line.match(/^(\d{2}:\d{2}:\d{2})/);
                            const timestamp = timestampMatch ? timestampMatch[1] : '';
                            const voteId = `${folderDate}_${timestamp}-${playerId}`;
                            
                            if (!historicalProcessedVotes.has(voteId)) {
                                const player = historicalPlayerMap.get(playerGuid);
                                if (player) {
                                    player.voteYesCount++;
                                    console.log(`Historical vote counted - Player: ${player.name}, ID: ${playerId}, GUID: ${playerGuid}, New Count: ${player.voteYesCount}, VoteID: ${voteId}`);
                                    historicalPlayerMap.set(playerGuid, player);
                                    historicalProcessedVotes.add(voteId);
                                }
                            } else {
                                console.log(`Duplicate historical vote skipped - VoteID: ${voteId}`);
                            }
                        }
                    }
                }
            });
        } catch (error) {
            console.error('Error processing historical log:', error);
        }
    }

    private async updateAllSummaries() {
        await this.updateHistoricalSummary();
    }

    private async sendDailySummary() {
        if (this.isUpdatingDaily) {
            console.log('[DEBUG] Daily summary update already in progress, skipping...');
            return;
        }

        this.isUpdatingDaily = true;
        try {
            console.log('[DEBUG] Starting daily summary update...');
            const channel = await this.discordClient.channels.fetch(this.dailyChannelId) as TextChannel;
            if (!channel || !(channel instanceof TextChannel)) {
                console.log('[DEBUG] Failed to fetch daily channel');
                return;
            }

            console.log(`[DEBUG] Current daily player map size: ${this.dailyPlayerMap.size}`);
            console.log('[DEBUG] Daily player map contents:');
            this.dailyPlayerMap.forEach((player, guid) => {
                console.log(`[DEBUG] Player: ${player.name}, GUID: ${guid}, Votes: ${player.voteYesCount}`);
            });

            const sortedPlayers = Array.from(this.dailyPlayerMap.values())
                .filter(player => player.voteYesCount >= 3)
                .sort((a, b) => b.voteYesCount - a.voteYesCount);

            console.log(`[DEBUG] Found ${sortedPlayers.length} players with 3+ votes`);

            if (sortedPlayers.length === 0) {
                console.log('[DEBUG] No daily votes to display');
                return;
            }

            // Group players by vote count
            const voteGroups = new Map<number, string[]>();
            sortedPlayers.forEach(player => {
                const players = voteGroups.get(player.voteYesCount) || [];
                players.push(player.name);
                voteGroups.set(player.voteYesCount, players);
            });

            console.log('[DEBUG] Vote groups:');
            voteGroups.forEach((players, voteCount) => {
                console.log(`[DEBUG] ${voteCount} votes: ${players.join(', ')}`);
            });

            // Convert to array and sort by vote count (descending)
            const sortedGroups = Array.from(voteGroups.entries())
                .sort((a, b) => b[0] - a[0]);

            // Prepare message parts
            const messageParts: string[] = [];
            let currentPart = '🎮 **DUTCH FENIKS - DAGELIJKS VOTEKICK OVERZICHT** 🎮\n';
            currentPart += '👥 __Spelers met 3+ stemmen vandaag:__\n\n';

            // Add top 3 with medals
            const topPlayers = sortedPlayers.slice(0, 3);
            const medals = ['🥇', '🥈', '🥉'];
            topPlayers.forEach((player, index) => {
                const voteText = player.voteYesCount === 1 ? 'stem' : 'stemmen';
                currentPart += `${medals[index]} **${player.name}** ⭐ \`${player.voteYesCount} ${voteText}\`\n`;
            });

            if (topPlayers.length > 0) currentPart += '\n';

            // Add remaining players grouped by vote count
            for (const [voteCount, players] of sortedGroups) {
                // Skip players already shown in top 3
                const remainingPlayers = players.filter(name => 
                    !topPlayers.some(top => top.name === name)
                );
                
                if (remainingPlayers.length === 0) continue;

                const voteText = voteCount === 1 ? 'stem' : 'stemmen';
                const line = `\`${voteCount} ${voteText}:\` ${remainingPlayers.join(', ')}\n`;

                // Check if adding this line would exceed Discord's limit
                if ((currentPart + line).length > 1900) {
                    messageParts.push(currentPart);
                    currentPart = '🎮 **DUTCH FENIKS - DAGELIJKS VOTEKICK OVERZICHT (vervolg)** 🎮\n\n';
                }
                currentPart += line;
            }

            const timestamp = new Date().toLocaleString('nl-NL', { 
                timeZone: 'UTC',
                timeZoneName: 'short',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
            currentPart += `\n📅 Laatst bijgewerkt: ${timestamp}`;
            messageParts.push(currentPart);

            // Get existing messages
            const messages = await channel.messages.fetch({ limit: 10 });
            const existingSummaries = messages.filter(msg => 
                msg.author.id === this.discordClient.user?.id && 
                msg.content.includes('DAGELIJKS VOTEKICK OVERZICHT')
            );

            // Delete all existing messages first
            for (const msg of Array.from(existingSummaries.values())) {
                try {
                    await msg.delete();
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error: any) {
                    if (error?.code !== 10008) {
                        console.error('Error deleting message:', error);
                    }
                }
            }

            // Send new messages
            for (const part of messageParts) {
                await channel.send(part);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            console.log('[DEBUG] Daily summary update complete');
        } catch (error) {
            console.error('[DEBUG] Error sending daily summary:', error);
        } finally {
            this.isUpdatingDaily = false;
        }
    }

    private async updateHistoricalSummary() {
        if (this.isUpdatingHistorical) {
            console.log('Historical summary update already in progress, skipping...');
            return;
        }

        this.isUpdatingHistorical = true;
        try {
            const channel = await this.discordClient.channels.fetch(this.historicalChannelId) as TextChannel;
            if (!channel || !(channel instanceof TextChannel)) return;

            const historicalPlayerMap = new Map<string, Player>();
            const folders = this.getHistoricalLogFolders(this.baseLogDirectory, 14);
            const sortedFolders = folders.sort((a, b) => a.localeCompare(b));

            // Process all historical folders each time to ensure accurate counts
            const historicalProcessedVotes = new Set<string>(); // Separate set for historical votes
            for (const folder of sortedFolders) {
                console.log(`Processing historical folder: ${folder}`);
                const folderPath = path.join(this.baseLogDirectory, folder);
                const consoleLogPath = path.join(folderPath, 'console.log');
                const scriptLogPath = path.join(folderPath, 'script.log');

                if (fs.existsSync(consoleLogPath)) {
                    await this.processHistoricalLog(consoleLogPath, folder, historicalPlayerMap, historicalProcessedVotes);
                }
                if (fs.existsSync(scriptLogPath)) {
                    await this.processHistoricalLog(scriptLogPath, folder, historicalPlayerMap, historicalProcessedVotes);
                }
            }

            // Update the main playerMap with historical data
            this.playerMap = new Map(historicalPlayerMap);

            const sortedPlayers = Array.from(historicalPlayerMap.values())
                .filter(player => player.voteYesCount >= 5)
                .sort((a, b) => b.voteYesCount - a.voteYesCount);

            if (sortedPlayers.length === 0) return;

            const timestamp = new Date().toLocaleString('nl-NL', { 
                timeZone: 'UTC',
                timeZoneName: 'short',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });

            // Group players by vote count
            const voteGroups = new Map<number, string[]>();
            sortedPlayers.forEach(player => {
                const players = voteGroups.get(player.voteYesCount) || [];
                players.push(player.name);
                voteGroups.set(player.voteYesCount, players);
            });

            // Convert to array and sort by vote count (descending)
            const sortedGroups = Array.from(voteGroups.entries())
                .sort((a, b) => b[0] - a[0]);

            // Prepare message parts
            const messageParts: string[] = [];
            let currentPart = '📊 **DUTCH FENIKS - HISTORISCH VOTEKICK OVERZICHT** 📊\n';
            currentPart += '🗓️ __Laatste 14 dagen (5+ stemmen)__\n\n';

            // Build message parts
            for (const [voteCount, players] of sortedGroups) {
                const voteText = voteCount === 1 ? 'stem' : 'stemmen';
                const line = `\`${voteCount} ${voteText}:\` ${players.join(', ')}\n`;
                
                if ((currentPart + line).length > 1900) {
                    messageParts.push(currentPart);
                    currentPart = '📊 **DUTCH FENIKS - HISTORISCH VOTEKICK OVERZICHT (vervolg)** 📊\n\n';
                }
                currentPart += line;
            }

            currentPart += `\n📅 Laatst bijgewerkt: ${timestamp}`;
            messageParts.push(currentPart);

            // Get existing messages
            const messages = await channel.messages.fetch({ limit: 10 });
            const existingSummaries = messages.filter(msg => 
                msg.author.id === this.discordClient.user?.id && 
                msg.content.includes('HISTORISCH VOTEKICK OVERZICHT')
            );

            // Try to edit existing messages first
            const existingSummaryArray = Array.from(existingSummaries.values());
            for (let i = 0; i < messageParts.length; i++) {
                const part = messageParts[i];
                if (i < existingSummaryArray.length) {
                    try {
                        await existingSummaryArray[i].edit(part);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (error: any) {
                        if (error?.code !== 10008) {
                            console.error('Error editing message:', error);
                            // If edit fails, send as new message
                            await channel.send(part);
                        }
                    }
                } else {
                    // Send new message for additional parts
                    await channel.send(part);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // Delete any extra old messages if we have fewer parts now
            if (existingSummaryArray.length > messageParts.length) {
                for (let i = messageParts.length; i < existingSummaryArray.length; i++) {
                    try {
                        await existingSummaryArray[i].delete();
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (error: any) {
                        if (error?.code !== 10008) {
                            console.error('Error deleting extra message:', error);
                        }
                    }
                }
            }

        } catch (error) {
            console.error('Error updating historical summary:', error);
        } finally {
            this.isUpdatingHistorical = false;
        }
    }

    // Add method to reset processed folders (can be called if needed)
    public resetProcessedFolders() {
        this.processedFolders.clear();
        this.playerMap.clear();
        this.processedVotes.clear();
        console.log('Reset processed folders and vote tracking');
    }
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const DAILY_CHANNEL_ID = process.env.DAILY_CHANNEL_ID || '';
const HISTORICAL_CHANNEL_ID = process.env.HISTORICAL_CHANNEL_ID || '';
const LOG_DIRECTORY = process.env.LOG_DIRECTORY || '/srv/armareforger/u4lj4wmjvv';

if (!DISCORD_TOKEN || !DAILY_CHANNEL_ID || !HISTORICAL_CHANNEL_ID) {
    console.error('Please set DISCORD_TOKEN, DAILY_CHANNEL_ID, and HISTORICAL_CHANNEL_ID environment variables');
    process.exit(1);
}

if (!fs.existsSync(LOG_DIRECTORY)) {
    console.error(`Log directory not found: ${LOG_DIRECTORY}`);
    process.exit(1);
}

async function start() {
    try {
        const parser = new LogParser(DISCORD_TOKEN, DAILY_CHANNEL_ID, HISTORICAL_CHANNEL_ID);
        await parser.startWatching(LOG_DIRECTORY);
    } catch (error) {
        console.error('Failed to start parser:', error);
        process.exit(1);
    }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

// Start the application
start(); 