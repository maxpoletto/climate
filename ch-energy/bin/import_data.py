#!/usr/bin/env python3
"""
Swiss energy data importer

Downloads and processes data about energy facilities and historical production
from the Swiss Federal Office of Energy and outputs compressed JSON files for
the web app.

Basic usage:
    python import_production_data.py --dest_root .

Downloaded files are stored in /tmp/ch-energy/downloads.

Output files:
- $DEST_ROOT/data/facilities.json.gz (facilities with GPS coordinates and essential fields only)
- $DEST_ROOT/data/production.json.gz (historical production data)
"""

import os
import json
import gzip
import csv
import requests
import tempfile
import shutil
import zipfile
from datetime import datetime
from collections import defaultdict
import argparse
import logging
import sys
from pyproj import Transformer

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    stream=sys.stdout
)
logger = logging.getLogger(__name__)

FACILITIES_URL = "https://data.geo.admin.ch/ch.bfe.elektrizitaetsproduktionsanlagen/csv/2056/ch.bfe.elektrizitaetsproduktionsanlagen.zip"  # noqa: E501
PRODUCTION_URL = "https://www.uvek-gis.admin.ch/BFE/ogd/104/ogd104_stromproduktion_swissgrid.csv"  # noqa
DOWNLOAD_PATH = "/tmp/ch-energy/downloads"

# Position of energy source in output array (input file is in German)
PRODUCTION_SOURCE_INDEX = {
    'Speicherkraft': 0,      # Hydro (pumped storage)
    'Flusskraft': 1,         # Hydro (river/run-of-river)
    'Kernkraft': 2,          # Nuclear
    'Photovoltaik': 3,       # Photovoltaic
    'Thermische': 4,         # Thermal
    'Wind': 5                # Wind
}

PRODUCTION_SOURCE_NAMES = [
    'Hydro (pumped)',
    'Hydro (river)',
    'Nuclear',
    'Photovoltaic',
    'Thermal',
    'Wind'
]

# Fields to keep from facilities data
REQUIRED_FIELDS = [
    "Municipality",
    "Canton",
    "BeginningOfOperation",
    "TotalPower",
    "SubCategory",
    "lat",
    "lon"
]

def ensure_directories(dest_root):
    """Create necessary directories if they don't exist."""
    os.makedirs(DOWNLOAD_PATH, exist_ok=True)
    os.makedirs(os.path.join(dest_root, "data"), exist_ok=True)

def download_facilities():
    """Download and extract facilities data."""
    logger.info("Downloading facilities data from %s", FACILITIES_URL)

    try:
        response = requests.get(FACILITIES_URL, timeout=120)
        response.raise_for_status()

        zip_path = os.path.join(DOWNLOAD_PATH, "facilities.zip")
        with open(zip_path, 'wb') as f:
            f.write(response.content)

        extract_dir = os.path.join(DOWNLOAD_PATH, "facilities")
        os.makedirs(extract_dir, exist_ok=True)
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(extract_dir)

        csv_path = os.path.join(extract_dir, "ElectricityProductionPlant.csv")
        if not os.path.exists(csv_path):
            raise FileNotFoundError("ElectricityProductionPlant.csv not found in extracted files")

        return csv_path

    except requests.RequestException as e:
        logger.error("Failed to download facilities data: %s", e)
        raise
    except zipfile.BadZipFile as e:
        logger.error("Failed to extract ZIP file: %s", e)
        raise

def download_production():
    """Download historical production data."""
    logger.info("Downloading production data from %s", PRODUCTION_URL)

    try:
        response = requests.get(PRODUCTION_URL, timeout=60)
        response.raise_for_status()

        timestamp = datetime.now().strftime("%Y%m%d") # Data changes at most once a day.
        csv_filename = os.path.join(DOWNLOAD_PATH, f"production_{timestamp}.csv")
        with open(csv_filename, 'w', encoding='utf-8') as f:
            f.write(response.text)

        return response.text

    except requests.RequestException as e:
        logger.error("Download failed: %s", e)
        raise(e)

def load_catalogue_translations(extract_dir):
    """Load translation dictionaries from 'catalogue' CSV files."""
    logger.info("Loading translation dictionaries from catalogs...")
    translations = {}

    catalogue_files = [
        "MainCategoryCatalogue.csv",
        "OrientationCatalogue.csv",
        "PlantCategoryCatalogue.csv",
        "SubCategoryCatalogue.csv"
    ]

    for filename in catalogue_files:
        filepath = os.path.join(extract_dir, filename)
        if not os.path.exists(filepath):
            logger.warning("Catalogue file not found: %s", filepath)
            continue

        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                csvreader = csv.reader(f)
                for row in csvreader:
                    if not row or row[0].startswith('Catalogue'):
                        continue
                    code, *translations_list = row
                    # Use the last (English) translation
                    translations[code] = translations_list[-1].strip()
        except Exception as e:
            logger.warning("Error reading catalogue file %s: %s", filename, e)
    return translations

