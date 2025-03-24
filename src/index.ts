import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { Client, TextChannel, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import * as dotenv from 'dotenv';
import * as readline from 'readline';

dotenv.config();

interface Player {
    name: string;
    id?: string;
    guid: string;
    voteYesCount: number;
    voteNoCount: number;
    firstSeenDate?: string;
    lastSeenDate?: string;
}

interface VoteEvent {
    date: string;
    timestamp: string;
    targetName: string;
    targetId: string;
    voterName: string;
    voterId: string;
    voteType: string;
    sessionId?: number;
}

interface ActiveVoteSession {
    messageId: string;
    timestamp: string;
    startedBy: string;
    voters: Set<string>;
    voterNames: string[];
    lastUpdateTime: number;
}

class LogParser {
    private playerMap: Map<string, Player> = new Map();
    private dailyPlayerMap: Map<string, Player> = new Map();
    private playerIdToGuid: Map<string, string> = new Map();
    private voteEvents: VoteEvent[] = [];
    private discordClient: Client;
    private dailyChannelId: string;
    private historicalChannelId: string;
    private liveVoteChannelId: string;
    private baseLogDirectory: string = '';
    private historicalLogDirectory: string = '';
    private isProcessing: boolean = false;
    private processedVotes: Set<string> = new Set();
    private currentLogDate: string = '';
    private processedFolders: Set<string> = new Set();
    private isUpdatingHistorical: boolean = false;
    private isUpdatingDaily: boolean = false;
    private processedConsoleLogs: Set<string> = new Set();
    private lastTargetId: string | null = null;
    private lastVoteSession: number = 0;
    private processedLiveVotes: Set<string> = new Set();
    private _lastUpdateTime: number = 0;
    private currentVoteSession: number = 0;
    private debugMode: boolean = true;
    private liveVoteMessageIds: Map<number, string> = new Map();
    private activeVoteSessions: Map<number, ActiveVoteSession> = new Map();
    private voteSessionTimeouts: Map<number, NodeJS.Timeout> = new Map();

    constructor(
        discordToken: string, 
        dailyChannelId: string, 
        historicalChannelId: string, 
        liveVoteChannelId: string, 
        currentLogDirectory: string,
        historicalLogDirectory: string = ''
    ) {
        if (process.env.NODE_OPTIONS === undefined) {
            process.env.NODE_OPTIONS = '--max-old-space-size=4096';
            console.log(`[INFO] Set Node.js memory limit to 4GB`);
        }
        
        this.discordClient = new Client({ 
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });
        this.dailyChannelId = dailyChannelId;
        this.historicalChannelId = historicalChannelId;
        this.liveVoteChannelId = liveVoteChannelId;
        this.baseLogDirectory = currentLogDirectory;
        this.historicalLogDirectory = historicalLogDirectory || '';
        this.processedLiveVotes = new Set<string>();
        this.setupDiscordClient(discordToken);
        
        this.debugMode = process.env.DEBUG_MODE === 'true';
        console.log(`[INFO] Debug mode: ${this.debugMode ? 'ENABLED' : 'DISABLED'}`);
        
        setInterval(() => {
            this.cleanupMemory();
        }, 5 * 60 * 1000);
    }

    private setupDiscordClient(token: string) {
        this.discordClient.once('ready', async () => {
            console.log('[INFO] Discord client ready');
            await this.updateHistoricalSummary();
            await this.startWatching(this.baseLogDirectory);
        });

        this.discordClient.login(token);
    }

    private getLogFolders(baseDir: string): string[] {
        try {
            if (!fs.existsSync(baseDir)) return [];
            
            let items: string[] = [];
            try {
                items = fs.readdirSync(baseDir);
            } catch (error) {
                return [];
            }
            
            const folders = items
                .filter(item => {
                    const fullPath = path.join(baseDir, item);
                    
                    try {
                        if (!fs.existsSync(fullPath)) return false;
                        
                        const stats = fs.statSync(fullPath);
                        const isDir = stats.isDirectory();
                        const matchesFormat = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(item);
                        
                        return isDir && matchesFormat;
                    } catch (error) {
                        return false;
                    }
                })
                .sort((a, b) => b.localeCompare(a));
            
            return folders;
        } catch (error) {
            return [];
        }
    }

    private getTodayLogFolder(baseDir: string): string | null {
        const folders = this.getLogFolders(baseDir);
        if (folders.length === 0) return null;
        return folders[0];
    }

    private getHistoricalLogFolders(baseDir: string, daysBack: number): string[] {
        const folders = this.getLogFolders(baseDir);
        
        if (folders.length === 0) return [];
        
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysBack);

        const filteredFolders = folders.filter(folder => {
            try {
                const folderDate = new Date(folder.substring(0, 10));
                return folderDate >= cutoffDate;
            } catch (error) {
                return false;
            }
        });
        
        return filteredFolders;
    }

    public async startWatching(baseLogDirectory: string) {
        this.baseLogDirectory = baseLogDirectory;
        await this.watchTodayFolder();

        setInterval(async () => {
            const now = new Date();
            const currentDateStr = now.toISOString().split('T')[0];
            
            if (this.currentLogDate !== 'current' && this.currentLogDate !== '') {
                const logDateStr = this.currentLogDate.split('_')[0];
                
                if (logDateStr !== currentDateStr) {
                    this.dailyPlayerMap.forEach((player) => {
                        player.voteYesCount = 0;
                        player.voteNoCount = 0;
                    });
                    
                    this.processedVotes.clear();
                    this.processedLiveVotes.clear();
                    this.voteEvents = [];
                    this.currentVoteSession = 0;
                    this.currentLogDate = 'current';
                    
                    await this.watchTodayFolder();
                    return;
                }
            }
            
            const todayFolder = this.getTodayLogFolder(this.baseLogDirectory);
            if (!todayFolder) return;

            if (todayFolder !== this.currentLogDate && todayFolder !== 'current') {
                this.dailyPlayerMap.forEach((player) => {
                    player.voteYesCount = 0;
                    player.voteNoCount = 0;
                });
                
                this.currentVoteSession = 0;
                this.processedVotes.clear();
                this.processedLiveVotes.clear();
                this.voteEvents = [];
                
                this.currentLogDate = todayFolder;
                await this.watchTodayFolder();
            }
        }, 60 * 1000);

        setInterval(async () => {
            await this.updateHistoricalSummary();
        }, 12 * 60 * 60 * 1000);

        setInterval(() => {
            this.cleanupOldVoteSessions();
        }, 15 * 60 * 1000);

        setInterval(async () => {
            this.cleanupOldVoteSessions();
            
            let hasVotes = this.checkForVotes();
            
            if (hasVotes) {
                await this.sendDailySummary(true);
            } else if (this.hoursSinceLastUpdate() >= 3) {
                await this.sendDailySummary(true);
            }
        }, 60 * 60 * 1000);
    }

    private async watchTodayFolder() {
        this.dailyPlayerMap.forEach(player => {
            if (player.voteYesCount > 0 || player.voteNoCount > 0) {
                player.voteYesCount = 0;
                player.voteNoCount = 0;
            }
        });

        this.processedVotes.clear();
        this.processedConsoleLogs.clear();
        this.processedLiveVotes.clear();
        this.voteEvents = [];
        
        this.voteSessionTimeouts.forEach((timeout) => {
            clearTimeout(timeout);
        });
        this.voteSessionTimeouts.clear();
        
        for (const [sessionId, session] of this.activeVoteSessions.entries()) {
            await this.updateLiveVoteMessage(sessionId, session, true);
        }
        
        this.activeVoteSessions.clear();
        this._lastUpdateTime = 0;

        let consoleLogFound = false;
        let scriptLogFound = false;
        let consoleLogPath = '';
        let scriptLogPath = '';
        let currentDate = 'current';

        const currentConsoleLogPath = path.join(this.baseLogDirectory, 'console.log');
        const currentScriptLogPath = path.join(this.baseLogDirectory, 'script.log');

        if (fs.existsSync(currentConsoleLogPath)) {
            consoleLogFound = true;
            consoleLogPath = currentConsoleLogPath;
        }

        if (fs.existsSync(currentScriptLogPath)) {
            scriptLogFound = true;
            scriptLogPath = currentScriptLogPath;
        }

        if (!consoleLogFound || !scriptLogFound) {
            const dateDirectories = fs.readdirSync(this.baseLogDirectory, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name)
                .filter(name => /^\d{4}-\d{2}-\d{2}/.test(name))
                .sort()
                .reverse();
            
            if (dateDirectories.length > 0) {
                const mostRecentDate = dateDirectories[0];
                currentDate = mostRecentDate;
                this.currentLogDate = mostRecentDate;
                
                if (!consoleLogFound) {
                    consoleLogPath = path.join(this.baseLogDirectory, mostRecentDate, 'console.log');
                    if (fs.existsSync(consoleLogPath)) {
                        consoleLogFound = true;
                    }
                }
                
                if (!scriptLogFound) {
                    scriptLogPath = path.join(this.baseLogDirectory, mostRecentDate, 'script.log');
                    if (fs.existsSync(scriptLogPath)) {
                        scriptLogFound = true;
                    }
                }
            }
        }
        
        if (!consoleLogFound && !scriptLogFound) {
            return;
        }
        
        if (consoleLogFound) {
            await this.processConsoleLog(consoleLogPath, currentDate);
        }
        
        if (scriptLogFound) {
            await this.processScriptLog(scriptLogPath, currentDate);
        }
        
        if (consoleLogFound) {
            const consoleWatcher = chokidar.watch(consoleLogPath, {
                persistent: true,
                awaitWriteFinish: {
                    stabilityThreshold: 300,
                    pollInterval: 100
                }
            });
            
            consoleWatcher.on('change', async (path) => {
                await this.processConsoleLog(path, currentDate);
            });
        }
        
        if (scriptLogFound) {
            const scriptWatcher = chokidar.watch(scriptLogPath, {
                persistent: true,
                awaitWriteFinish: {
                    stabilityThreshold: 300,
                    pollInterval: 100
                }
            });
            
            scriptWatcher.on('change', async (path) => {
                await this.processScriptLog(path, currentDate, true);
            });
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
            if (folderDate !== 'current' && folderDate !== this.currentLogDate) {
                console.log(`[DEBUG] Skipping console log processing for non-current day: ${folderDate} (current: ${this.currentLogDate})`);
                return;
            }

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

            const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                if (line.includes('BattlEye Server:')) {
                    const match = line.match(/Player #(\d+) ([^-]+) - BE GUID: ([a-f0-9]+)/);
                    if (match) {
                        const [_, id, name, beGuid] = match;
                        const trimmedName = name.trim();
                        
                        const existingGuid = this.playerIdToGuid.get(id);
                        if (!existingGuid || existingGuid !== beGuid) {
                            console.log(`[DEBUG] New/Updated player mapping - ID: ${id}, Name: ${trimmedName}, GUID: ${beGuid}`);
                            this.playerIdToGuid.set(id, beGuid);
                        }
                        
                        const existingDailyPlayer = this.dailyPlayerMap.get(beGuid);
                        if (!existingDailyPlayer) {
                            newPlayersAdded++;
                            console.log(`[DEBUG] Adding new player to daily map - Name: ${trimmedName}, GUID: ${beGuid}`);
                        }

                        const dateToUse = folderDate === 'current' ? new Date().toISOString().split('T')[0] : folderDate;

                        this.dailyPlayerMap.set(beGuid, {
                            id,
                            name: trimmedName,
                            guid: '',
                            voteYesCount: existingDailyPlayer?.voteYesCount || 0,
                            voteNoCount: existingDailyPlayer?.voteNoCount || 0,
                            firstSeenDate: existingDailyPlayer?.firstSeenDate || dateToUse,
                            lastSeenDate: dateToUse
                        });
                        playersProcessed++;
                    }
                }
            }

            console.log(`[DEBUG] Console log processing complete:`);
            console.log(`[DEBUG] - Players processed: ${playersProcessed}`);
            console.log(`[DEBUG] - New players added: ${newPlayersAdded}`);
            console.log(`[DEBUG] - Current player ID to GUID map size: ${this.playerIdToGuid.size}`);
            console.log(`[DEBUG] - Current daily player map size: ${this.dailyPlayerMap.size}`);

            this.processedConsoleLogs.add(logIdentifier);
            
            if (this.processedConsoleLogs.size > 1000) {
                const entries = Array.from(this.processedConsoleLogs);
                this.processedConsoleLogs = new Set(entries.slice(-500));
                console.log(`[DEBUG] Trimmed processedConsoleLogs to ${this.processedConsoleLogs.size} entries`);
            }

        } catch (error) {
            console.error('[DEBUG] Error processing console log:', error);
        }
    }

    private async processScriptLog(filePath: string, date: string, watcherEvent: boolean = false) {
        if (!fs.existsSync(filePath)) {
            this.debugLog(`Script log file does not exist: ${filePath}`);
            return;
        }

        const fileStats = fs.statSync(filePath);
        const fileIdentifier = `${filePath}-${fileStats.size}-${fileStats.mtime.getTime()}`;
        const cachedVoteLines = new Set<string>();

        if (this.processedConsoleLogs.has(fileIdentifier) && !watcherEvent) {
            this.debugLog(`Skipping already processed script log: ${filePath}`);
            return;
        }

        this.debugLog(`Processing script log for date: ${date}`);
        this.debugLog(`File size: ${fileStats.size} bytes, Modified: ${fileStats.mtime}`);

        const dateOnly = date === 'current' ? new Date().toISOString().split('T')[0] : date.split('_')[0];
        
        if (watcherEvent) {
            this.debugLog(`Watcher triggered - resetting all vote counts before processing`);
            this.dailyPlayerMap.forEach(player => {
                if (player.voteYesCount > 0) {
                    this.debugLog(`Resetting votes for ${player.name} from ${player.voteYesCount} to 0`);
                    player.voteYesCount = 0;
                    player.voteNoCount = 0;
                }
            });
            
            this.processedVotes.clear();
            this.debugLog(`Cleared processed votes set`);
        }

        try {
            let votesProcessed = 0;
            let totalVoteLines = 0;
            let duplicateVotes = 0;
            let errorLines = 0;
            let ignoredLines = 0;
            
            const processedVoterIds = new Set<string>();
            
            const sessionVoterIds = new Map<number, Set<string>>();
            
            if (!this.currentVoteSession) {
                this.currentVoteSession = 0;
            }
            
            const voteLines: Array<{line: string, voterId: string, timestamp: string, count: number, requiredCount: number}> = [];
            
            const voteGroups: Map<string, Array<{voterId: string, timestamp: string, count: number, line: string}>> = new Map();
            
            const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });
            
            this.debugLog(`Starting to process log file line by line to reduce memory usage`);
            
            for await (const line of rl) {
                if (line.includes("RplSchedulerError") || line.includes("Duplicate") || line.includes("Error")) {
                    errorLines++;
                    continue;
                }
                
                if (!line.includes("approved vote | Vote Type: 'KICK'")) {
                    ignoredLines++;
                    continue;
                }
                
                totalVoteLines++;
                
                const approvalMatch = line.match(/Player '(\d+)' approved vote \| Vote Type: 'KICK'/);
                if (!approvalMatch) {
                    this.debugLog(`Could not extract voter ID from line: ${line.substring(0, 100)}...`);
                    continue;
                }
                
                const voterId = approvalMatch[1];
                
                const timeMatch = line.match(/^(\d{2}:\d{2}:\d{2})/);
                if (!timeMatch) {
                    this.debugLog(`Could not extract timestamp from line: ${line.substring(0, 100)}...`);
                    continue;
                }
                
                const timestamp = timeMatch[1];
                
                const countMatch = line.match(/Count \((\d+)\/(\d+)\)/);
                if (!countMatch) {
                    this.debugLog(`Could not extract count from line, but still processing: ${line.substring(0, 100)}...`);
                    
                    const timePrefix = timestamp.substring(0, 5);
                    const group = voteGroups.get(timePrefix) || [];
                    group.push({voterId, timestamp, count: 1, line});
                    voteGroups.set(timePrefix, group);
                    
                    continue;
                }
                
                const currentCount = parseInt(countMatch[1], 10);
                const requiredCount = parseInt(countMatch[2], 10);
                
                if (currentCount < 1 || currentCount > 50 || requiredCount < 1 || requiredCount > 50) {
                    this.debugLog(`Suspicious count values: ${currentCount}/${requiredCount}, but still processing`);
                }
                
                const timePrefix = timestamp.substring(0, 5);
                const group = voteGroups.get(timePrefix) || [];
                group.push({voterId, timestamp, count: currentCount, line});
                voteGroups.set(timePrefix, group);
            }
            
            this.debugLog(`Processed file line by line, found ${totalVoteLines} vote lines in ${voteGroups.size} time groups`);
            
            let sessionId = this.currentVoteSession;
            let processedTimestamps = new Set<string>();
            
            for (const [timePrefix, groupVotes] of voteGroups.entries()) {
                this.debugLog(`Processing vote group for time ${timePrefix} with ${groupVotes.length} votes`);
                
                const groupKey = `${dateOnly}-${timePrefix}`;
                if (processedTimestamps.has(groupKey)) {
                    this.debugLog(`Already processed votes for time ${timePrefix}, skipping`);
                    continue;
                }
                
                processedTimestamps.add(groupKey);
                
                const limitedGroupVotes = groupVotes.length > 100 ? groupVotes.slice(0, 100) : groupVotes;
                limitedGroupVotes.sort((a, b) => a.count - b.count);
                
                const firstVote = limitedGroupVotes[0];
                if (firstVote && firstVote.count === 1) {
                    sessionId++;
                    
                    if (sessionId > 1000) {
                        this.debugLog(`Session ID exceeded 1000, resetting to 1`);
                        sessionId = 1;
                    }
                    
                    this.debugLog(`New vote session #${sessionId} detected at ${firstVote.timestamp}`);
                    
                    sessionVoterIds.set(sessionId, new Set<string>());
                    
                    const sessionNotificationId = `session-${dateOnly}-${sessionId}-${timePrefix}`;
                    if (!this.processedLiveVotes.has(sessionNotificationId)) {
                        const voterGuid = this.playerIdToGuid.get(firstVote.voterId);
                        if (voterGuid) {
                            const voterData = this.dailyPlayerMap.get(voterGuid);
                            if (voterData) {
                                await this.sendLiveVoteNotification(
                                    'Unknown Player', 
                                    '0',
                                    voterData.name,
                                    firstVote.voterId,
                                    firstVote.timestamp,
                                    dateOnly,
                                    sessionId
                                );
                                this.processedLiveVotes.add(sessionNotificationId);
                            }
                        }
                    }
                }
                
                for (const vote of limitedGroupVotes) {
                    const sessionVoters = sessionVoterIds.get(sessionId) || new Set<string>();
                    
                    if (sessionVoters.has(vote.voterId)) {
                        continue;
                    }
                    
                    const voterGuid = this.playerIdToGuid.get(vote.voterId);
                    if (!voterGuid) {
                        this.debugLog(`Cannot find GUID for player ID: ${vote.voterId}, recreating mapping`);
                        this.processConsoleLogSynchronously(filePath, date);
                        continue;
                    }
                    
                    const voterData = this.dailyPlayerMap.get(voterGuid);
                    if (!voterData) {
                        this.debugLog(`Cannot find player data for GUID: ${voterGuid}`);
                        continue;
                    }
                    
                    sessionVoters.add(vote.voterId);
                    sessionVoterIds.set(sessionId, sessionVoters);
                    voterData.voteYesCount++;
                    votesProcessed++;
                    
                    this.debugLog(`Counting vote for ${voterData.name} in session #${sessionId}, new count: ${voterData.voteYesCount}`);
                    
                    if (this.voteEvents.length < 1000) {
                        this.voteEvents.push({
                            date: dateOnly,
                            timestamp: vote.timestamp,
                            targetName: 'Unknown',
                            targetId: '0',
                            voterName: voterData.name,
                            voterId: vote.voterId,
                            voteType: 'yes',
                            sessionId: sessionId
                        });
                    }
                    
                    await this.updateActiveVoteSession(sessionId, voterData.name, vote.timestamp, dateOnly);
                }
                
                voteGroups.set(timePrefix, []);
            }

            this.currentVoteSession = Math.max(this.currentVoteSession, sessionId);
            
            if (this.currentVoteSession > 1000) {
                this.debugLog(`Resetting currentVoteSession from ${this.currentVoteSession} to 1 as it got too high`);
                this.currentVoteSession = 1;
            }
            
            this.debugLog(`Script log processing complete:`);
            this.debugLog(`- Total vote lines found: ${totalVoteLines}`);
            this.debugLog(`- Error/malformed lines: ${errorLines}`);
            this.debugLog(`- Votes processed: ${votesProcessed}`);
            this.debugLog(`- Duplicate votes: ${duplicateVotes}`);
            this.debugLog(`- Ignored lines: ${ignoredLines}`);
            this.debugLog(`- Current vote session: ${this.currentVoteSession}`);
            this.debugLog(`- Number of unique vote sessions: ${sessionVoterIds.size}`);
            
            let playersWithVotes = 0;
            let totalVotesCount = 0;
            
            this.dailyPlayerMap.forEach((player) => {
                if (player.voteYesCount > 0) {
                    this.debugLog(`- ${player.name}: ${player.voteYesCount} votes`);
                    playersWithVotes++;
                    totalVotesCount += player.voteYesCount;
                }
            });
            
            this.debugLog(`Total players with votes: ${playersWithVotes}, Total votes: ${totalVotesCount}`);
            
            this.processedConsoleLogs.add(fileIdentifier);
            
            if (playersWithVotes > 0 && watcherEvent) {
                this.debugLog(`Updating daily summary with ${playersWithVotes} players having votes`);
                await this.sendDailySummary(true);
            } else if (watcherEvent) {
                this.debugLog(`No players with votes, no daily summary update needed`);
            }
            
            processedTimestamps.clear();
            sessionVoterIds.clear();
            voteGroups.clear();
            
            if (global.gc) {
                this.debugLog(`Running garbage collection to free memory`);
                global.gc();
            }
        } catch (error) {
            this.debugLog(`Error processing script log: ${error}`);
        }
    }

    private timeToSeconds(timeStr: string): number {
        const [hours, minutes, seconds] = timeStr.split(':').map(part => parseInt(part, 10));
        return hours * 3600 + minutes * 60 + seconds;
    }

    private hashString(str: string): string {
        let hash = 0;
        if (str.length === 0) return hash.toString();
        
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        
        return hash.toString();
    }

    private async processHistoricalLog(filePath: string, folderDate: string, historicalPlayerMap: Map<string, Player>, historicalProcessedVotes: Set<string>) {
        const dailyIdToGuid = new Map<string, string>();
        
        try {
            const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
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
                            guid: '',
                            voteYesCount: existingPlayer?.voteYesCount || 0,
                            voteNoCount: existingPlayer?.voteNoCount || 0,
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
                                    
                                    if (historicalProcessedVotes.size > 10000) {
                                        const entries = Array.from(historicalProcessedVotes);
                                        historicalProcessedVotes = new Set(entries.slice(entries.length / 2));
                                        console.log(`Trimmed historical votes to ${historicalProcessedVotes.size} entries`);
                                    }
                                }
                            } else {
                                console.log(`Duplicate historical vote skipped - VoteID: ${voteId}`);
                            }
                        }
                    }
                }
            }
            
            dailyIdToGuid.clear();
            
        } catch (error) {
            console.error('Error processing historical log:', error);
        }
    }

    private async sendDailySummary(forceUpdate: boolean = false) {
        try {
            if (this.isUpdatingDaily && !forceUpdate) {
                this.debugLog('Daily summary update already in progress, skipping...');
                return;
            }

            this.debugLog(`Preparing to send daily summary (forceUpdate: ${forceUpdate})`);
            this.isUpdatingDaily = true;

            const channel = await this.discordClient.channels.fetch(this.dailyChannelId) as TextChannel;
            if (!channel) {
                this.debugLog('Daily channel not found');
                this.isUpdatingDaily = false;
                return;
            }

            let playersWithVotes = 0;
            let totalVotes = 0;

            this.debugLog(`Vote counts before daily summary:`);
            this.dailyPlayerMap.forEach((player) => {
                if (player.voteYesCount > 0) {
                    this.debugLog(`- ${player.name}: ${player.voteYesCount} votes`);
                    playersWithVotes++;
                    totalVotes += player.voteYesCount;
                }
            });
            this.debugLog(`Players with votes: ${playersWithVotes}, Total votes: ${totalVotes}`);

            if (playersWithVotes === 0 && !forceUpdate) {
                this.debugLog('No players with votes, skipping daily summary');
                this.isUpdatingDaily = false;
                return;
            }

            const date = new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
            let message = `📊 **Dagelijkse Votekick Statistieken** 📊\n\n`;

            const sortedPlayers = Array.from(this.dailyPlayerMap.values())
                .filter(player => player.voteYesCount > 0)
                .sort((a, b) => b.voteYesCount - a.voteYesCount);

            this.debugLog(`Sorted players with votes: ${sortedPlayers.length}`);

            if (sortedPlayers.length === 0) {
                message += 'Geen spelers hebben stemmen vandaag.\n\n';
            } else {
                sortedPlayers.forEach((player, index) => {
                    const emoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🔹';
                    message += `${emoji} **${player.name}**: ${player.voteYesCount} stemmen\n`;
                });
                message += '\n';
            }

            message += `⏰ ${new Date().toLocaleString('nl-NL')}`;

            const existingMessages = await channel.messages.fetch({ limit: 10 });
            const dailySummaryMessages = existingMessages.filter(msg => 
                msg.author.id === this.discordClient.user?.id && 
                msg.content.includes('Dagelijkse Votekick Statistieken')
            );

            if (dailySummaryMessages.size > 0) {
                const firstMessage = dailySummaryMessages.first();
                this.debugLog(`Editing existing daily summary message with ID: ${firstMessage?.id}`);
                await firstMessage?.edit(message);
                
                if (dailySummaryMessages.size > 1) {
                    const extraMessages = Array.from(dailySummaryMessages.values()).slice(1);
                    this.debugLog(`Removing ${extraMessages.length} extra summary messages`);
                    
                    for (const extraMsg of extraMessages) {
                        try {
                            await extraMsg.delete();
                            await new Promise(resolve => setTimeout(resolve, 100));
                        } catch (deleteError: any) {
                            if (deleteError?.code !== 10008) {
                                this.debugLog(`Error deleting message: ${deleteError}`);
                            }
                        }
                    }
                }
            } else {
                this.debugLog('No existing summary message found, sending new one');
                await channel.send(message);
            }
            
            this.debugLog('Daily summary updated successfully');
            
            this._lastUpdateTime = Date.now();

            this.debugLog(`Daily summary completed: ${sortedPlayers.length} players with votes`);

        } catch (error) {
            this.debugLog(`Error updating daily summary: ${error}`);
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
            const folders = this.getHistoricalLogFolders(this.historicalLogDirectory, 14);
            const sortedFolders = folders.sort((a, b) => a.localeCompare(b));

            console.log(`[INFO] Processing ${folders.length} historical folders from ${this.historicalLogDirectory}`);

            const historicalProcessedVotes = new Set<string>();
            
            const BATCH_SIZE = 3;
            for (let i = 0; i < sortedFolders.length; i += BATCH_SIZE) {
                const batchFolders = sortedFolders.slice(i, i + BATCH_SIZE);
                console.log(`[INFO] Processing historical folder batch ${i/BATCH_SIZE + 1}/${Math.ceil(sortedFolders.length/BATCH_SIZE)}: ${batchFolders.join(', ')}`);
                
                for (const folder of batchFolders) {
                    console.log(`[INFO] Processing historical folder: ${folder}`);
                    const folderPath = path.join(this.historicalLogDirectory, folder);
                    const consoleLogPath = path.join(folderPath, 'console.log');
                    const scriptLogPath = path.join(folderPath, 'script.log');

                    if (fs.existsSync(consoleLogPath)) {
                        await this.processHistoricalLog(consoleLogPath, folder, historicalPlayerMap, historicalProcessedVotes);
                    }
                    if (fs.existsSync(scriptLogPath)) {
                        await this.processHistoricalLog(scriptLogPath, folder, historicalPlayerMap, historicalProcessedVotes);
                    }
                    
                    if (global.gc) {
                        global.gc();
                        console.log('[INFO] Garbage collection triggered after processing folder');
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                if (global.gc) {
                    global.gc();
                    console.log('[INFO] Garbage collection triggered after batch');
                }
                
                const memoryUsage = process.memoryUsage();
                console.log(`[INFO] Memory usage after batch: rss=${Math.round(memoryUsage.rss / 1024 / 1024)}MB, heapTotal=${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB, heapUsed=${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`);
            }

            this.playerMap = new Map(historicalPlayerMap);

            const sortedPlayers = Array.from(historicalPlayerMap.values())
                .filter(player => player.voteYesCount >= 5)
                .sort((a, b) => b.voteYesCount - a.voteYesCount);

            if (sortedPlayers.length === 0) {
                console.log('[INFO] No players found with 5+ votes in historical data');
                this.isUpdatingHistorical = false;
                return;
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

            const voteGroups = new Map<number, string[]>();
            sortedPlayers.forEach(player => {
                const players = voteGroups.get(player.voteYesCount) || [];
                players.push(player.name);
                voteGroups.set(player.voteYesCount, players);
            });

            const sortedGroups = Array.from(voteGroups.entries())
                .sort((a, b) => b[0] - a[0]);

            const messageParts: string[] = [];
            let currentPart = '📊 **DUTCH FENIKS - HISTORISCH VOTEKICK OVERZICHT** 📊\n';
            currentPart += '🗓️ __Laatste 14 dagen (5+ stemmen)__\n\n';

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

            const messages = await channel.messages.fetch({ limit: 10 });
            const existingSummaries = messages.filter(msg => 
                msg.author.id === this.discordClient.user?.id && 
                msg.content.includes('HISTORISCH VOTEKICK OVERZICHT')
            );

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
                            await channel.send(part);
                        }
                    }
                } else {
                    await channel.send(part);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

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
            
            historicalProcessedVotes.clear();
            messageParts.length = 0;
            
            if (global.gc) {
                global.gc();
                console.log('[INFO] Garbage collection triggered after completing historical summary');
            }

        } catch (error) {
            console.error('[ERROR] Error updating historical summary:', error);
        } finally {
            this.isUpdatingHistorical = false;
        }
    }

    public resetProcessedFolders() {
        this.processedFolders.clear();
        this.playerMap.clear();
        this.processedVotes.clear();
        console.log('Reset processed folders and vote tracking');
    }

    private async sendLiveVoteNotification(
        targetName: string,
        targetId: string,
        voterName: string,
        voterId: string,
        timestamp: string,
        dateOnly: string,
        sessionId: number
    ) {
        try {
            const sessionNotificationId = `session-${dateOnly}-${sessionId}`;
            const sessionTimestampId = `session-${dateOnly}-${timestamp.substring(0, 5)}`;
            
            if (this.processedLiveVotes.has(sessionNotificationId)) {
                this.debugLog(`Already sent live notification for session ${sessionNotificationId}, skipping`);
                return;
            }
            
            if (this.processedLiveVotes.has(sessionTimestampId)) {
                this.debugLog(`Already sent notification for a session at time ${timestamp.substring(0, 5)}, skipping new session #${sessionId}`);
                return;
            }
            
            if (sessionId <= 0 || sessionId > 100) {
                this.debugLog(`Session #${sessionId} appears to be out of valid range, skipping notification`);
                return;
            }
            
            if (this.liveVoteMessageIds.has(sessionId)) {
                this.debugLog(`Message ID already exists for session #${sessionId}, not sending duplicate notification`);
                return;
            }
            
            if (!timestamp || timestamp.length < 5 || !timestamp.includes(':')) {
                this.debugLog(`Invalid timestamp ${timestamp}, not sending notification`);
                return;
            }
            
            if (!voterName || voterName.length < 2) {
                this.debugLog(`Invalid voter name ${voterName}, not sending notification`);
                return;
            }
            
            const liveVoteChannel = await this.discordClient.channels.fetch(this.liveVoteChannelId);
            if (!liveVoteChannel || !liveVoteChannel.isTextBased()) {
                this.debugLog('Failed to get live vote channel');
                return;
            }
            
            const messageEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('⚠️ IN PROGRESS - Vote Session #' + sessionId)
                .setDescription(`Vote session started at ${timestamp}`)
                .addFields(
                    { name: 'Started By', value: voterName, inline: true },
                    { name: 'Current Votes', value: '1', inline: true },
                    { name: 'Last Update', value: new Date().toLocaleTimeString('nl-NL'), inline: true },
                    { name: 'Voters', value: voterName, inline: false }
                )
                .setFooter({ text: 'Will automatically close after 3 minutes of inactivity' })
                .setTimestamp();
            
            if ('send' in liveVoteChannel) {
                const sentMessage = await liveVoteChannel.send({ embeds: [messageEmbed] });
                this.debugLog(`Sent live vote notification for session ${sessionNotificationId} with message ID ${sentMessage.id}`);
                
                this.processedLiveVotes.add(sessionNotificationId);
                this.processedLiveVotes.add(sessionTimestampId);
                
                this.liveVoteMessageIds.set(sessionId, sentMessage.id);
                
                const session: ActiveVoteSession = {
                    messageId: sentMessage.id,
                    timestamp,
                    startedBy: voterName,
                    voters: new Set([voterName]),
                    voterNames: [voterName],
                    lastUpdateTime: Date.now()
                };
                
                this.activeVoteSessions.set(sessionId, session);
                
                this.setVoteSessionTimeout(sessionId, dateOnly);
            } else {
                this.debugLog('Live vote channel does not support sending messages');
            }
        } catch (error) {
            this.debugLog(`Error sending live vote notification: ${error}`);
        }
    }
    
    private async updateLiveVoteProgress(targetId: string, currentCount: number, requiredCount: string) {
        console.log(`[DEBUG] Vote progress: ${currentCount}/${requiredCount} for target ${targetId}`);
    }

    private hoursSinceLastUpdate(): number {
        if (this._lastUpdateTime === 0) return 999;
        const hoursDiff = (Date.now() - this._lastUpdateTime) / (1000 * 60 * 60);
        return Math.round(hoursDiff * 10) / 10;
    }

    private debugLog(message: string) {
        if (this.debugMode) {
            console.log(`[DEBUG] ${message}`);
        }
    }

    private checkForVotes(): boolean {
        let hasVotes = false;
        this.dailyPlayerMap.forEach(player => {
            if (player.voteYesCount > 0) {
                this.debugLog(`Found player with votes: ${player.name} (${player.voteYesCount})`);
                hasVotes = true;
            }
        });
        return hasVotes;
    }

    private cleanupOldVoteSessions() {
        const currentDate = new Date();
        const currentDateStr = currentDate.toISOString().split('T')[0];
        
        const votesToRemove: string[] = [];
        this.processedVotes.forEach(voteId => {
            const datePart = voteId.split('-')[0];
            if (datePart !== currentDateStr) {
                votesToRemove.push(voteId);
            }
        });
        
        if (votesToRemove.length > 0) {
            this.debugLog(`Cleaning up ${votesToRemove.length} old processed votes`);
            votesToRemove.forEach(voteId => this.processedVotes.delete(voteId));
        }
        
        const liveVotesToRemove: string[] = [];
        this.processedLiveVotes.forEach(voteId => {
            if (voteId.includes('-') && !voteId.includes(currentDateStr)) {
                liveVotesToRemove.push(voteId);
            }
            
            if (voteId.startsWith('session-') && !voteId.includes(currentDateStr)) {
                liveVotesToRemove.push(voteId);
            }
        });
        
        if (liveVotesToRemove.length > 0) {
            this.debugLog(`Cleaning up ${liveVotesToRemove.length} old processed live votes`);
            liveVotesToRemove.forEach(voteId => this.processedLiveVotes.delete(voteId));
        }
        
        const sessionsToRemove: number[] = [];
        const currentTime = Date.now();
        
        this.activeVoteSessions.forEach((session, sessionId) => {
            const timeSinceUpdate = currentTime - session.lastUpdateTime;
            if (timeSinceUpdate > 60 * 60 * 1000) {
                this.debugLog(`Cleaning up stale vote session #${sessionId} - no updates in ${Math.round(timeSinceUpdate/1000/60)} minutes`);
                sessionsToRemove.push(sessionId);
            }
            
            if (sessionId > 100) {
                this.debugLog(`Cleaning up suspicious vote session #${sessionId} - ID too high`);
                sessionsToRemove.push(sessionId);
            }
        });
        
        sessionsToRemove.forEach(async (sessionId) => {
            const session = this.activeVoteSessions.get(sessionId);
            if (session) {
                try {
                    await this.updateLiveVoteMessage(sessionId, session, true);
                } catch (error) {
                    this.debugLog(`Error finalizing vote session #${sessionId}: ${error}`);
                }
                
                this.activeVoteSessions.delete(sessionId);
                this.liveVoteMessageIds.delete(sessionId);
                
                const timeout = this.voteSessionTimeouts.get(sessionId);
                if (timeout) {
                    clearTimeout(timeout);
                    this.voteSessionTimeouts.delete(sessionId);
                }
            }
        });
        
        if (sessionsToRemove.length > 0) {
            this.debugLog(`Cleaned up ${sessionsToRemove.length} old active vote sessions`);
        }
        
        if (this.currentVoteSession > 100) {
            this.debugLog(`Resetting currentVoteSession from ${this.currentVoteSession} to 0 as it's gotten too high`);
            this.currentVoteSession = 0;
        }
    }

    private processConsoleLogSynchronously(filePath: string, folderDate: string): void {
        try {
            const consoleLogPath = filePath.replace('script.log', 'console.log');
            if (!fs.existsSync(consoleLogPath)) {
                this.debugLog(`Console log does not exist at ${consoleLogPath}`);
                return;
            }
            
            this.debugLog(`Processing console log synchronously: ${consoleLogPath}`);
            
            const content = fs.readFileSync(consoleLogPath, 'utf8');
            const lines = content.split('\n');
            
            let playersProcessed = 0;
            const dateToUse = folderDate === 'current' ? new Date().toISOString().split('T')[0] : folderDate;
            
            for (const line of lines) {
                if (line.includes('BattlEye Server:')) {
                    const match = line.match(/Player #(\d+) ([^-]+) - BE GUID: ([a-f0-9]+)/);
                    if (match) {
                        const [_, id, name, beGuid] = match;
                        const trimmedName = name.trim();
                        
                        this.playerIdToGuid.set(id, beGuid);
                        
                        const existingDailyPlayer = this.dailyPlayerMap.get(beGuid);
                        
                        this.dailyPlayerMap.set(beGuid, {
                            id,
                            name: trimmedName,
                            guid: beGuid,
                            voteYesCount: existingDailyPlayer?.voteYesCount || 0,
                            voteNoCount: existingDailyPlayer?.voteNoCount || 0,
                            firstSeenDate: existingDailyPlayer?.firstSeenDate || dateToUse,
                            lastSeenDate: dateToUse
                        });
                        playersProcessed++;
                    }
                }
            }
            
            this.debugLog(`Synchronously processed ${playersProcessed} players from console log`);
            
        } catch (error) {
            this.debugLog(`Error in synchronous console log processing: ${error}`);
        }
    }

    private async updateActiveVoteSession(sessionId: number, voterName: string, timestamp: string, dateStr: string): Promise<void> {
        try {
            if (sessionId <= 0 || sessionId > 1000) {
                this.debugLog(`Skipping update for suspicious session ID: ${sessionId}`);
                return;
            }
            
            const finalizedKey = `finalized-${dateStr}-${sessionId}`;
            if (this.processedLiveVotes.has(finalizedKey)) {
                this.debugLog(`Session #${sessionId} has already been finalized, skipping update`);
                return;
            }
            
            let session = this.activeVoteSessions.get(sessionId);
            const sessionKey = `session-${dateStr}-${sessionId}`;
            
            if (!session) {
                const messageId = this.liveVoteMessageIds.get(sessionId);
                if (!messageId) {
                    this.debugLog(`No message ID found for session #${sessionId}, skipping update`);
                    return;
                }
                
                session = {
                    messageId,
                    timestamp,
                    startedBy: voterName,
                    voters: new Set([voterName]),
                    voterNames: [voterName],
                    lastUpdateTime: Date.now()
                };
                this.activeVoteSessions.set(sessionId, session);
                
                this.setVoteSessionTimeout(sessionId, dateStr);
                
                this.debugLog(`Created new active vote session tracking for #${sessionId}`);
                
                await this.updateLiveVoteMessage(sessionId, session);
            } else {
                if (!session.voters.has(voterName)) {
                    session.voters.add(voterName);
                    session.voterNames.push(voterName);
                    session.lastUpdateTime = Date.now();
                    this.activeVoteSessions.set(sessionId, session);
                    
                    await this.updateLiveVoteMessage(sessionId, session);
                    
                    this.setVoteSessionTimeout(sessionId, dateStr);
                    
                    this.debugLog(`Updated active vote session #${sessionId} with new voter: ${voterName}`);
                } else {
                    this.debugLog(`Voter ${voterName} already in session #${sessionId}, not updating`);
                }
            }
        } catch (error) {
            this.debugLog(`Error updating active vote session: ${error}`);
        }
    }
    
    private setVoteSessionTimeout(sessionId: number, dateStr: string): void {
        const existingTimeout = this.voteSessionTimeouts.get(sessionId);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }
        
        const timeout = setTimeout(async () => {
            await this.finalizeVoteSession(sessionId, dateStr);
        }, 3 * 60 * 1000);
        
        this.voteSessionTimeouts.set(sessionId, timeout);
        this.debugLog(`Set timeout for vote session #${sessionId} to finalize after 3 minutes of inactivity`);
    }
    
    private async finalizeVoteSession(sessionId: number, dateStr: string): Promise<void> {
        try {
            const session = this.activeVoteSessions.get(sessionId);
            if (!session) {
                this.debugLog(`No active session found for #${sessionId}, cannot finalize`);
                return;
            }
            
            this.debugLog(`Finalizing vote session #${sessionId} after timeout`);
            
            await this.updateLiveVoteMessage(sessionId, session, true);
            
            this.activeVoteSessions.delete(sessionId);
            this.voteSessionTimeouts.delete(sessionId);
            
            const sessionKey = `finalized-${dateStr}-${sessionId}`;
            this.processedLiveVotes.add(sessionKey);
            
            this.debugLog(`Vote session #${sessionId} successfully finalized and marked as completed`);
        } catch (error) {
            this.debugLog(`Error finalizing vote session: ${error}`);
        }
    }
    
    private async updateLiveVoteMessage(sessionId: number, session: ActiveVoteSession, isComplete: boolean = false): Promise<void> {
        try {
            if (sessionId > this.currentVoteSession + 10) {
                this.debugLog(`Session ${sessionId} seems too far ahead of current session ${this.currentVoteSession}, skipping update`);
                return;
            }
            
            const liveVoteChannel = await this.discordClient.channels.fetch(this.liveVoteChannelId);
            if (!liveVoteChannel || !liveVoteChannel.isTextBased()) {
                this.debugLog('Failed to get live vote channel for update');
                return;
            }
            
            if ('messages' in liveVoteChannel) {
                try {
                    const message = await liveVoteChannel.messages.fetch(session.messageId);
                    if (!message) {
                        this.debugLog(`Cannot find message ${session.messageId} to update`);
                        return;
                    }
                    
                    const sortedVoters = [...session.voterNames].sort();
                    
                    const status = isComplete ? '✅ COMPLETED' : '⚠️ IN PROGRESS';
                    const color = isComplete ? '#00FF00' : '#FF0000';
                    
                    const messageEmbed = new EmbedBuilder()
                        .setColor(color)
                        .setTitle(`${status} - Vote Session #${sessionId}`)
                        .setDescription(`Vote session started at ${session.timestamp}`)
                        .addFields(
                            { name: 'Started By', value: session.startedBy, inline: true },
                            { name: 'Current Votes', value: `${session.voters.size}`, inline: true },
                            { name: 'Last Update', value: new Date().toLocaleTimeString('nl-NL'), inline: true },
                            { 
                                name: 'Voters', 
                                value: sortedVoters.length > 0 
                                    ? sortedVoters.join('\n') 
                                    : 'None yet',
                                inline: false
                            }
                        )
                        .setFooter({ text: isComplete ? 'Vote session ended (timed out after 3 minutes of inactivity)' : 'Vote in progress' })
                        .setTimestamp();
                    
                    await message.edit({ embeds: [messageEmbed] });
                    this.debugLog(`Updated live vote message for session #${sessionId} with ${session.voters.size} voters, complete=${isComplete}`);
                } catch (error: any) {
                    if (error.code === 10008) {
                        this.debugLog(`Message for session #${sessionId} no longer exists, can't update`);
                        this.liveVoteMessageIds.delete(sessionId);
                        this.activeVoteSessions.delete(sessionId);
                    } else {
                        this.debugLog(`Error updating vote message: ${error}`);
                    }
                }
            }
        } catch (error) {
            this.debugLog(`Error in updateLiveVoteMessage: ${error}`);
        }
    }

    private cleanupMemory(): void {
        try {
            this.debugLog(`Running memory cleanup routine`);
            
            if (this.processedConsoleLogs.size > 1000) {
                this.debugLog(`Trimming processedConsoleLogs from ${this.processedConsoleLogs.size} to 500 entries`);
                const toKeep = Array.from(this.processedConsoleLogs).slice(-500);
                this.processedConsoleLogs = new Set(toKeep);
            }
            
            if (this.processedVotes.size > 5000) {
                this.debugLog(`Trimming processedVotes from ${this.processedVotes.size} to 1000 entries`);
                const toKeep = Array.from(this.processedVotes).slice(-1000);
                this.processedVotes = new Set(toKeep);
            }
            
            if (this.processedLiveVotes.size > 5000) {
                this.debugLog(`Trimming processedLiveVotes from ${this.processedLiveVotes.size} to 1000 entries`);
                const toKeep = Array.from(this.processedLiveVotes).slice(-1000);
                this.processedLiveVotes = new Set(toKeep);
            }
            
            if (this.voteEvents.length > 1000) {
                this.debugLog(`Trimming voteEvents from ${this.voteEvents.length} to 500 entries`);
                this.voteEvents = this.voteEvents.slice(-500);
            }
            
            if (global.gc) {
                this.debugLog(`Running garbage collection`);
                global.gc();
            }
            
            if (this.debugMode) {
                const memoryUsage = process.memoryUsage();
                this.debugLog(`Memory usage: rss=${Math.round(memoryUsage.rss / 1024 / 1024)}MB, heapTotal=${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB, heapUsed=${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`);
            }
        } catch (error) {
            this.debugLog(`Error cleaning up memory: ${error}`);
        }
    }
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const DAILY_CHANNEL_ID = process.env.DAILY_CHANNEL_ID || '';
const HISTORICAL_CHANNEL_ID = process.env.HISTORICAL_CHANNEL_ID || '';
const LIVE_VOTE_CHANNEL_ID = process.env.LIVE_VOTE_CHANNEL_ID || '';
const BASE_PATH = process.env.LOG_DIRECTORY || '/srv/armareforger/u4lj4wmjvv';
const HISTORICAL_LOG_DIRECTORY = `${BASE_PATH}/logs`;
const CURRENT_LOG_DIRECTORY = `${BASE_PATH}/logs.current`;

if (!DISCORD_TOKEN || !DAILY_CHANNEL_ID || !HISTORICAL_CHANNEL_ID || !LIVE_VOTE_CHANNEL_ID) {
    console.error('Please set DISCORD_TOKEN, DAILY_CHANNEL_ID, HISTORICAL_CHANNEL_ID, and LIVE_VOTE_CHANNEL_ID environment variables');
    process.exit(1);
}

if (!fs.existsSync(BASE_PATH)) {
    console.error(`Base directory not found: ${BASE_PATH}`);
    process.exit(1);
}

if (!fs.existsSync(HISTORICAL_LOG_DIRECTORY)) {
    console.error(`Historical logs directory not found: ${HISTORICAL_LOG_DIRECTORY}`);
}

if (!fs.existsSync(CURRENT_LOG_DIRECTORY)) {
    console.error(`Current log directory not found: ${CURRENT_LOG_DIRECTORY}`);
    console.log(`Creating directory: ${CURRENT_LOG_DIRECTORY}`);
    try {
        fs.mkdirSync(CURRENT_LOG_DIRECTORY, { recursive: true });
    } catch (error) {
        console.error(`Failed to create current log directory: ${error}`);
    }
}

async function start() {
    try {
        if (process.env.NODE_OPTIONS === undefined) {
            process.env.NODE_OPTIONS = '--max-old-space-size=4096';
            console.log(`[INFO] Set Node.js memory limit to 4GB`);
        }

        console.log('[INFO] Starting log parser');
        console.log(`[INFO] Using current log directory: ${CURRENT_LOG_DIRECTORY}`);
        console.log(`[INFO] Using historical log directory: ${HISTORICAL_LOG_DIRECTORY}`);
        
        const memoryUsage = process.memoryUsage();
        console.log(`[INFO] Initial memory usage: rss=${Math.round(memoryUsage.rss / 1024 / 1024)}MB, heapTotal=${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB, heapUsed=${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`);
        
        const parser = new LogParser(
            DISCORD_TOKEN, 
            DAILY_CHANNEL_ID, 
            HISTORICAL_CHANNEL_ID, 
            LIVE_VOTE_CHANNEL_ID, 
            CURRENT_LOG_DIRECTORY,
            HISTORICAL_LOG_DIRECTORY
        );
        
        setInterval(() => {
            const memUsage = process.memoryUsage();
            console.log(`[INFO] Memory usage: rss=${Math.round(memUsage.rss / 1024 / 1024)}MB, heapTotal=${Math.round(memUsage.heapTotal / 1024 / 1024)}MB, heapUsed=${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
            
            if (global.gc) {
                global.gc();
                console.log('[INFO] Garbage collection triggered');
            }
        }, 30 * 60 * 1000);
    } catch (error) {
        console.error('Failed to start parser:', error);
        process.exit(1);
    }
}

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

start(); 