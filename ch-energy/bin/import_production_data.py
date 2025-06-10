#!/usr/bin/env python3
"""
Downloads daily energy production data from the Swiss Federal Office of Energy,
processes it into JSON format, and saves it compressed.

Data source: https://www.uvek-gis.admin.ch/BFE/ogd/104/ogd104_stromproduktion_swissgrid.csv
"""

import os
import json
import gzip
import csv
import requests
import tempfile
import shutil
from datetime import datetime, timedelta
from collections import defaultdict
import argparse
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    stream=sys.stdout
)
logger = logging.getLogger(__name__)

DATA_URL = "https://www.uvek-gis.admin.ch/BFE/ogd/104/ogd104_stromproduktion_swissgrid.csv"

# Position of energy source in output array (input file is in German)
ENERGY_SOURCE_INDEX = {
    'Speicherkraft': 0,      # Hydro (pumped storage)
    'Flusskraft': 1,         # Hydro (river/run-of-river)
    'Kernkraft': 2,          # Nuclear
    'Photovoltaik': 3,       # Photovoltaic
    'Thermische': 4,         # Thermal
    'Wind': 5                # Wind
}

ENERGY_SOURCE_NAMES = [
    'Hydro (pumped)',
    'Hydro (river)',
    'Nuclear',
    'Photovoltaic',
    'Thermal',
    'Wind'
]

def ensure_directories(dest_root):
    """Create necessary directories if they don't exist."""
    os.makedirs(os.path.join(dest_root, 'downloads'), exist_ok=True)
    os.makedirs(os.path.join(dest_root, 'data'), exist_ok=True)

def download_csv(dest_root):
    """Download the CSV file from the Swiss Federal Office of Energy."""
    logger.info("Downloading production data from %s", DATA_URL)

    try:
        response = requests.get(DATA_URL, timeout=60)
        response.raise_for_status()

        today = datetime.now().strftime("%Y%m%d") # Data changes at most once a day
        csv_filename = os.path.join(dest_root, 'downloads', f"prod_{today}.csv")
        with open(csv_filename, 'w', encoding='utf-8') as f:
            f.write(response.text)
        return response.text

    except requests.RequestException as e:
        logger.error("Download failed: %s", e)
        raise(e)

def parse_csv(csv_content):
    """Parse CSV content and convert to structured data."""
    # Group data by date
    daily_data = defaultdict(lambda: [0.0] * 6)  # 6 energy sources

    csv_reader = csv.DictReader(csv_content.splitlines())
    processed_rows = 0
    for row in csv_reader:
        try:
            date = row['Datum']  # Format: YYYY-MM-DD
            energy_source = row['Energietraeger']
            production_gwh = float(row['Produktion_GWh'])

            # Map energy source to array index
            if energy_source in ENERGY_SOURCE_INDEX:
                index = ENERGY_SOURCE_INDEX[energy_source]
                daily_data[date][index] = production_gwh
                processed_rows += 1
            else:
                logger.warning("Unknown energy source while parsing CSV: %s", energy_source)

        except (KeyError, ValueError) as e:
            logger.warning("Error processing row while parsing CSV: %s: %s", row, e)
            continue

    logger.info("Processed %s data points", processed_rows)

    # Convert to list of dictionaries sorted by date
    result = []
    for date in sorted(daily_data.keys()):
        result.append({
            'date': date,
            'prod': daily_data[date]
        })

    logger.info("Generated data for %s days", len(result))
    return result

def save_json(data, dest_root):
    """Save data as compressed JSON using atomic write."""
    output_dir = os.path.join(dest_root, 'data')
    output_file = os.path.join(output_dir, 'prod.json.gz')
    json_str = json.dumps(data, separators=(',', ':')) # Compact JSON
    temp_path = None

    try:
        # Create temp file in same directory as output
        fd, temp_path = tempfile.mkstemp(
            dir=output_dir,
            prefix='.prod_temp_',
            suffix='.json.gz'
        )
        os.close(fd)

        # Write compressed JSON to temp file
        with gzip.open(temp_path, 'wt', encoding='utf-8') as gz_file:
            gz_file.write(json_str)

        shutil.move(temp_path, output_file)
        temp_path = None  # Successfully moved, don't clean up

        file_size = os.path.getsize(output_file)
        logger.info("Saved %s records to %s (%s bytes)", len(data), output_file, file_size)

    except Exception as e:
        logger.error("Error saving data to %s: %s", output_file, e)
        if temp_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except Exception:
                pass
        raise e

def print_sample(data, num_samples=5):
    """Print sample data for verification."""
    logger.info("Sample of first %s records:", min(num_samples, len(data)))

    print("\nDate       | " + " | ".join(f"{name:>8s}" for name in ENERGY_SOURCE_NAMES))
    print("-" * 80)
    for record in data[:num_samples]:
        date = record['date']
        prod = record['prod']
        prod_str = " | ".join(f"{val:8.1f}" for val in prod)
        print(f"{date} | {prod_str}")

    if len(data) > num_samples:
        print(f"... and {len(data) - num_samples} more records")

def print_summary(data):
    """Print summary statistics."""
    if not data:
        return "No data available"

    start_date = data[0]['date']
    end_date = data[-1]['date']

    # Calculate totals by energy source
    totals = [0.0] * 6
    for record in data:
        for i, val in enumerate(record['prod']):
            totals[i] += val

    print("Data Summary:")
    print(f"Date range: {start_date} to {end_date}")
    print(f"Total days: {len(data)}")

    for i, (name, total) in enumerate(zip(ENERGY_SOURCE_NAMES, totals)):
        print(f"  {name}: {total:,.1f} GWh")

def main():
    parser = argparse.ArgumentParser(
        description='Download and process Swiss historical energy production data')
    parser.add_argument('--dest_root', default='.', help='Root directory for output files')
    parser.add_argument('--sample', action='store_true', help='Show sample data after processing')
    parser.add_argument('--summary', action='store_true', help='Show data summary')
    args = parser.parse_args()

    try:
        ensure_directories(args.dest_root)

        csv_content = download_csv(args.dest_root)

        # Parse and structure the data
        structured_data = parse_csv(csv_content)

        if not structured_data:
            logger.error("No valid data found in CSV file")
            return 1

        save_json(structured_data, args.dest_root)

        if args.sample:
            print_sample(structured_data)
        if args.summary:
            print_summary(structured_data)

        logger.info("Import completed successfully")
        return 0

    except Exception as e:
        logger.error("Error during import: %s", e)
        return 1

if __name__ == "__main__":
    exit(main())
