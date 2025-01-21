import csv
import json
import os.path
from pyproj import Transformer
import sys

translations = {}
transformer = Transformer.from_crs("EPSG:2056", "EPSG:4326")

# Converts CSV file data from https://opendata.swiss/en/dataset/elektrizitatsproduktionsanlagen
# to JSON format and adds lat/lon coordinates where possible.

path_prefix = sys.argv[1] if len(sys.argv) > 1 else ""

def filepath(filename): return os.path.join(path_prefix, filename) if path_prefix else filename

for file in ["MainCategoryCatalogue.csv", "OrientationCatalogue.csv",
             "PlantCategoryCatalogue.csv", "SubCategoryCatalogue.csv"]:
    with open(filepath(file), "r", encoding='utf8') as f:
        csvreader = csv.reader(f)
        for row in csvreader:
            if row[0].startswith('Catalogue'):
                continue
            code, *translations_list = row
            translations[code] = translations_list[-1].strip()

res, keys, values = [], [], []
with open(filepath("ElectricityProductionPlant.csv"), encoding='utf8') as f:
    csvreader = csv.reader(f)
    for i, row in enumerate(csvreader):
        if 'xtf_id' in row[0]:
            keys = row + ['lat', 'lon']
            continue
        values = []
        for value in row:
            if value in translations:
                values.append(translations[value])
            elif value.replace('.', '').isdigit():
                values.append(float(value) if '.' in value else int(value))
            else:
                values.append(value)
        if isinstance(values[-2], int) and isinstance(values[-1], int):
            values += transformer.transform(values[-2], values[-1])
        else:
            values += [None, None]
        res.append(dict(zip(keys, values)))

with open("ElectricityProductionPlant.json", "w", encoding="utf-8") as f:
    json.dump(res, f, indent=2, ensure_ascii=False)
