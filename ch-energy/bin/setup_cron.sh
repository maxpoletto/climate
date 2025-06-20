#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CRON_COMMAND="0 2 * * 0 cd $PROJECT_DIR && make import > /tmp/ch-energy-import.log 2>&1"

# Check if the cron job already exists
if crontab -l 2>/dev/null | grep -q "$PROJECT_DIR.*make import"; then
    echo "Cron job already exists. Skipping setup."
    echo "Current cron entries for this job:"
    crontab -l 2>/dev/null | grep "$PROJECT_DIR.*make import" || true
    exit 0
fi

# Create temporary file with current crontab
TEMP_CRON=$(mktemp)
crontab -l 2>/dev/null > "$TEMP_CRON" || true

# Add the new cron job
echo "$CRON_COMMAND" >> "$TEMP_CRON"

# Install the new crontab
crontab "$TEMP_CRON"

# Clean up
rm "$TEMP_CRON"

echo "Weekly cron job installed successfully!"
crontab -l
