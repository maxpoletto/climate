#!/usr/bin/env python3
"""
Swiss energy data importer

Downloads and processes data about energy facilities and historical production
from the Swiss Federal Office of Energy and outputs compressed JSON files for
the web app.

Basic usage:
    python import_data.py --dest_root .

Downloaded files are stored in /tmp/ch-energy/downloads.

Output files:
- $DEST_ROOT/data/facilities.json.gz (facilities with GPS coordinates and essential fields only)
- $DEST_ROOT/data/production.json.gz (historical production data)
- $DEST_ROOT/data/trade.json.gz (trade data)
"""

import argparse
import csv
import gzip
import json
import logging
import os
import shutil
import sys
import tempfile
import time
import zipfile
from collections import defaultdict
from datetime import datetime

from pyproj import Transformer
import requests

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    stream=sys.stdout
)
logger = logging.getLogger(__name__)

FACILITIES_URL = "https://data.geo.admin.ch/ch.bfe.elektrizitaetsproduktionsanlagen/csv/2056/ch.bfe.elektrizitaetsproduktionsanlagen.zip"  # noqa: E501
PRODUCTION_URL = "https://www.uvek-gis.admin.ch/BFE/ogd/104/ogd104_stromproduktion_swissgrid.csv"  # noqa
TRADE_URL = "https://www.uvek-gis.admin.ch/BFE/ogd/107/ogd107_strom_import_export.csv"  # noqa
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

# Position of trade flows in output array
TRADE_FLOW_INDEX = {
    'AT_CH_MWh': 0,      # Austria to Switzerland
    'DE_CH_MWh': 1,      # Germany to Switzerland
    'FR_CH_MWh': 2,      # France to Switzerland
    'IT_CH_MWh': 3,      # Italy to Switzerland
    'CH_AT_MWh': 4,      # Switzerland to Austria
    'CH_DE_MWh': 5,      # Switzerland to Germany
    'CH_FR_MWh': 6,      # Switzerland to France
    'CH_IT_MWh': 7       # Switzerland to Italy
}

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