def import_facilities(csv_path):
    """Import facilities data from CSV file."""
    logger.info("Importing facilities data...")

    extract_dir = os.path.dirname(csv_path)
    translations = load_catalogue_translations(extract_dir)

    # Coordinate transformer from Swiss LV95 to WGS84
    transformer = Transformer.from_crs("EPSG:2056", "EPSG:4326")

    facilities = []
    facilities_with_coords = 0

    try:
        with open(csv_path, 'r', encoding='utf-8') as f:
            csvreader = csv.reader(f)
            keys = None

            for i, row in enumerate(csvreader):
                # First row with 'xtf_id' contains the column headers
                if 'xtf_id' in row[0]:
                    keys = row + ['lat', 'lon']
                    continue
                if keys is None:
                    raise Exception("No keys found in facilities data")

                try:
                    values = []
                    for value in row:
                        if value in translations:
                            values.append(translations[value])
                        elif value.replace('.', '').isdigit():
                            values.append(float(value) if '.' in value else int(value))
                        else:
                            values.append(value)

                    if (len(values) >= 2 and
                        isinstance(values[-2], (int, float)) and isinstance(values[-1], (int, float))):
                        lat, lon = transformer.transform(values[-2], values[-1])
                        values += [lat, lon]
                        facilities_with_coords += 1
                    else:
                        values += [None, None]

                    all_fields = dict(zip(keys, values))
                    facility = {field: all_fields[field] for field in REQUIRED_FIELDS if field in all_fields}
                    facilities.append(facility)
                except Exception as e:
                    logger.warning("Error processing facility row %d: %s", i, e)
                    continue

        logger.info("Processed %d facilities, %d with GPS coordinates", len(facilities), facilities_with_coords)
        return facilities

    except Exception as e:
        logger.error("Error reading facilities CSV: %s", e)
        raise

def import_production(csv_content):
    """Import production data from CSV file."""
    logger.info("Importing production data...")

    # Group data by date
    daily_data = defaultdict(lambda: [0.0] * 6)
    processed_rows = 0
    csv_reader = csv.DictReader(csv_content.splitlines())
    for row in csv_reader:
        try:
            date = row['Datum']  # Format: YYYY-MM-DD
            energy_source = row['Energietraeger']
            production_gwh = float(row['Produktion_GWh'])

            if energy_source in PRODUCTION_SOURCE_INDEX:
                source_index = PRODUCTION_SOURCE_INDEX[energy_source]
                daily_data[date][source_index] = production_gwh
                processed_rows += 1
            else:
                logger.warning("Unknown energy source: %s", energy_source)

        except (KeyError, ValueError) as e:
            logger.warning("Error processing production row: %s: %s", row, e)
            continue

    logger.info("Processed %s data points", processed_rows)

    result = []
    for date in sorted(daily_data.keys()):
        result.append({
            'date': date,
            'prod': daily_data[date]
        })

    logger.info("Generated data for %s days", len(result))
    return result

def save_compressed_json(data, output_file, description):
    """Save data as compressed JSON using atomic write."""
    json_str = json.dumps(data, separators=(',', ':'))
    output_dir = os.path.dirname(output_file)
    temp_path = None

    try:
        fd, temp_path = tempfile.mkstemp(
            dir=output_dir,
            prefix='.prod_temp_',
            suffix='.json.gz'
        )
        os.close(fd)

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

def print_summary(facilities_data, production_data):
    """Print summary statistics."""
    print("\nData Import Summary:")

    if facilities_data:
        facilities_with_coords = len([f for f in facilities_data if f.get('lat') and f.get('lon')])
        total_power = sum(f.get('TotalPower', 0) for f in facilities_data) / 1000  # Convert to MW

        print("Facilities:")
        print(f"  Total facilities: {len(facilities_data):,}")
        print(f"  With GPS coordinates: {facilities_with_coords:,}")
        print(f"  Total capacity: {total_power:.1f} MW")

        # Total by energy source
        sources = defaultdict(int)
        for f in facilities_data:
            sources[f.get('SubCategory', 'Unknown')] += 1

        print("  Number of facilities by energy source:")
        for source, count in sorted(sources.items(), key=lambda x: x[0]):
            print(f"    {source}: {count:,}")

    if production_data:
        start_date = production_data[0]['date']
        end_date = production_data[-1]['date']

        # Totals by energy source
        totals = [0.0] * 6
        for record in production_data:
            for i, val in enumerate(record['prod']):
                totals[i] += val

        print("\nProduction Data:")
        print(f"  Date range: {start_date} to {end_date}")
        print(f"  Total days: {len(production_data):,}")
        print("  Total production by source (GWh):")

        for i, (name, total) in enumerate(zip(PRODUCTION_SOURCE_NAMES, totals)):
            print(f"    {name}: {total:.1f} GWh")

def main():
    parser = argparse.ArgumentParser(description='Import Swiss energy facilities and production data')
    parser.add_argument('--dest_root', default='.', help='Root directory for output files')
    parser.add_argument('--summary', action='store_true', help='Show data summary after processing')
    parser.add_argument('--facilities-only', action='store_true', help='Only process facilities data')
    parser.add_argument('--production-only', action='store_true', help='Only process production data')
    args = parser.parse_args()

    try:
        ensure_directories(args.dest_root)

        facilities_data = []
        production_data = []

        # Import facilities data
        if not args.production_only:
            csv_path = download_facilities()
            facilities_data = import_facilities(csv_path)

            if facilities_data:
                save_compressed_json(
                    facilities_data,
                    os.path.join(args.dest_root, 'data', 'facilities.json.gz'),
                    'facilities data'
                )

        # Import production data
        if not args.facilities_only:
            csv_content = download_production()
            production_data = import_production(csv_content)

            if production_data:
                save_compressed_json(
                    production_data,
                    os.path.join(args.dest_root, 'data', 'production.json.gz'),
                    'production data'
                )

        if args.summary:
            print_summary(facilities_data, production_data)

        logger.info("Import completed successfully")
        return 0

    except Exception as e:
        logger.error("Error during import: %s", e)
        return 1

if __name__ == "__main__":
    exit(main())
