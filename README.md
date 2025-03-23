# Reforger Log Parser

This TypeScript application monitors Reforger server logs to track vote kick approvals and sends the information to a Discord channel.

## Features

- Monitors `console.log` for player connections
- Monitors `script.log` for vote kick approvals
- Matches player IDs with player names
- Sends vote kick approval notifications to Discord

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with the following variables:
```
DISCORD_TOKEN=your_discord_bot_token
CHANNEL_ID=your_discord_channel_id
LOG_DIRECTORY=path_to_your_logs_directory
```

3. Build the project:
```bash
npm run build
```

4. Start the application:
```bash
npm start
```

## Development

To run the application in development mode:
```bash
npm run dev
```

## Discord Bot Setup

1. Create a new Discord application at https://discord.com/developers/applications
2. Create a bot for your application
3. Copy the bot token and add it to your `.env` file
4. Invite the bot to your server with the necessary permissions
5. Get the channel ID where you want the notifications to appear (right-click the channel and copy ID)

## Log Format Examples

The parser expects the following log formats:

### console.log
```
16:56:21.600  DEFAULT      : BattlEye Server: 'Player #296 Nicky_076W - BE GUID: 039d1b495a44a3c4800aa91703c3394f'
```

### script.log
```
21:08:23.312   SCRIPT       : Player '296' approved vote | Vote Type: 'KICK' | Vote value: '-1' | Count (16/18)
``` 