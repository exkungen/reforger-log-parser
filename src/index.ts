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
}

class LogParser {
    private playerMap: Map<string, Player> = new Map(); // For historical data
    private dailyPlayerMap: Map<string, Player> = new Map(); // For daily data
    private playerIdToGuid: Map<string, string> = new Map();
    private voteEvents: VoteEvent[] = [];
    private discordClient: Client;
    private dailyChannelId: string;
    private historicalChannelId: string;
    private liveVoteChannelId: string;
    private baseLogDirectory: string = ''; // For current logs
    private historicalLogDirectory: string = ''; // For historical logs
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

    constructor(
        discordToken: string, 
        dailyChannelId: string, 
        historicalChannelId: string, 
        liveVoteChannelId: string, 
        currentLogDirectory: string,
        historicalLogDirectory: string = ''
    ) {
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
        
        // Check for debug mode environment variable
        this.debugMode = process.env.DEBUG_MODE === 'true';
        console.log(`[INFO] Debug mode: ${this.debugMode ? 'ENABLED' : 'DISABLED'}`);
        console.log(`[INFO] Current logs directory: ${this.baseLogDirectory}`);
        console.log(`[INFO] Historical logs directory: ${this.historicalLogDirectory}`);
    }

    private setupDiscordClient(token: string) {
        this.discordClient.once('ready', async () => {
            console.log('[DEBUG] Discord client ready');
            console.log(`[DEBUG] Logged in as ${this.discordClient.user?.tag}`);
            
            // First update the historical summary which doesn't affect daily votes
            await this.updateHistoricalSummary();
            
            // Then start watching the logs to post daily votes
            await this.startWatching(this.baseLogDirectory);
        });

        this.discordClient.login(token);
    }

    private getLogFolders(baseDir: string): string[] {
        try {
            if (!fs.existsSync(baseDir)) {
                console.error(`[ERROR] Directory does not exist: ${baseDir}`);
                return [];
            }
            
            console.log(`[DEBUG] Reading directory: ${baseDir}`);
            
            // Get directory items, handling errors at the file level
            let items: string[] = [];
            try {
                items = fs.readdirSync(baseDir);
                console.log(`[DEBUG] Found ${items.length} items in directory`);
            } catch (error: any) {
                console.error(`[ERROR] Error reading directory ${baseDir}:`, error);
                return [];
            }
            
            // Process each item, safely checking if it's a valid log folder
            const folders = items
                .filter(item => {
                    const fullPath = path.join(baseDir, item);
                    
                    try {
                        // Check if the item still exists and is a directory
                        if (!fs.existsSync(fullPath)) {
                            // File might have been deleted between readdir and now
                            console.log(`[DEBUG] Item no longer exists: ${fullPath}`);
                            return false;
                        }
                        
                        const stats = fs.statSync(fullPath);
                        const isDir = stats.isDirectory();
                        
                        // Check if it's a log folder with the expected date format
                        const matchesFormat = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(item);
                        
                        if (isDir && !matchesFormat) {
                            console.log(`[DEBUG] Skipping directory with incorrect format: ${item}`);
                        }
                        
                        return isDir && matchesFormat;
                    } catch (error: any) {
                        // Gracefully handle any file access errors
                        console.log(`[DEBUG] Error checking item ${fullPath}: ${error.message}`);
                        return false;
                    }
                })
                .sort((a, b) => b.localeCompare(a));
            
            console.log(`[DEBUG] Found ${folders.length} valid log folders`);
            if (folders.length > 0) {
                console.log(`[DEBUG] Most recent folder: ${folders[0]}`);
            }
            
            return folders;
        } catch (error: any) {
            console.error(`[ERROR] Error getting log folders from ${baseDir}:`, error);
            return [];
        }
    }

    private getTodayLogFolder(baseDir: string): string | null {
        const folders = this.getLogFolders(baseDir);
        if (folders.length === 0) {
            console.log(`[WARN] No log folders found in ${baseDir}`);
            return null;
        }
        return folders[0]; // Return the most recent folder
    }

