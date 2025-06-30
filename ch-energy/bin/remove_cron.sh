#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Check if the cron job exists
if ! crontab -l 2>/dev/null | grep -q "$PROJECT_DIR.*make import"; then
    echo "No cron job found for Swiss energy data import."
    exit 0
fi

# Create temporary file with current crontab, excluding our job
TEMP_CRON=$(mktemp)
crontab -l 2>/dev/null | grep -v "$PROJECT_DIR.*make import" > "$TEMP_CRON" || true

# Install the new crontab
crontab "$TEMP_CRON"

# Clean up
rm "$TEMP_CRON"

echo "Weekly cron job removed successfully!"
