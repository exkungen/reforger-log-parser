#!/bin/bash

# Set Node.js memory limit higher than default
export NODE_OPTIONS="--max-old-space-size=8192 --expose-gc"

# Rebuild the TypeScript code
echo "Building TypeScript..."
npm run build

# Start the application with more memory
echo "Starting application with 8GB memory limit and exposed garbage collection..."
node --max-old-space-size=8192 --expose-gc dist/index.js

# If the process exits with an out of memory error (code 137), restart it
if [ $? -eq 137 ]; then
  echo "Application crashed with out-of-memory error. Restarting..."
  node --max-old-space-size=8192 --expose-gc dist/index.js
fi 