class Geocoder:
    """
    Geocoder using Nominatim (https://nominatim.org/) with caching.
    """

    def __init__(self, cache_file : str):
        self.cache_file = cache_file
        self.cache = {}
        self.load()
        self.num_requests = 0
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Swiss Energy Explorer (https://maxp.net/ch-energy, contact: maxp@maxp.net)'
        })

    def load(self):
        """Load the geocoding cache from file."""
        self.cache = {}
        if not os.path.exists(self.cache_file):
            return
        with open(self.cache_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                parts = line.split('\t')
                if len(parts) != 3:
                    raise ValueError(f"Invalid cache entry: {line}")
                query_hash = parts[0]
                lat = float(parts[1]) if parts[1] != 'None' else None
                lon = float(parts[2]) if parts[2] != 'None' else None
                self.cache[query_hash] = (lat, lon)
        logger.info("Loaded %d entries from geocoding cache", len(self.cache))

    def save(self):
        """Save the geocoding cache to file."""
        with open(self.cache_file, 'w', encoding='utf-8') as f:
            for query_hash, (lat, lon) in self.cache.items():
                lat_str = str(lat) if lat is not None else 'None'
                lon_str = str(lon) if lon is not None else 'None'
                f.write(f"{query_hash}\t{lat_str}\t{lon_str}\n")
        logger.info("Saved %d entries to geocoding cache", len(self.cache))

    def geocode(self, address_parts : dict[str, str]) -> tuple[float, float] | None:
        """
        address_parts is a dict with keys 'Address', 'PostCode', 'Municipality'.
        Returns (lat, lon) tuple or (None, None) if not found.
        """
        cache_key ='|'.join([ str(address_parts[f]).strip().replace('\t', ' ').replace('|', ' ') for f in ['Address', 'PostCode', 'Municipality']])
        if cache_key in self.cache:
            return self.cache[cache_key]

        # Use Nominatim API
        url = "https://nominatim.openstreetmap.org/search"
        params = {
            'street': address_parts['Address'],
            'postcode': address_parts['PostCode'],
            'city': address_parts['Municipality'],
            'format': 'jsonv2',
            'limit': 1,
            'countrycodes': 'ch',  # Limit to Switzerland
            'addressdetails': 0
        }

        response = self.session.get(url, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()
        self.num_requests += 1
        time.sleep(1.5) # Rate limiting (https://operations.osmfoundation.org/policies/nominatim/)

        if data and len(data) > 0 and 'lat' in data[0] and 'lon' in data[0]:
            lat, lon = float(data[0]['lat']), float(data[0]['lon'])
            logger.debug("Geocoded '%s' -> (%.6f, %.6f)", cache_key, lat, lon)
        else:
            lat, lon = None, None
            logger.debug("No geocoding result for '%s'", cache_key)

        self.cache[cache_key] = (lat, lon)

        if self.num_requests % 100 == 0:
            logger.info("Geocoded %d addresses", self.num_requests)
            self.save()

        return lat, lon

def ensure_directories(dest_root : str):
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

def download_csv(url: str, data_type: str) -> str:
    """Download CSV data from URL."""
    logger.info("Downloading %s data from %s", data_type, url)

    try:
        response = requests.get(url, timeout=60)
        response.raise_for_status()

        timestamp = datetime.now().strftime("%Y%m%d") # Data changes at most once a day.
        csv_filename = os.path.join(DOWNLOAD_PATH, f"{data_type}_{timestamp}.csv")
        with open(csv_filename, 'w', encoding='utf-8') as f:
            f.write(response.text)

        return response.text

    except requests.RequestException as e:
        logger.error("Download failed: %s", e)
        raise(e)

def load_catalogue_translations(extract_dir : str) -> dict[str, str]:
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

        with open(filepath, 'r', encoding='utf-8') as f:
            csvreader = csv.reader(f)
            for row in csvreader:
                if not row or row[0].startswith('Catalogue'):
                    continue
                code, *translations_list = row
                # Use the last (English) translation
                translations[code] = translations_list[-1].strip()
    return translations

def import_facilities(csv_path : str, geocoder : Geocoder) -> list[dict]:
    """Import facilities data from CSV file."""
    extract_dir = os.path.dirname(csv_path)
    translations = load_catalogue_translations(extract_dir)

    logger.info("Importing facilities data...")

    # Coordinate transformer from Swiss LV95 to WGS84
    transformer = Transformer.from_crs("EPSG:2056", "EPSG:4326")

    facilities = []
    facilities_with_coords = 0
    geocoded_facilities = 0

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
                    # Check whether data contains coordinates (LV95) already
                    isinstance(values[-2], (int, float)) and isinstance(values[-1], (int, float))):
                    lat, lon = transformer.transform(values[-2], values[-1])
                    values += [lat, lon]
                    facilities_with_coords += 1
                else:
                    # Try geocoding using address fields
                    fields = dict(zip(keys[:-2], values)) # Last two keys are lat/lon

                    address_parts = {}
                    for field in ['Address', 'PostCode', 'Municipality']:
                        if field in fields and fields[field]:
                            address_parts[field] = fields[field]

                    if address_parts and address_parts['Address'] and address_parts['PostCode'] and address_parts['Municipality']:
                        lat, lon = geocoder.geocode(address_parts)
                        if lat is not None and lon is not None:
                            geocoded_facilities += 1
                            facilities_with_coords += 1
                    else:
                        lat, lon = None, None

                    values += [lat, lon]

                all_fields = dict(zip(keys, values))
                facility = {field: all_fields[field] for field in REQUIRED_FIELDS if field in all_fields}
                facilities.append(facility)
            except Exception as e:
                logger.warning("Error processing facility row %d: %s", i, e)
                continue

    # Save the updated geocoding cache
    geocoder.save()

    logger.info("Processed %d facilities, %d with GPS coordinates (%d from data, %d geocoded)",
                len(facilities), facilities_with_coords, facilities_with_coords - geocoded_facilities, geocoded_facilities)
    return facilities

def import_production(csv_content : str) -> list[dict]:
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

def import_trade(csv_content: str) -> list[dict]:
    """Import trade data from CSV file."""
    logger.info("Importing trade data...")

    result = []
    processed_rows = 0
    csv_reader = csv.DictReader(csv_content.splitlines())

    for row in csv_reader:
        try:
            datetime_str = row['Datetime']

            # Create trade flows array in the specified order
            trade_flows = [0.0] * 8
            for field, index in TRADE_FLOW_INDEX.items():
                if field in row:
                    trade_flows[index] = float(row[field])

            result.append({
                'date': datetime_str,
                'trade': trade_flows
            })
            processed_rows += 1

        except (KeyError, ValueError) as e:
            logger.warning("Error processing trade row: %s: %s", row, e)
            continue

    logger.info("Processed %s trade data points", processed_rows)
    return result

def save_compressed_json(data : list[dict], output_file : str):
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
        os.chmod(temp_path, 0o644)
        shutil.move(temp_path, output_file)
        temp_path = None  # Successfully moved, don't clean up

        file_size = os.path.getsize(output_file)
        logger.info("Saved %s records to %s (%s bytes)", len(data), output_file, file_size)

    except Exception as e:
        logger.error("Error saving data to %s: %s", output_file, e)
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)
        raise e

