# Reforger Log Parser

A Discord bot that monitors and displays votekick statistics from Arma Reforger server logs.

## Features

- Real-time votekick monitoring
- Daily votekick statistics
- Historical votekick summary (last 14 days)
- Live vote session tracking
- Multi-language support (English and Dutch included)
- Customizable server title

## Configuration

The bot can be configured using environment variables and a config file:

### Required Environment Variables

- `DISCORD_TOKEN`: Your Discord bot token
- `DAILY_CHANNEL_ID`: Discord channel ID for daily statistics
- `HISTORICAL_CHANNEL_ID`: Discord channel ID for historical statistics
- `LIVE_VOTE_CHANNEL_ID`: Discord channel ID for live vote notifications
- `LOG_DIRECTORY`: Base directory for log files (default: `/srv/armareforger/u4lj4wmjvv`)

### Optional Environment Variables

- `LANGUAGE`: Language for messages (`en` for English, `nl` for Dutch, default: `en`)
- `DEBUG_MODE`: Enable debug logging (`true` or `false`, default: `true`)

### Server Configuration

The server title can be customized in `config.json`:

```json
{
    "serverTitle": "YOUR SERVER NAME"
}
```

### Log Directory Structure

The bot expects the following directory structure:
```
LOG_DIRECTORY/
├── logs/                    # Historical logs
│   └── YYYY-MM-DD_HH-MM-SS/
│       ├── console.log
│       └── script.log
└── logs.current/           # Current logs
    ├── console.log
    └── script.log
```

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the example environment file and configure your settings:
   ```bash
   cp .env.example .env
   ```
4. Edit `config.json` to set your server title
5. Build the project:
   ```bash
   npm run build
   ```
6. Start the bot:
   ```bash
   npm start
   ```

## Development

The project is written in TypeScript and uses:
- Node.js
- Discord.js
- Chokidar for file watching
- dotenv for environment variables

To run in development mode:
```bash
npm run dev
```

## License

MIT License 