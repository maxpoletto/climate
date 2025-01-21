import json
from pyproj import Transformer

translations = {}
transformer = Transformer.from_crs("EPSG:2056", "EPSG:4326")

for file in ["MainCategoryCatalogue.csv", "OrientationCatalogue.csv",
             "PlantCategoryCatalogue.csv", "SubCategoryCatalogue.csv"]:
    with open(file, "r", encoding='utf8') as f:
        for l in f:
            if l.startswith('Catalogue'):
                continue
            code, *translations_list = l.strip().split(',')
            translations[code] = translations_list[-1]

res, keys, values = [], [], []
with open("ElectricityProductionPlant.csv", encoding='utf8') as f:
    for l in f:
        if 'xtf_id' in l:
            keys = l.strip().split(',')
            keys += ['lat', 'lon']
            continue
        values = l.strip().split(',')
        for i, value in enumerate(values):
            if value in translations:
                values[i] = translations[value]
            elif value.replace('.', '').isdigit():
                values[i] = float(value) if '.' in value else int(value)
        if isinstance(values[-2], int) and isinstance(values[-1], int):
            values += transformer.transform(values[-2], values[-1])
        else:
            values += [None, None]
        res.append(dict(zip(keys, values)))

with open("ElectricityProductionPlant.json", "w", encoding="utf-8") as f:
    json.dump(res, f, indent=2, ensure_ascii=False)