    private getHistoricalLogFolders(baseDir: string, daysBack: number): string[] {
        console.log(`[DEBUG] Getting historical log folders from ${baseDir} for the last ${daysBack} days`);
        const folders = this.getLogFolders(baseDir);
        
        if (folders.length === 0) {
            console.log(`[WARN] No historical log folders found in ${baseDir}`);
            return [];
        }
        
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysBack);
        console.log(`[DEBUG] Using cutoff date: ${cutoffDate.toISOString()}`);

        const filteredFolders = folders.filter(folder => {
            try {
                const folderDate = new Date(folder.substring(0, 10));
                const include = folderDate >= cutoffDate;
                if (!include) {
                    console.log(`[DEBUG] Excluding folder ${folder} as it's before cutoff date`);
                }
                return include;
            } catch (error) {
                console.error(`[ERROR] Error parsing date from folder ${folder}:`, error);
                return false;
            }
        });
        
        console.log(`[DEBUG] Found ${filteredFolders.length} folders within date range`);
        return filteredFolders;
    }

    public async startWatching(baseLogDirectory: string) {
        console.log(`[DEBUG] Start watching log directory: ${baseLogDirectory}`);
        this.baseLogDirectory = baseLogDirectory;
        
        // Initial processing
        await this.watchTodayFolder();

        // Check for new daily logs every minute
        setInterval(async () => {
            // Get the current date in YYYY-MM-DD format for comparison
            const now = new Date();
            const currentDateStr = now.toISOString().split('T')[0];
            
            // Check if we've changed to a new day
            if (this.currentLogDate !== 'current' && this.currentLogDate !== '') {
                const logDateStr = this.currentLogDate.split('_')[0]; // Extract YYYY-MM-DD from date_time format
                
                // If the current log date is from a different day than today, we need to reset
                if (logDateStr !== currentDateStr) {
                    console.log(`[INFO] New day detected in interval: Today is ${currentDateStr}, log date was ${logDateStr}`);
                    
                    // Reset vote counts but preserve player data
                    this.dailyPlayerMap.forEach((player) => {
                        player.voteYesCount = 0;
                        player.voteNoCount = 0;
                    });
                    
                    // Reset vote tracking
                    this.processedVotes.clear();
                    this.processedLiveVotes.clear();
                    this.voteEvents = [];
                    this.currentVoteSession = 0;
                    this.currentLogDate = 'current'; // Reset to force reprocessing
                    
                    console.log('[INFO] Daily vote tracking reset for new day');
                    await this.watchTodayFolder();
                    return;
                }
            }
            
            // Check for new log folder as a backup
            const todayFolder = this.getTodayLogFolder(this.baseLogDirectory);
            if (!todayFolder) return;

            // If it's a new day, reset and rewatch
            if (todayFolder !== this.currentLogDate && todayFolder !== 'current') {
                console.log(`[INFO] New log folder detected: ${todayFolder} (was: ${this.currentLogDate})`);
                // Reset daily vote tracking
                this.dailyPlayerMap.forEach((player) => {
                    player.voteYesCount = 0;
                    player.voteNoCount = 0;
                });
                
                // Reset vote session counter for the new day
                this.currentVoteSession = 0;
                
                // Clear processed votes to start fresh
                this.processedVotes.clear();
                this.processedLiveVotes.clear();
                this.voteEvents = [];
                
                this.currentLogDate = todayFolder;
                console.log('[INFO] Vote tracking reset complete');
                
                await this.watchTodayFolder();
            }
        }, 60 * 1000); // Check every minute for daily votes

        // Update historical summary every 12 hours
        setInterval(async () => {
            await this.updateHistoricalSummary();
        }, 12 * 60 * 60 * 1000);

        // Force daily summary update every hour
        setInterval(async () => {
            console.log('[INFO] Hourly check for daily summary update');
            
            // Clean up old vote sessions first
            this.cleanupOldVoteSessions();
            
            // Check if we have any players with votes
            let hasVotes = this.checkForVotes();
            
            if (hasVotes) {
                console.log(`[INFO] Found players with votes, forcing hourly update`);
                await this.sendDailySummary(true);
            } else if (this.hoursSinceLastUpdate() >= 3) {
                // If no votes but it's been more than 3 hours, send update anyway
                console.log(`[INFO] No votes found, but it's been ${this.hoursSinceLastUpdate()} hours since last update, forcing update`);
                await this.sendDailySummary(true);
            } else {
                console.log(`[INFO] No qualifying votes found for hourly update and last update was ${this.hoursSinceLastUpdate()} hours ago`);
            }
        }, 60 * 60 * 1000); // Every hour
    }

    private async watchTodayFolder() {
        this.debugLog(`Starting to watch logs folder: ${this.baseLogDirectory}`);

        // CRITICAL: Complete reset of ALL state on startup
        this.debugLog(`Performing FULL RESET of all tracking data to prevent duplication`);
        
        // Reset all vote counts
        this.dailyPlayerMap.forEach(player => {
            if (player.voteYesCount > 0 || player.voteNoCount > 0) {
                this.debugLog(`Resetting votes for ${player.name}: Yes=${player.voteYesCount}, No=${player.voteNoCount}`);
                player.voteYesCount = 0;
                player.voteNoCount = 0;
            }
        });

        // Clear all trackers completely
        this.processedVotes.clear();
        this.processedConsoleLogs.clear();
        this.processedLiveVotes.clear();
        this.voteEvents = [];
        
        // Reset all session counters to ensure fresh start
        this.currentVoteSession = 0;
        this._lastUpdateTime = 0;
        
        this.debugLog(`Reset completed - all vote counts, sessions and processed sets cleared`);

        // Find log files
        let consoleLogFound = false;
        let scriptLogFound = false;
        let consoleLogPath = '';
        let scriptLogPath = '';
        let currentDate = 'current';

        // First check if log files exist directly in the logs.current folder
        const currentConsoleLogPath = path.join(this.baseLogDirectory, 'console.log');
        const currentScriptLogPath = path.join(this.baseLogDirectory, 'script.log');

        if (fs.existsSync(currentConsoleLogPath)) {
            this.debugLog(`Found console.log directly in logs.current folder`);
            consoleLogFound = true;
            consoleLogPath = currentConsoleLogPath;
        }

        if (fs.existsSync(currentScriptLogPath)) {
            this.debugLog(`Found script.log directly in logs.current folder`);
            scriptLogFound = true;
            scriptLogPath = currentScriptLogPath;
        }

        // If we didn't find one or both logs, check in date subdirectories
        if (!consoleLogFound || !scriptLogFound) {
            this.debugLog(`One or both logs not found directly in logs.current, checking date folders`);
            
            // List all date folders in the logs directory
            const dateDirectories = fs.readdirSync(this.baseLogDirectory, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name)
                .filter(name => /^\d{4}-\d{2}-\d{2}/.test(name)) // Make sure it's a date folder
                .sort() // Sort alphabetically
                .reverse(); // Most recent first
            
            if (dateDirectories.length > 0) {
                this.debugLog(`Found ${dateDirectories.length} date folders, most recent: ${dateDirectories[0]}`);
                
                // Use the most recent date folder
                const mostRecentDate = dateDirectories[0];
                currentDate = mostRecentDate;
                this.currentLogDate = mostRecentDate; // Set current log date to latest folder
                
                // Set paths for the log files
                if (!consoleLogFound) {
                    consoleLogPath = path.join(this.baseLogDirectory, mostRecentDate, 'console.log');
                    if (fs.existsSync(consoleLogPath)) {
                        this.debugLog(`Found console.log in ${mostRecentDate} folder`);
                        consoleLogFound = true;
                    }
                }
                
                if (!scriptLogFound) {
                    scriptLogPath = path.join(this.baseLogDirectory, mostRecentDate, 'script.log');
                    if (fs.existsSync(scriptLogPath)) {
                        this.debugLog(`Found script.log in ${mostRecentDate} folder`);
                        scriptLogFound = true;
                    }
                }
            } else {
                this.debugLog(`No date folders found in ${this.baseLogDirectory}`);
            }
        }
        
        // Make sure we have at least one of the logs to work with
        if (!consoleLogFound && !scriptLogFound) {
            this.debugLog(`No log files found in ${this.baseLogDirectory} or its date subdirectories`);
            return;
        }
        
        // Process the console log first to gather player information
        if (consoleLogFound) {
            this.debugLog(`Processing console log: ${consoleLogPath}`);
            await this.processConsoleLog(consoleLogPath, currentDate);
            this.debugLog(`Finished processing console log`);
        } else {
            this.debugLog(`No console log found to process`);
        }
        
        // Then process the script log for votes
        if (scriptLogFound) {
            this.debugLog(`Processing script log: ${scriptLogPath}`);
            await this.processScriptLog(scriptLogPath, currentDate);
            this.debugLog(`Finished processing script log`);
        } else {
            this.debugLog(`No script log found to process`);
        }
        
        // Set up watchers for both log files with increased sensitivity
        if (consoleLogFound) {
            this.debugLog(`Setting up watcher for console log: ${consoleLogPath}`);
            const consoleWatcher = chokidar.watch(consoleLogPath, {
                persistent: true,
                awaitWriteFinish: {
                    stabilityThreshold: 500, // Reduced from 2000
                    pollInterval: 100
                }
            });
            
            consoleWatcher.on('change', async (path) => {
                this.debugLog(`Console log file changed: ${path}`);
                await this.processConsoleLog(path, currentDate);
            });
        }
        
        if (scriptLogFound) {
            this.debugLog(`Setting up watcher for script log: ${scriptLogPath}`);
            const scriptWatcher = chokidar.watch(scriptLogPath, {
                persistent: true,
                awaitWriteFinish: {
                    stabilityThreshold: 500, // Reduced from 2000
                    pollInterval: 100
                }
            });
            
            scriptWatcher.on('change', async (path) => {
                this.debugLog(`Script log file changed: ${path}`);
                await this.processScriptLog(path, currentDate, true);
            });
        }
        
        this.debugLog(`Successfully set up log watchers for logs.current directory`);
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
            // Skip if folderDate is not 'current' and not matching current day
            if (folderDate !== 'current' && folderDate !== this.currentLogDate) {
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

                        // Use the actual date or current date for record keeping
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

    private async processScriptLog(filePath: string, date: string, watcherEvent: boolean = false) {
        if (!fs.existsSync(filePath)) {
            this.debugLog(`Script log file does not exist: ${filePath}`);
            return;
        }

        // First, let's get the absolute minimum information we need to avoid processing if unnecessary
        const fileStats = fs.statSync(filePath);
        const fileIdentifier = `${filePath}-${fileStats.size}-${fileStats.mtime.getTime()}`;
        const cachedVoteLines = new Set<string>();

        // Skip if it's exactly the same file we just processed (no changes) and not a watcher event
        if (this.processedConsoleLogs.has(fileIdentifier) && !watcherEvent) {
            this.debugLog(`Skipping already processed script log: ${filePath}`);
            return;
        }

        this.debugLog(`Processing script log for date: ${date}`);
        this.debugLog(`File size: ${fileStats.size} bytes, Modified: ${fileStats.mtime}`);

        // Get the date portion (YYYY-MM-DD) - if date is 'current', use today's date
        const dateOnly = date === 'current' ? new Date().toISOString().split('T')[0] : date.split('_')[0];
        
        // Completely clear all vote counts on each processing to prevent accumulation
        if (watcherEvent) {
            this.debugLog(`Watcher triggered - resetting all vote counts before processing`);
            this.dailyPlayerMap.forEach(player => {
                if (player.voteYesCount > 0) {
                    this.debugLog(`Resetting votes for ${player.name} from ${player.voteYesCount} to 0`);
                    player.voteYesCount = 0;
                    player.voteNoCount = 0;
                }
            });
            
            // Also clear vote tracking, but maintain session counter to avoid duplicate notifications
            this.processedVotes.clear();
            this.debugLog(`Cleared processed votes set`);
        }

        // Read content in chunks to handle large files better
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        
        // Initialize tracking variables
        let votesProcessed = 0;
        let totalVoteLines = 0;
        let duplicateVotes = 0;
        let errorLines = 0;
        let ignoredLines = 0;
        
        // Track unique voter IDs to count only one vote per player
        const processedVoterIds = new Set<string>();
        
        // Track session votes by session ID to avoid double-counting
        const sessionVoterIds = new Map<number, Set<string>>();
        
        // Initialize the vote session if needed
        if (!this.currentVoteSession) {
            this.currentVoteSession = 0;
        }
        
        // Extract all valid vote lines first to analyze them as a whole
        const voteLines: Array<{line: string, voterId: string, timestamp: string, count: number, requiredCount: number}> = [];
        
        // Process all lines instead of just the last 2000
        const relevantLines = lines;
        
        this.debugLog(`Examining ${relevantLines.length} lines from the log file`);
        
        // First pass: extract and validate all vote lines
        for (const line of relevantLines) {
            // Skip certain error lines known to cause false positives
            if (line.includes("RplSchedulerError") || line.includes("Duplicate") || line.includes("Error")) {
                errorLines++;
                continue;
            }
            
            // Look for vote lines with a more lenient pattern
            if (!line.includes("approved vote | Vote Type: 'KICK'")) {
                ignoredLines++;
                continue;
            }
            
            totalVoteLines++;
            
            // Extract voter ID with a more forgiving pattern
            const approvalMatch = line.match(/Player '(\d+)' approved vote \| Vote Type: 'KICK'/);
            if (!approvalMatch) {
                this.debugLog(`Could not extract voter ID from line: ${line.substring(0, 100)}...`);
                continue;
            }
            
            const voterId = approvalMatch[1];
            
            // Extract timestamp
            const timeMatch = line.match(/^(\d{2}:\d{2}:\d{2})/);
            if (!timeMatch) {
                this.debugLog(`Could not extract timestamp from line: ${line.substring(0, 100)}...`);
                continue;
            }
            
            const timestamp = timeMatch[1];
            
            // Extract vote count with a more lenient pattern
            const countMatch = line.match(/Count \((\d+)\/(\d+)\)/);
            if (!countMatch) {
                // Try to still process the vote even without count info
                this.debugLog(`Could not extract count from line, but still processing: ${line.substring(0, 100)}...`);
                voteLines.push({
                    line,
                    voterId,
                    timestamp,
                    count: 1, // Default to 1
                    requiredCount: 10 // Default to 10
                });
                continue;
            }
            
            const currentCount = parseInt(countMatch[1], 10);
            const requiredCount = parseInt(countMatch[2], 10);
            
            // Validate count numbers with more lenient limits
            if (currentCount < 1 || currentCount > 50 || requiredCount < 1 || requiredCount > 50) {
                this.debugLog(`Suspicious count values: ${currentCount}/${requiredCount}, but still processing`);
            }
            
            // Add to valid vote lines for processing
            voteLines.push({
                line,
                voterId,
                timestamp,
                count: currentCount,
                requiredCount
            });
        }
        
        // Sort vote lines by timestamp and count to ensure proper sequencing
        voteLines.sort((a, b) => {
            // First by timestamp
            const timeCompare = a.timestamp.localeCompare(b.timestamp);
            if (timeCompare !== 0) return timeCompare;
            
            // Then by count
            return a.count - b.count;
        });
        
        this.debugLog(`Found ${voteLines.length} valid vote lines to process`);
        
        // Second pass: process votes and detect sessions
        let lastProcessedTime = '';
        let lastCount = 0;
        let currentSessionId = this.currentVoteSession;
        
        for (const voteLine of voteLines) {
            const { voterId, timestamp, count, line } = voteLine;
            
            // Create a unique hash for this line to avoid processing duplicates
            const lineHash = this.hashString(line);
            if (cachedVoteLines.has(lineHash)) {
                this.debugLog(`Skipping duplicate line: ${line.substring(0, 50)}...`);
                duplicateVotes++;
                continue;
            }
            cachedVoteLines.add(lineHash);
            
            // Check if this is a new vote session
            let isNewSession = false;
            
            // If count resets to 1, it's a new session
            if (count === 1 && lastCount > 1) {
                isNewSession = true;
                currentSessionId++;
                this.debugLog(`New vote session #${currentSessionId} detected (count reset from ${lastCount} to ${count})`);
            }
            // If there's a big time gap (>2 minutes) with count 1, it's likely a new session
            else if (lastProcessedTime !== '' && count === 1) {
                const lastTime = this.timeToSeconds(lastProcessedTime);
                const currentTime = this.timeToSeconds(timestamp);
                const timeDiff = Math.abs(currentTime - lastTime);
                
                if (timeDiff > 120) { // 2 minutes instead of 3
                    isNewSession = true;
                    currentSessionId++;
                    this.debugLog(`New vote session #${currentSessionId} detected (time gap: ${timeDiff} seconds)`);
                }
            } 
            // First vote of processing is always a new session
            else if (lastProcessedTime === '' && count === 1) {
                isNewSession = true;
                currentSessionId++;
                this.debugLog(`First vote session #${currentSessionId} detected`);
            }
            
            // Get the set of voters for this session
            let sessionVoters = sessionVoterIds.get(currentSessionId);
            if (!sessionVoters) {
                sessionVoters = new Set<string>();
                sessionVoterIds.set(currentSessionId, sessionVoters);
            }
            
            // Update tracking variables
            lastProcessedTime = timestamp;
            lastCount = count;
            
            // Look up the player who voted
            const voterGuid = this.playerIdToGuid.get(voterId);
            if (!voterGuid) {
                this.debugLog(`Cannot find GUID for player ID: ${voterId}, recreating mapping`);
                // Try to recreate the mapping by processing console log
                this.processConsoleLogSynchronously(filePath, date);
                continue;
            }
            
            const voterData = this.dailyPlayerMap.get(voterGuid);
            if (!voterData) {
                this.debugLog(`Cannot find player data for GUID: ${voterGuid}`);
                continue;
            }
            
            // Only count one vote per player per session
            if (!sessionVoters.has(voterId)) {
                sessionVoters.add(voterId);
                voterData.voteYesCount++;
                votesProcessed++;
                this.debugLog(`Counting vote for ${voterData.name} in session #${currentSessionId}, new count: ${voterData.voteYesCount}`);
            } else {
                this.debugLog(`Player ${voterData.name} already voted in session #${currentSessionId}, not counting again`);
            }
            
            // Add to vote events for tracking
            this.voteEvents.push({
                date: dateOnly,
                timestamp,
                targetName: 'Unknown',
                targetId: '0',
                voterName: voterData.name,
                voterId,
                voteType: 'yes'
            });
            
            // Send notification for new sessions, but only if we haven't sent one for this session before
            if (isNewSession && count === 1) {
                const sessionNotificationId = `session-${dateOnly}-${currentSessionId}`;
                if (!this.processedLiveVotes.has(sessionNotificationId)) {
                    await this.sendLiveVoteNotification(
                        'Unknown Player', 
                        '0',
                        voterData.name,
                        voterId,
                        timestamp,
                        dateOnly,
                        currentSessionId
                    );
                    this.processedLiveVotes.add(sessionNotificationId);
                } else {
                    this.debugLog(`Already sent notification for session #${currentSessionId}, skipping`);
                }
            }
        }
        
        // Update the current session counter
        this.currentVoteSession = currentSessionId;
        
        // Log summary
        this.debugLog(`Script log processing complete:`);
        this.debugLog(`- Total vote lines found: ${totalVoteLines}`);
        this.debugLog(`- Error/malformed lines: ${errorLines}`);
        this.debugLog(`- Votes processed: ${votesProcessed}`);
        this.debugLog(`- Duplicate votes: ${duplicateVotes}`);
        this.debugLog(`- Ignored lines: ${ignoredLines}`);
        this.debugLog(`- Current vote session: ${this.currentVoteSession}`);
        this.debugLog(`- Number of unique vote sessions: ${sessionVoterIds.size}`);
        
        // Log votes per player for verification
        this.debugLog(`Vote counts per player:`);
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
        
        // Mark this file as processed
        this.processedConsoleLogs.add(fileIdentifier);
        
        // Update daily summary if we have votes
        if (playersWithVotes > 0 && watcherEvent) {
            this.debugLog(`Updating daily summary with ${playersWithVotes} players having votes`);
            await this.sendDailySummary(true);
        } else if (watcherEvent) {
            this.debugLog(`No players with votes, no daily summary update needed`);
        }
    }

    // Helper to convert HH:MM:SS to seconds for time comparison
    private timeToSeconds(timeStr: string): number {
        const [hours, minutes, seconds] = timeStr.split(':').map(part => parseInt(part, 10));
        return hours * 3600 + minutes * 60 + seconds;
    }

    // Hash function to detect duplicate lines
    private hashString(str: string): string {
        let hash = 0;
        if (str.length === 0) return hash.toString();
        
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        
        return hash.toString();
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

    private async sendDailySummary(forceUpdate: boolean = false) {
        try {
            if (this.isUpdatingDaily && !forceUpdate) {
                this.debugLog('Daily summary update already in progress, skipping...');
                return;
            }

            this.debugLog(`Preparing to send daily summary (forceUpdate: ${forceUpdate})`);
            this.isUpdatingDaily = true;

            // Get the channel
            const channel = await this.discordClient.channels.fetch(this.dailyChannelId) as TextChannel;
            if (!channel) {
                this.debugLog('Daily channel not found');
                this.isUpdatingDaily = false;
                return;
            }

            // Count players with at least one vote
            let playersWithVotes = 0;
            let totalVotes = 0;

            // Log all active vote counts for debugging and verification
            this.debugLog(`Vote counts before daily summary:`);
            this.dailyPlayerMap.forEach((player) => {
                if (player.voteYesCount > 0) {
                    this.debugLog(`- ${player.name}: ${player.voteYesCount} votes`);
                    playersWithVotes++;
                    totalVotes += player.voteYesCount;
                }
            });
            this.debugLog(`Players with votes: ${playersWithVotes}, Total votes: ${totalVotes}`);

            // If we have no votes and not forcing an update, skip the summary
            if (playersWithVotes === 0 && !forceUpdate) {
                this.debugLog('No players with votes, skipping daily summary');
                this.isUpdatingDaily = false;
                return;
            }

            // Format the new daily summary message
            const date = new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
            let message = `📊 **Dagelijkse Votekick Statistieken** 📊\n\n`;

            // Sort players by vote count (descending), include only players with at least 1 vote
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

            // Add timestamp - using current time, not cached time
            message += `⏰ ${new Date().toLocaleString('nl-NL')}`;

            // Check for existing summary messages
            const existingMessages = await channel.messages.fetch({ limit: 10 });
            const dailySummaryMessages = existingMessages.filter(msg => 
                msg.author.id === this.discordClient.user?.id && 
                msg.content.includes('Dagelijkse Votekick Statistieken')
            );

            if (dailySummaryMessages.size > 0) {
                // Edit the first existing message
                const firstMessage = dailySummaryMessages.first();
                this.debugLog(`Editing existing daily summary message with ID: ${firstMessage?.id}`);
                await firstMessage?.edit(message);
                
                // Delete any additional summary messages (if more than one exists)
                if (dailySummaryMessages.size > 1) {
                    const extraMessages = Array.from(dailySummaryMessages.values()).slice(1);
                    this.debugLog(`Removing ${extraMessages.length} extra summary messages`);
                    
                    for (const extraMsg of extraMessages) {
                        try {
                            await extraMsg.delete();
                            // Small delay to avoid rate limits
                            await new Promise(resolve => setTimeout(resolve, 100));
                        } catch (deleteError: any) {
                            if (deleteError?.code !== 10008) { // Unknown message error
                                this.debugLog(`Error deleting message: ${deleteError}`);
                            }
                        }
                    }
                }
            } else {
                // If no existing message, send a new one
                this.debugLog('No existing summary message found, sending new one');
                await channel.send(message);
            }
            
            this.debugLog('Daily summary updated successfully');
            
            // Update the last update time
            this._lastUpdateTime = Date.now();

            // Log final state
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
            // Use the historical log directory
            const folders = this.getHistoricalLogFolders(this.historicalLogDirectory, 14);
            const sortedFolders = folders.sort((a, b) => a.localeCompare(b));

            console.log(`[INFO] Processing ${folders.length} historical folders from ${this.historicalLogDirectory}`);

            // Process all historical folders each time to ensure accurate counts
            const historicalProcessedVotes = new Set<string>(); // Separate set for historical votes
            for (const folder of sortedFolders) {
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
            console.error('[ERROR] Error updating historical summary:', error);
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

    // Add a new method to send live vote notifications
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
            // Create a unique identifier for this vote session
            const sessionNotificationId = `session-${dateOnly}-${sessionId}`;
            
            // Skip if we've already sent a notification for this session
            if (this.processedLiveVotes.has(sessionNotificationId)) {
                this.debugLog(`Already sent live notification for session ${sessionNotificationId}, skipping`);
                return;
            }
            
            // Validate that session number is within a reasonable range
            if (sessionId < 1 || sessionId > 5000) {
                this.debugLog(`Suspicious session number ${sessionId}, not sending notification`);
                return;
            }
            
            // Validate timestamp
            if (!timestamp || timestamp.length < 5 || !timestamp.includes(':')) {
                this.debugLog(`Invalid timestamp ${timestamp}, not sending notification`);
                return;
            }
            
            // Validate voter name
            if (!voterName || voterName.length < 2) {
                this.debugLog(`Invalid voter name ${voterName}, not sending notification`);
                return;
            }
            
            const liveVoteChannel = await this.discordClient.channels.fetch(this.liveVoteChannelId);
            if (!liveVoteChannel || !liveVoteChannel.isTextBased()) {
                this.debugLog('Failed to get live vote channel');
                return;
            }
            
            // Send a generic notification about a new vote session starting without specifying the player
            const messageEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('⚠️ Vote Session Started ⚠️')
                .setDescription(`New vote session #${sessionId} started at ${timestamp}`)
                .addFields(
                    { name: 'First Vote By', value: voterName, inline: true },
                    { name: 'Server Time', value: timestamp, inline: true },
                )
                .setTimestamp();
            
            // Cast the channel to TextChannel to use the send method
            if ('send' in liveVoteChannel) {
                await liveVoteChannel.send({ embeds: [messageEmbed] });
                this.debugLog(`Sent live vote notification for session ${sessionNotificationId}`);
                
                // Mark this session as having sent a notification
                this.processedLiveVotes.add(sessionNotificationId);
            } else {
                this.debugLog('Live vote channel does not support sending messages');
            }
        } catch (error) {
            this.debugLog(`Error sending live vote notification: ${error}`);
        }
    }
    
    // Add a method to update live vote progress
    private async updateLiveVoteProgress(targetId: string, currentCount: number, requiredCount: string) {
        // Optional: You could add logic here to edit the original live vote message 
        // with progress updates if needed
        console.log(`[DEBUG] Vote progress: ${currentCount}/${requiredCount} for target ${targetId}`);
    }

    // Add helper method to check time since last update
    private hoursSinceLastUpdate(): number {
        if (this._lastUpdateTime === 0) return 999; // If never updated, return a large number
        const hoursDiff = (Date.now() - this._lastUpdateTime) / (1000 * 60 * 60);
        return Math.round(hoursDiff * 10) / 10; // Round to 1 decimal place
    }

    // Add a debug log helper method
    private debugLog(message: string) {
        if (this.debugMode) {
            console.log(`[DEBUG] ${message}`);
        }
    }

    // Helper method to check if there are any votes
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

    // Add a method to clean up old processed votes to prevent memory issues
    private cleanupOldVoteSessions() {
        const currentDate = new Date();
        const currentDateStr = currentDate.toISOString().split('T')[0];
        
        // Clean up processedVotes
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
        
        // Clean up processedLiveVotes
        const liveVotesToRemove: string[] = [];
        this.processedLiveVotes.forEach(voteId => {
            const datePart = voteId.split('-')[0];
            if (datePart !== currentDateStr) {
                liveVotesToRemove.push(voteId);
            }
        });
        
        if (liveVotesToRemove.length > 0) {
            this.debugLog(`Cleaning up ${liveVotesToRemove.length} old processed live votes`);
            liveVotesToRemove.forEach(voteId => this.processedLiveVotes.delete(voteId));
        }
    }

    // Add a synchronous version of console log processing to use when we need player ID mappings immediately
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
                        
                        // Update player ID to GUID mapping
                        this.playerIdToGuid.set(id, beGuid);
                        
                        // Add or update player in daily map
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

// Create current log directory path if it doesn't exist
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
        console.log('[INFO] Starting log parser');
        console.log(`[INFO] Using current log directory: ${CURRENT_LOG_DIRECTORY}`);
        console.log(`[INFO] Using historical log directory: ${HISTORICAL_LOG_DIRECTORY}`);
        
        const parser = new LogParser(
            DISCORD_TOKEN, 
            DAILY_CHANNEL_ID, 
            HISTORICAL_CHANNEL_ID, 
            LIVE_VOTE_CHANNEL_ID, 
            CURRENT_LOG_DIRECTORY,
            HISTORICAL_LOG_DIRECTORY
        );
        // Don't call startWatching here since it's now called from the Discord ready event
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