def print_summary(facilities_data : list[dict], production_data : list[dict], trade_data : list[dict] = None):
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

    if trade_data:
        start_date = trade_data[0]['date']
        end_date = trade_data[-1]['date']

        print("\nTrade Data:")
        print(f"  Date range: {start_date} to {end_date}")
        print(f"  Total hours: {len(trade_data):,}")

def main():
    parser = argparse.ArgumentParser(description='Import Swiss energy facilities and production data')
    parser.add_argument('--dest_root', default='.', help='Root directory for output files')
    parser.add_argument('--geocode-cache', default='geocode-cache.txt', help='Geocode cache file')
    parser.add_argument('--summary', action='store_true', help='Show data summary after processing')
    parser.add_argument('--facilities-only', action='store_true', help='Only process facilities data')
    parser.add_argument('--production-only', action='store_true', help='Only process production data')
    parser.add_argument('--trade-only', action='store_true', help='Only process trade data')
    args = parser.parse_args()

    ensure_directories(args.dest_root)

    facilities_data = []
    production_data = []
    trade_data = []

    # Import facilities data
    if not args.production_only and not args.trade_only:
        csv_path = download_facilities()
        facilities_data = import_facilities(csv_path, Geocoder(args.geocode_cache))

        if facilities_data:
            save_compressed_json(
                facilities_data,
                os.path.join(args.dest_root, 'data', 'facilities.json.gz'),
            )

    # Import production data
    if not args.facilities_only and not args.trade_only:
        csv_content = download_csv(PRODUCTION_URL, "production")
        production_data = import_production(csv_content)

        if production_data:
            save_compressed_json(
                production_data,
                os.path.join(args.dest_root, 'data', 'production.json.gz'),
            )

    # Import trade data
    if not args.facilities_only and not args.production_only:
        csv_content = download_csv(TRADE_URL, "trade")
        trade_data = import_trade(csv_content)

        if trade_data:
            save_compressed_json(
                trade_data,
                os.path.join(args.dest_root, 'data', 'trade.json.gz'),
            )

    if args.summary:
        print_summary(facilities_data, production_data, trade_data)

    # Write last update timestamp
    last_update_file = os.path.join(args.dest_root, 'data', 'last-update.txt')
    os.makedirs(os.path.dirname(last_update_file), exist_ok=True)
    with open(last_update_file, 'w') as f:
        f.write(datetime.now().strftime('%Y-%m-%d'))
    logger.info("Wrote last update timestamp to %s", last_update_file)

    logger.info("Import completed successfully")
    return 0

if __name__ == "__main__":
    exit(main())
